// Reads installed versions (direct + transitive) from package-lock.json.
// Uses the npm v7+ "packages" map, which lists every installed path/version.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Derive a package name from a lockfile path like "node_modules/@scope/name". */
function nameFromPath(pkgPath) {
  const marker = 'node_modules/';
  const idx = pkgPath.lastIndexOf(marker);
  if (idx === -1) return null;
  const name = pkgPath.slice(idx + marker.length);
  return name || null;
}

/**
 * Return { versions: Map<name, Set<version>>, direct: Set<name> } for the whole
 * installed tree, or null if there's no usable lockfile (feature then degrades
 * to range-resolved-only checks for direct deps).
 */
export async function loadInstalledVersions(cwd) {
  const filePath = path.join(cwd, 'package-lock.json');
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const packages = json.packages;
  if (!packages || typeof packages !== 'object') return null;

  const versions = new Map();
  for (const [pkgPath, info] of Object.entries(packages)) {
    if (!pkgPath || !info || !info.version) continue; // skip the "" root entry
    const name = nameFromPath(pkgPath);
    if (!name) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(info.version);
  }

  const root = packages[''] || {};
  const direct = new Set([
    ...Object.keys(root.dependencies || {}),
    ...Object.keys(root.devDependencies || {}),
  ]);

  return { versions, direct };
}
