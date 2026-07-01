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

/**
 * Apply a Map<name, newRange> of accepted upgrades, an optional
 * { name: version } map of npm `overrides` to add, and an optional list of
 * override names to remove, then write the manifest back to disk.
 *
 * Returns { applied: {name,field,from,to}[], overrides: {name,to}[],
 * removed: {name}[] }. Note: a top-level `overrides` entry forces *every*
 * instance of that package (direct and transitive) to the pinned version.
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
    for (const [name, version] of overrideEntries) {
      if (!version || manifest.json.overrides[name] === version) continue;
      manifest.json.overrides[name] = version;
      appliedOverrides.push({ name, to: version });
    }
  }

  const removed = [];
  if (removals && removals.length > 0 && manifest.json.overrides && typeof manifest.json.overrides === 'object') {
    for (const name of removals) {
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
