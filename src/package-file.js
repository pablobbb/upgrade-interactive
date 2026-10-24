import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { discoverWorkspaces } from './workspaces.js';
import { overrideKeyName, overrideBucketsConflict, risksEoverride } from './override-keys.js';

/**
 * @import {
 *   AppliedUpgrade, ApplyResult, DependencyField, DependencyMap, Descriptor, Manifest,
 *   ManifestDescriptor, OverrideSpec, PackageJson, Project, ProjectAppliedUpgrade,
 *   ProjectManifest, WorkspaceInfo, WrittenOverride,
 * } from './types.js'
 */

const DEPENDENCY_FIELDS = /** @type {const} */ (['dependencies', 'devDependencies']);

/**
 * A `-w` value in the form `relPath` is stored in: backslashes folded to `/` and
 * any trailing slash dropped. Package names pass through untouched — a scoped
 * name's `/` is not a separator, and nothing else here alters one.
 *
 * @param {string} value
 */
function normalizeFilter(value) {
  const posix = value.split('\\').join('/');
  return posix.length > 1 ? posix.replace(/\/+$/, '') : posix;
}

/**
 * @param {string} cwd
 * @returns {Promise<Manifest>}
 */
export async function loadManifest(cwd) {
  const filePath = path.join(cwd, 'package.json');
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new Error(`No package.json found in ${cwd}`);
  }

  /** @type {PackageJson} */
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse package.json: ${/** @type {Error} */ (err).message}`);
  }

  const indentMatch = raw.match(/^[ \t]+/m);
  const indent = indentMatch ? indentMatch[0] : '  ';
  const trailingNewline = raw.endsWith('\n');

  /** @type {ManifestDescriptor[]} */
  const descriptors = [];
  for (const field of DEPENDENCY_FIELDS) {
    const section = json[field];
    if (!section || typeof section !== 'object') continue;
    for (const [name, range] of Object.entries(section)) {
      // `key` addresses exactly one (field, name) slot. A name can legitimately
      // appear in both dependencies and devDependencies, so it is not on its own
      // enough to route a selection to the right slot.
      descriptors.push({ name, range, field, key: `${field} ${name}` });
    }
  }

  descriptors.sort((a, b) => a.name.localeCompare(b.name));

  return { filePath, json, raw, indent, trailingNewline, descriptors };
}

/**
 * Load a whole project as an ordered list of manifests: the root first, then
 * each npm workspace (when the root declares a `workspaces` field). A standalone
 * package with no workspaces flows through this same shape — a one-manifest
 * project with `workspace: null` — so callers never branch on "is it a monorepo".
 *
 * Returns { root, manifests, descriptors, workspaces }:
 *   - `manifests`  — per-file loadManifest results, root first, each tagged with
 *     `workspace` (display name; null for the root) and `relPath`.
 *   - `descriptors` — the flat, cross-workspace row list. Every declared dep is
 *     its own descriptor (NOT deduped across workspaces): the same package in
 *     five workspaces yields five descriptors. Each gains `workspace`, `relPath`
 *     and a unique `id` (`${relPath} ${field} ${name}`) that maps 1:1 to exactly
 *     one (manifest, field, name). Ordering is root's alpha-sorted deps, then
 *     each workspace's, in project order.
 *   - `workspaces` — the discovered package list (root first) as *scoped by the
 *     options*: null when standalone or under `workspaces: false`. This is what
 *     drives display and writes.
 *   - `discovered` — the same list, but always the real tree regardless of
 *     `workspaces: false`, or null when there genuinely are no workspaces. The
 *     audit reads this: `--no-workspaces` narrows what the user edits, not what
 *     is installed, and mistaking a workspace for a `file:` dependency would
 *     silently disable the cross-manifest override conflict check.
 *
 * Descriptors whose `name` is itself a local workspace package (an internal
 * sibling dependency) are skipped — they aren't upgradable from the registry.
 *
 * Options:
 *   - `workspaces: false` — ignore any `workspaces` field and load only `cwd`'s
 *     own manifest (the `--no-workspaces` escape hatch, exact legacy behavior).
 *   - `filter: string[]` — limit the *displayed/editable* descriptors to
 *     workspaces whose package name or relPath matches one of these (npm's `-w`).
 *     Every manifest is still loaded (the root must stay writable for the
 *     root-only overrides), but only matched workspaces contribute rows.
 *     A path value is compared separator- and trailing-slash-insensitively, so
 *     `packages/api`, `packages\api` and `packages/api/` all select the same
 *     workspace — a user typing a path their shell just completed shouldn't have
 *     to know which form the tool stores internally.
 *
 * Throws when the options can't select anything: a `filter` value that matches
 * no package, or a `filter` combined with `workspaces: false`.
 *
 * @param {string} cwd
 * @param {{ workspaces?: boolean, filter?: string[] | null }} [options]
 * @returns {Promise<Project>}
 */
export async function loadProject(cwd, { workspaces = true, filter = null } = {}) {
  // Keyed by the normalized form, valued by what the user actually typed, so the
  // "no workspace matches" error can quote their input back rather than a
  // rewritten version of it.
  const filterSet = filter && filter.length > 0 ? new Map(filter.map((f) => [normalizeFilter(f), f])) : null;
  // `--no-workspaces` loads the root manifest alone, which no -w value can
  // select — silently showing an empty list would look like "nothing to
  // upgrade" rather than the contradiction it is.
  if (!workspaces && filterSet) {
    throw new Error('--no-workspaces cannot be combined with -w/--workspace');
  }

  // Discovery always runs, even under `--no-workspaces`. The flag scopes what is
  // *shown and written*; it does not change the shape of the installed tree, and
  // the audit needs the real shape to tell a workspace apart from a `file:`
  // dependency. `discovered` is that truth; `workspaces` is the display-scoped
  // view the flag nulls out.
  const tree = await discoverWorkspaces(cwd);
  const discovered = workspaces ? tree : null;
  const infos = discovered || [{ dir: cwd, name: null, relPath: '.' }];
  const workspaceNames = new Set((discovered || []).map((p) => p.name).filter(Boolean));
  // `relPath` is already POSIX (see expandWorkspaces) and a package name never
  // needs normalizing, so only the user's side of the comparison was rewritten.
  /** @param {WorkspaceInfo} info */
  const included = (info) =>
    !filterSet || (info.name != null && filterSet.has(info.name)) || filterSet.has(info.relPath);

  /** @type {ProjectManifest[]} */
  const manifests = [];
  /** @type {Descriptor[]} */
  const descriptors = [];
  /** @type {Set<string>} */
  const matched = new Set();
  for (const info of infos) {
    const manifest = Object.assign(await loadManifest(info.dir), {
      workspace: info.relPath === '.' ? null : info.name,
      relPath: info.relPath,
    });
    manifests.push(manifest);
    // A filtered-out workspace stays loaded (root overrides need it) but shows
    // no rows.
    if (!included(info)) continue;
    if (filterSet) {
      if (info.name != null && filterSet.has(info.name)) matched.add(info.name);
      if (filterSet.has(info.relPath)) matched.add(info.relPath);
    }
    for (const d of manifest.descriptors) {
      if (workspaceNames.has(d.name)) continue; // internal sibling dep — not upgradable
      descriptors.push({
        name: d.name,
        range: d.range,
        field: d.field,
        workspace: manifest.workspace,
        relPath: info.relPath,
        id: `${info.relPath} ${d.field} ${d.name}`,
      });
    }
  }

  // A -w value that matches no package name or path is a typo, not a request
  // for an empty list. Report every unmatched value at once so fixing one
  // doesn't just surface the next, and report it as the user typed it.
  if (filterSet) {
    const unmatched = [...filterSet].filter(([key]) => !matched.has(key)).map(([, typed]) => typed);
    if (unmatched.length > 0) {
      throw new Error(`No workspace matches: ${unmatched.join(', ')}`);
    }
  }

  return { root: manifests[0], manifests, descriptors, workspaces: discovered, discovered: tree };
}

// Write one override spec for `name` into the manifest `json`, pushing an
// {name,to,parent?} record onto `out` for each override actually changed. A spec
// is either a version string (a pin forcing every instance) or
// { scoped: [{ parentName, parentVersion, version }] } where each pin is nested
// under its parent package (parentName === null is a direct-dependency instance,
// i.e. the root project). A parent whose value is already a string override of
// the parent itself is preserved under the "." key when we add a child pin.
//
// Direct dependencies never get a top-level override: npm rejects an override
// for a package you directly depend on when it doesn't match the declared spec
// (EOVERRIDE, "conflicts with direct dependency"). So when `name` is a direct
// dependency (`directField` knows its field), we bump that dependency's range to
// the pinned version instead and record it on `applied`, exactly as if the user
// had selected the upgrade. Scoped pins *under other parents* still become
// nested overrides — those don't conflict with the direct edge.
//
// A parent installed at several versions is keyed per version ("pkg@version"):
// a bare "pkg" key would also pin the copies meant to be left alone, and can't
// give different copies different targets. The selection supplies that key as
// `parentSelector` (see parentOverrideKey), which takes precedence here; without
// one, a parent mapped to more than one target is still qualified. npm ignores
// or rejects some layouts of these keys (override-keys.js), so applyUpgrades
// refuses to write one (assertParentKeysApply).
//
// Two pins that resolve to the same key AND the same parent version are not
// separately expressible in npm's format; the audit layer collapses those into
// one decision before we get here (see mergeInstancesByOverrideKey), so this
// writer never faces that conflict in the real flow. If a caller passes such a
// pair anyway, the later pin wins.
/**
 * @param {PackageJson} json
 * @param {string} name
 * @param {OverrideSpec | null | undefined} spec
 * @param {WrittenOverride[]} out
 * @param {Map<string, DependencyField>} directField
 * @param {AppliedUpgrade[]} applied
 * @param {WrittenOverride[]} [alreadyPresent]
 */
function writeOverrideSpec(json, name, spec, out, directField, applied, alreadyPresent) {
  // An accepted pin whose value is already in the manifest. Not writing it is
  // correct — but discarding the fact is what makes the tool answer "no changes"
  // to a user who just accepted a fix, which reads as "you were already fine"
  // when the tree may still be unpatched. Recorded so the summary can say which
  // it was. See `unappliedOverrides` in vulnerabilities.js.
  /** @param {WrittenOverride} entry */
  const notePresent = (entry) => {
    if (!alreadyPresent) return;
    const at = alreadyPresent.findIndex(
      (o) => o.name === entry.name && (o.parent ?? null) === (entry.parent ?? null)
    );
    if (at === -1) alreadyPresent.push(entry);
  };

  const field = directField.get(name);

  // Bump a direct dependency's declared range to `version` instead of writing a
  // conflicting top-level override. Returns false if there's no section to write
  // to (only in isolated writer tests where `name` isn't really a direct dep).
  /** @param {string} version */
  const pinDirect = (version) => {
    if (!field) return false;
    const section = json[field];
    if (!section || typeof section !== 'object') return false;
    const from = section[name];
    if (from !== version) {
      section[name] = version;
      applied.push({ name, field, from, to: version });
    }
    return true;
  };

  const overridesRoot = () => {
    if (!json.overrides || typeof json.overrides !== 'object') json.overrides = {};
    return json.overrides;
  };

  // Record one written override for the summary. Two pins can resolve to the
  // same slot (same key, same name) when they can't be told apart — the last
  // write wins in the file, so it has to win here too, or the summary would
  // list a version that no longer exists in the manifest.
  /** @param {WrittenOverride} entry */
  const record = (entry) => {
    const at = out.findIndex((o) => o.name === entry.name && (o.parent ?? null) === (entry.parent ?? null));
    if (at === -1) out.push(entry);
    else out[at] = entry;
  };

  // A top-level pin and a scoped pin can land on the same key: pinning `vite`
  // itself writes `overrides.vite`, while pinning `picomatch` under `vite`
  // writes `overrides.vite.picomatch`. Assigning the string unconditionally
  // would drop the child pin whenever the scoped pass ran first — and the audit
  // display order (the child's advisory first) is exactly that order. The
  // self-pin goes under "." instead, which is the same shape the opposite order
  // already produces via the string→object promotion below.
  /** @param {string} version */
  const pinTopLevel = (version) => {
    const root = overridesRoot();
    const existing = root[name];
    if (existing && typeof existing === 'object') {
      if (existing['.'] === version) return notePresent({ name, to: version });
      existing['.'] = version;
    } else {
      if (existing === version) return notePresent({ name, to: version });
      root[name] = version;
    }
    record({ name, to: version });
  };

  if (typeof spec === 'string') {
    if (!spec) return;
    if (field) pinDirect(spec);
    else pinTopLevel(spec);
    return;
  }
  if (!spec || !Array.isArray(spec.scoped)) return;

  // A parent needs a version-qualified key only when it's being pinned to more
  // than one distinct target across its installed copies.
  /** @type {Map<string, Set<string>>} */
  const targetsByParent = new Map();
  for (const pin of spec.scoped) {
    if (!pin || !pin.version || pin.parentName == null) continue;
    let targets = targetsByParent.get(pin.parentName);
    if (!targets) targetsByParent.set(pin.parentName, (targets = new Set()));
    targets.add(pin.version);
  }

  for (const pin of spec.scoped) {
    if (!pin || !pin.version) continue;
    if (pin.parentName == null) {
      // Direct-dependency instance: bump the range. Fall back to a top-level pin
      // only when it isn't actually a direct dep (isolated writer tests).
      if (field && pinDirect(pin.version)) continue;
      pinTopLevel(pin.version);
      continue;
    }
    // Preserve scope computed from the full installed tree, not just the pins
    // staged here. Safe parent versions are absent from targetsByParent.
    // The fallback also supports callers that only supply the older spec shape.
    const qualify = (targetsByParent.get(pin.parentName)?.size || 0) > 1 && pin.parentVersion;
    const key = pin.parentSelector || (qualify ? `${pin.parentName}@${pin.parentVersion}` : pin.parentName);
    const root = overridesRoot();
    let bucket = root[key];
    if (typeof bucket === 'string') bucket = root[key] = { '.': bucket };
    else if (!bucket || typeof bucket !== 'object') bucket = root[key] = {};
    if (bucket[name] === pin.version) {
      notePresent({ name, to: pin.version, parent: key });
      continue;
    }
    bucket[name] = pin.version;
    record({ name, to: pin.version, parent: key });
  }
}

// The post-run summary is built from what the writer *intended* to apply, so an
// override lost between staging and serialization would be reported as applied
// while the file says otherwise — the summary would be describing intent, not
// outcome. This reconciles the two against the finished object. It runs before
// the write, so a failure leaves package.json untouched; nothing here should
// ever fire, which is exactly why it must be loud rather than silent.
/**
 * @param {PackageJson} json
 * @param {WrittenOverride[]} appliedOverrides
 */
function assertOverridesLanded(json, appliedOverrides) {
  const root = json.overrides;
  for (const entry of appliedOverrides) {
    const bucket = entry.parent ? root && root[entry.parent] : root;
    const value = bucket && typeof bucket === 'object' ? bucket[entry.name] : undefined;
    // A top-level pin reads back as a string, or from "." when a scoped pin
    // shares the key.
    const actual = value && typeof value === 'object' ? value['.'] : value;
    if (actual === entry.to) continue;
    const where = entry.parent ? `${entry.parent} › ${entry.name}` : entry.name;
    const found = actual === undefined ? 'is missing from' : `is ${actual} in`;
    throw new Error(
      `Internal error: override ${where} → ${entry.to} ${found} the resulting package.json. ` +
        'Nothing was written. Please report this with your package.json overrides block.'
    );
  }
}

// The spec the root manifest declares for `name`, in any dependency field.
/**
 * @param {PackageJson} json
 * @param {string} name
 */
function rootDeclaredSpec(json, name) {
  for (const field of /** @type {const} */ (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])) {
    const section = json[field];
    if (section && typeof section === 'object' && section[name] != null) return section[name];
  }
  return null;
}

// Refuse a layout npm would ignore or reject (rules in override-keys.js). The
// audit refuses such pins up front, but pins staged together in one run — for
// different packages under the same parent, or versions changed in the picker —
// can still produce one between them. Only parents this run wrote under are
// checked, so a layout already in the user's file doesn't block unrelated changes.
/**
 * @param {PackageJson} json
 * @param {WrittenOverride[]} appliedOverrides
 */
function assertParentKeysApply(json, appliedOverrides) {
  const root = json.overrides;
  if (!root || typeof root !== 'object') return;
  const written = new Set(appliedOverrides.map((o) => o.parent ?? o.name));
  /**
   * @param {string} why
   * @param {string} name
   * @returns {never}
   */
  const refuse = (why, name) => {
    throw new Error(`${why} Nothing was written. Stage fewer pins under ${name}, or edit the overrides by hand.`);
  };
  for (const name of new Set([...written].map(overrideKeyName))) {
    const qualified = Object.keys(root).filter((k) => k !== name && overrideKeyName(k) === name);
    if (qualified.length === 0) continue;
    if (name in root) {
      refuse(
        `Cannot write overrides "${name}" and "${qualified[0]}" side by side: npm applies only one of them, ` +
          'so some of these pins would silently do nothing.',
        name
      );
    }
    const rootSpec = rootDeclaredSpec(json, name);
    for (const key of qualified) {
      if (written.has(key) && risksEoverride(key, root[key], rootSpec)) {
        refuse(`Cannot write override "${key}": the root declares ${name} ${rootSpec}, and npm rejects both with EOVERRIDE.`, name);
      }
    }
    for (const [i, a] of qualified.entries()) {
      for (const b of qualified.slice(i + 1)) {
        if ((written.has(a) || written.has(b)) && !overrideBucketsConflict(root[a], root[b])) {
          refuse(
            `Cannot write overrides "${a}" and "${b}" side by side: npm keeps both only when they pin some ` +
              "package to versions that don't overlap, so one of them would silently do nothing.",
            name
          );
        }
      }
    }
  }
}

/**
 * Apply a Map<name, newRange> of accepted upgrades, an optional map of npm
 * `overrides` to add, and an optional list of override names to remove, then
 * write the manifest back to disk.
 *
 * Each `overrides` value is either a version string (a top-level pin that forces
 * *every* instance of that package) or { scoped: [{ parentName, version }] },
 * which nests each pin under its parent so different dependents can keep
 * different versions.
 *
 * Returns { applied: {name,field,from,to}[], overrides: {name,to,parent?}[],
 * removed: {name}[] }.
 *
 * @param {Manifest} manifest
 * @param {Map<string, string>} selections
 * @param {Record<string, OverrideSpec | null>} [overrides]  a null spec writes nothing
 * @param {string[]} [removals]
 * @returns {Promise<ApplyResult>}
 */
export async function applyUpgrades(manifest, selections, overrides = {}, removals = []) {
  /** @type {AppliedUpgrade[]} */
  const applied = [];

  for (const descriptor of manifest.descriptors) {
    // Prefer the field-qualified key so a package declared in both dependencies
    // and devDependencies gets each slot's own selection; fall back to the bare
    // name for callers that key by name alone.
    const newRange = selections.get(descriptor.key) ?? selections.get(descriptor.name);
    if (!newRange || newRange === descriptor.range) continue;

    // The descriptor was read out of this very section, so it exists.
    /** @type {DependencyMap} */ (manifest.json[descriptor.field])[descriptor.name] = newRange;
    applied.push({ name: descriptor.name, field: descriptor.field, from: descriptor.range, to: newRange });
  }

  // A package that is itself a direct dependency can't take a top-level override
  // (npm rejects it), so writeOverrideSpec routes those pins to a range bump on
  // `applied` instead; the map tells it which names/fields are direct.
  //
  // A name can appear in both fields. npm resolves the `dependencies` edge, so
  // that is the one to bump — bumping devDependencies would leave the runtime
  // dependency on the vulnerable range. Explicit rather than relying on the
  // order descriptors happen to arrive in.
  /** @type {Map<string, DependencyField>} */
  const directField = new Map();
  for (const d of manifest.descriptors) {
    if (directField.get(d.name) === 'dependencies') continue;
    directField.set(d.name, d.field);
  }

  /** @type {WrittenOverride[]} */
  const appliedOverrides = [];
  /** @type {WrittenOverride[]} */
  const alreadyPresent = [];
  for (const [name, spec] of Object.entries(overrides || {})) {
    // writeOverrideSpec creates manifest.json.overrides lazily, only if it writes
    // a real override entry — pins that become direct-dependency range bumps
    // never materialize an (empty) overrides block.
    writeOverrideSpec(manifest.json, name, spec, appliedOverrides, directField, applied, alreadyPresent);
  }

  /** @type {{ name: string }[]} */
  const removed = [];
  if (removals && removals.length > 0 && manifest.json.overrides && typeof manifest.json.overrides === 'object') {
    // A removal drops a *top-level* override entry (the only kind the audit
    // flags as removable). Skip it only when this same run wrote a top-level
    // pin under that key, so an accepted addition isn't clobbered by a
    // co-staged "drop unused override" for the same name. A scoped addition
    // nested under a parent touches a different key, so it does NOT shield the
    // top-level removal.
    const addedTopLevel = new Set(appliedOverrides.filter((o) => !o.parent).map((o) => o.name));
    for (const name of removals) {
      if (addedTopLevel.has(name)) continue;
      const current = manifest.json.overrides[name];
      if (current == null) continue;
      // The key may hold an object because a scoped pin staged in this same run
      // nested a child under it, promoting the old string pin to `{'.': pin}`.
      // The removal targets that self-pin, so drop the "." slot alone —
      // deleting the whole key would take the child pin with it.
      if (typeof current === 'object') {
        if (!('.' in current)) continue;
        delete current['.'];
        if (Object.keys(current).length === 0) delete manifest.json.overrides[name];
      } else {
        delete manifest.json.overrides[name];
      }
      removed.push({ name });
    }
  }

  // Drop an overrides block left empty by removals (writeOverrideSpec already
  // avoids creating one when every pin routed to a range bump).
  if (
    (appliedOverrides.length > 0 || removed.length > 0) &&
    manifest.json.overrides &&
    typeof manifest.json.overrides === 'object' &&
    Object.keys(manifest.json.overrides).length === 0
  ) {
    delete manifest.json.overrides;
  }

  if (applied.length === 0 && appliedOverrides.length === 0 && removed.length === 0) {
    return { applied, overrides: appliedOverrides, removed, alreadyPresent };
  }

  assertParentKeysApply(manifest.json, appliedOverrides);
  assertOverridesLanded(manifest.json, appliedOverrides);

  const serialized = JSON.stringify(manifest.json, null, manifest.indent) + (manifest.trailingNewline ? '\n' : '');
  await writeFile(manifest.filePath, serialized, 'utf8');

  return { applied, overrides: appliedOverrides, removed, alreadyPresent };
}

/**
 * Apply project-wide selections to a project loaded by `loadProject`. Selections
 * are keyed by descriptor `id` (not name), so a package appearing in several
 * workspaces is written to exactly the manifest its row belongs to — no fan-out.
 *
 * Each manifest is written at most once, reusing the single-file `applyUpgrades`
 * writer, so per-file formatting (indent, trailing newline) is preserved
 * independently. `overrides` and `removals` are npm-workspace root-only: they are
 * routed exclusively to the root manifest regardless of which workspace owns the
 * vulnerable dependency (npm honors `overrides` only in the root manifest).
 *
 * Consequence: a pin for a package a *workspace* declares directly is written as
 * a root-level entry rather than a range bump on that workspace's own manifest —
 * which npm rejects (EOVERRIDE) when the pin falls outside the workspace's
 * declared range. Routing such a pin to its owning manifest needs scoped specs to
 * carry the manifest they came from; until then the audit refuses the cases it
 * can detect (see `pinConflict` in vulnerabilities.js).
 *
 * Returns { applied, overrides, removed } aggregated across manifests; each
 * `applied` entry gains `workspace` (the display name, null for the root) for the
 * per-workspace post-submit summary.
 *
 * @param {Project} project
 * @param {Map<string, string>} selections
 * @param {Record<string, OverrideSpec | null>} [overrides]  a null spec writes nothing
 * @param {string[]} [removals]
 * @returns {Promise<ApplyResult<ProjectAppliedUpgrade>>}
 */
export async function applyProject(project, selections, overrides = {}, removals = []) {
  // Route each id-keyed selection to its owning manifest, re-keyed by the
  // "<field> <name>" slot the per-file writer addresses. Keying by bare name
  // would fan one row's selection out to both fields when a package is declared
  // in dependencies *and* devDependencies.
  /** @type {Map<string, Map<string, string>>} */
  const byRelPath = new Map();
  for (const d of project.descriptors) {
    const range = selections.get(d.id);
    if (range == null) continue;
    let slots = byRelPath.get(d.relPath);
    if (!slots) byRelPath.set(d.relPath, (slots = new Map()));
    slots.set(`${d.field} ${d.name}`, range);
  }

  /** @type {ProjectAppliedUpgrade[]} */
  const applied = [];
  /** @type {WrittenOverride[]} */
  const appliedOverrides = [];
  /** @type {{ name: string }[]} */
  const removed = [];
  /** @type {WrittenOverride[]} */
  const alreadyPresent = [];
  for (const manifest of project.manifests) {
    const isRoot = manifest === project.root;
    const slotMap = byRelPath.get(manifest.relPath) || new Map();
    // Nothing to write for a child manifest with no selections (overrides and
    // removals only ever touch the root), so skip its no-op write entirely.
    if (!isRoot && slotMap.size === 0) continue;

    const res = await applyUpgrades(manifest, slotMap, isRoot ? overrides : {}, isRoot ? removals : []);
    // `relPath` rides along so the summary can label a workspace that declares
    // no `name` — npm allows that and infers the name from the directory.
    for (const a of res.applied) {
      applied.push({ ...a, workspace: manifest.workspace, relPath: manifest.relPath });
    }
    appliedOverrides.push(...res.overrides);
    removed.push(...res.removed);
    alreadyPresent.push(...(res.alreadyPresent || []));
  }

  return { applied, overrides: appliedOverrides, removed, alreadyPresent };
}
