import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { discoverWorkspaces } from './workspaces.js';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];

export async function loadManifest(cwd) {
  const filePath = path.join(cwd, 'package.json');
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new Error(`No package.json found in ${cwd}`);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse package.json: ${err.message}`);
  }

  const indentMatch = raw.match(/^[ \t]+/m);
  const indent = indentMatch ? indentMatch[0] : '  ';
  const trailingNewline = raw.endsWith('\n');

  const descriptors = [];
  for (const field of DEPENDENCY_FIELDS) {
    const section = json[field];
    if (!section || typeof section !== 'object') continue;
    for (const [name, range] of Object.entries(section)) {
      descriptors.push({ name, range, field });
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
 *   - `workspaces` — the discovered package list (root first) or null when
 *     standalone.
 *
 * Descriptors whose `name` is itself a local workspace package (an internal
 * sibling dependency) are skipped — they aren't upgradable from the registry.
 */
export async function loadProject(cwd) {
  const discovered = await discoverWorkspaces(cwd);
  const infos = discovered || [{ dir: cwd, name: null, relPath: '.' }];
  const workspaceNames = new Set((discovered || []).map((p) => p.name).filter(Boolean));

  const manifests = [];
  const descriptors = [];
  for (const info of infos) {
    const manifest = await loadManifest(info.dir);
    manifest.workspace = info.relPath === '.' ? null : info.name;
    manifest.relPath = info.relPath;
    manifests.push(manifest);
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

  return { root: manifests[0], manifests, descriptors, workspaces: discovered };
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
// When one parent name needs *different* child versions for different installed
// copies of itself, a bare "pkg" key can't express both — so those pins are
// keyed by the more specific "pkg@version" selector instead. A parent that maps
// to a single target keeps the simpler bare key (which covers every version of
// it). Bare and qualified keys coexist; npm applies the most specific.
//
// Two pins that resolve to the same key AND the same parent version are not
// separately expressible in npm's format; the audit layer collapses those into
// one decision before we get here (see mergeInstancesByOverrideKey), so this
// writer never faces that conflict in the real flow. If a caller passes such a
// pair anyway, the later pin wins.
function writeOverrideSpec(json, name, spec, out, directField, applied) {
  const field = directField.get(name);

  // Bump a direct dependency's declared range to `version` instead of writing a
  // conflicting top-level override. Returns false if there's no section to write
  // to (only in isolated writer tests where `name` isn't really a direct dep).
  const pinDirect = (version) => {
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

  const pinTopLevel = (version) => {
    const root = overridesRoot();
    if (root[name] === version) return;
    root[name] = version;
    out.push({ name, to: version });
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
  const targetsByParent = new Map();
  for (const pin of spec.scoped) {
    if (!pin || !pin.version || pin.parentName == null) continue;
    if (!targetsByParent.has(pin.parentName)) targetsByParent.set(pin.parentName, new Set());
    targetsByParent.get(pin.parentName).add(pin.version);
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
    // Fall back to the bare name if we can't qualify (no version recorded).
    const qualify = (targetsByParent.get(pin.parentName)?.size || 0) > 1 && pin.parentVersion;
    const key = qualify ? `${pin.parentName}@${pin.parentVersion}` : pin.parentName;
    const root = overridesRoot();
    let bucket = root[key];
    if (typeof bucket === 'string') bucket = root[key] = { '.': bucket };
    else if (!bucket || typeof bucket !== 'object') bucket = root[key] = {};
    if (bucket[name] === pin.version) continue;
    bucket[name] = pin.version;
    out.push({ name, to: pin.version, parent: key });
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
 */
export async function applyUpgrades(manifest, selections, overrides = {}, removals = []) {
  const applied = [];

  for (const descriptor of manifest.descriptors) {
    const newRange = selections.get(descriptor.name);
    if (!newRange || newRange === descriptor.range) continue;

    manifest.json[descriptor.field][descriptor.name] = newRange;
    applied.push({ name: descriptor.name, field: descriptor.field, from: descriptor.range, to: newRange });
  }

  // A package that is itself a direct dependency can't take a top-level override
  // (npm rejects it), so writeOverrideSpec routes those pins to a range bump on
  // `applied` instead; the map tells it which names/fields are direct.
  const directField = new Map(manifest.descriptors.map((d) => [d.name, d.field]));

  const appliedOverrides = [];
  for (const [name, spec] of Object.entries(overrides || {})) {
    // writeOverrideSpec creates manifest.json.overrides lazily, only if it writes
    // a real override entry — pins that become direct-dependency range bumps
    // never materialize an (empty) overrides block.
    writeOverrideSpec(manifest.json, name, spec, appliedOverrides, directField, applied);
  }

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
      if (manifest.json.overrides[name] == null) continue;
      delete manifest.json.overrides[name];
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
    return { applied, overrides: appliedOverrides, removed };
  }

  const serialized = JSON.stringify(manifest.json, null, manifest.indent) + (manifest.trailingNewline ? '\n' : '');
  await writeFile(manifest.filePath, serialized, 'utf8');

  return { applied, overrides: appliedOverrides, removed };
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
 * Returns { applied, overrides, removed } aggregated across manifests; each
 * `applied` entry gains `workspace` (the display name, null for the root) for the
 * per-workspace post-submit summary.
 */
export async function applyProject(project, selections, overrides = {}, removals = []) {
  // Route each id-keyed selection to its owning manifest, collapsing to the
  // name-keyed Map the per-file writer expects (a name is unique within a file).
  const byRelPath = new Map();
  for (const d of project.descriptors) {
    const range = selections.get(d.id);
    if (range == null) continue;
    if (!byRelPath.has(d.relPath)) byRelPath.set(d.relPath, new Map());
    byRelPath.get(d.relPath).set(d.name, range);
  }

  const applied = [];
  const appliedOverrides = [];
  const removed = [];
  for (const manifest of project.manifests) {
    const isRoot = manifest === project.root;
    const nameMap = byRelPath.get(manifest.relPath) || new Map();
    // Nothing to write for a child manifest with no selections (overrides and
    // removals only ever touch the root), so skip its no-op write entirely.
    if (!isRoot && nameMap.size === 0) continue;

    const res = await applyUpgrades(manifest, nameMap, isRoot ? overrides : {}, isRoot ? removals : []);
    for (const a of res.applied) applied.push({ ...a, workspace: manifest.workspace });
    appliedOverrides.push(...res.overrides);
    removed.push(...res.removed);
  }

  return { applied, overrides: appliedOverrides, removed };
}
