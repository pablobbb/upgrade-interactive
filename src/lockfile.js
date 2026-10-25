// Reads installed versions (direct + transitive) from package-lock.json.
// Uses the npm v7+ "packages" map, which lists every installed path/version.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** @import { InstalledTree, LockPackages } from './types.js' */

/**
 * Derive a package name from a lockfile path like "node_modules/@scope/name".
 * @param {string} pkgPath
 */
function nameFromPath(pkgPath) {
  const marker = 'node_modules/';
  const idx = pkgPath.lastIndexOf(marker);
  if (idx === -1) return null;
  const name = pkgPath.slice(idx + marker.length);
  return name || null;
}

/**
 * Return { versions: Map<name, Set<version>>, packages } for the whole installed
 * tree, or null if there's no usable lockfile (feature then degrades to
 * range-resolved-only checks for direct deps). `packages` is the raw npm
 * lockfile `packages` map, used to see which ranges dependents declare for a
 * package (for spotting no-longer-needed overrides).
 *
 * @param {string} cwd
 * @returns {Promise<InstalledTree | null>}
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

  /** @type {LockPackages} */
  const packages = json.packages;
  if (!packages || typeof packages !== 'object') return null;

  /** @type {Map<string, Set<string>>} */
  const versions = new Map();
  for (const [pkgPath, info] of Object.entries(packages)) {
    if (!pkgPath || !info || !info.version) continue; // skip the "" root entry
    const name = nameFromPath(pkgPath);
    if (!name) continue;
    let set = versions.get(name);
    if (!set) versions.set(name, (set = new Set()));
    set.add(info.version);
  }

  return { versions, packages };
}
