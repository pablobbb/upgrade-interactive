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
