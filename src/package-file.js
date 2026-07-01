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
 * Apply a Map<name, newRange> of accepted upgrades plus an optional
 * { name: version } map of npm `overrides` to the manifest and write it back
 * to disk.
 *
 * Returns { applied: { name, field, from, to }[], overrides: { name, to }[] }.
 * Note: a top-level `overrides` entry forces *every* instance of that package
 * (direct and transitive) to the pinned version.
 */
export async function applyUpgrades(manifest, selections, overrides = {}) {
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

  if (applied.length === 0 && appliedOverrides.length === 0) {
    return { applied, overrides: appliedOverrides };
  }

  const serialized = JSON.stringify(manifest.json, null, manifest.indent) + (manifest.trailingNewline ? '\n' : '');
  await writeFile(manifest.filePath, serialized, 'utf8');

  return { applied, overrides: appliedOverrides };
}
