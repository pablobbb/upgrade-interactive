import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

// Write one override spec for `name` into the resolved `root` overrides object,
// pushing an {name,to,parent?} record for each entry actually changed. A spec is
// either a version string (top-level pin, forcing every instance) or
// { scoped: [{ parentName, parentVersion, version }] } where each pin is nested
// under its parent package (parentName === null falls back to a top-level pin,
// for a direct dependency). A parent whose value is already a string override of
// the parent itself is preserved under the "." key when we add a child pin.
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
function writeOverrideSpec(root, name, spec, out) {
  if (typeof spec === 'string') {
    if (!spec || root[name] === spec) return;
    root[name] = spec;
    out.push({ name, to: spec });
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
      if (root[name] === pin.version) continue;
      root[name] = pin.version;
      out.push({ name, to: pin.version });
      continue;
    }
    // Fall back to the bare name if we can't qualify (no version recorded).
    const qualify = (targetsByParent.get(pin.parentName)?.size || 0) > 1 && pin.parentVersion;
    const key = qualify ? `${pin.parentName}@${pin.parentVersion}` : pin.parentName;
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

  const appliedOverrides = [];
  const overrideEntries = Object.entries(overrides || {});
  if (overrideEntries.length > 0) {
    if (!manifest.json.overrides || typeof manifest.json.overrides !== 'object') {
      manifest.json.overrides = {};
    }
    for (const [name, spec] of overrideEntries) {
      writeOverrideSpec(manifest.json.overrides, name, spec, appliedOverrides);
    }
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
    if (Object.keys(manifest.json.overrides).length === 0) delete manifest.json.overrides;
  }

  if (applied.length === 0 && appliedOverrides.length === 0 && removed.length === 0) {
    return { applied, overrides: appliedOverrides, removed };
  }

  const serialized = JSON.stringify(manifest.json, null, manifest.indent) + (manifest.trailingNewline ? '\n' : '');
  await writeFile(manifest.filePath, serialized, 'utf8');

  return { applied, overrides: appliedOverrides, removed };
}
