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
 * Does this lockfile `packages` key name one of "our" manifests — the root ("")
 * or a workspace — rather than an installed dependency?
 *
 * `manifestPaths` is the set discovery actually found, so the answer is exact.
 * Path *shape* cannot decide this: npm implements workspaces as `file:` links,
 * and its docs say a `link: true` node means "the link target will also be
 * included in the lockfile" — so an ordinary local dependency
 * (`"lib": "file:./lib"`) produces a top-level `lib` entry indistinguishable
 * from a workspace's `packages/foo`. Guessing from the path would classify a
 * plain single-package project as a monorepo.
 *
 * Falls back to the shape heuristic only when no set is supplied (direct
 * callers and older tests), where the caller has no better information anyway.
 */
function isManifestPath(pkgPath, manifestPaths) {
  if (manifestPaths) return manifestPaths.has(pkgPath);
  return pkgPath === '' || !pkgPath.includes('node_modules/');
}

/**
 * Return { versions: Map<name, Set<version>>, direct: Set<name>, packages }
 * for the whole installed tree, or null if there's no usable lockfile (feature
 * then degrades to range-resolved-only checks for direct deps). `packages` is
 * the raw npm lockfile `packages` map, used to see which ranges dependents
 * declare for a package (for spotting no-longer-needed overrides).
 *
 * `direct` unions the declared deps of the root *and* every workspace manifest,
 * so a package that a workspace depends on directly is classified as direct
 * tree-wide (npm workspaces share this one root lockfile).
 *
 * `manifestPaths` (lockfile-style keys: "" plus each workspace's relative path)
 * says which entries those manifests are. A standalone project passes [""], so
 * only the root contributes and the result is exactly the pre-workspaces one.
 */
export async function loadInstalledVersions(cwd, manifestPaths = null) {
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

  // Direct deps = what the root and each workspace manifest declare. In a
  // single-package repo only the "" entry qualifies, so this is unchanged there.
  const manifestSet = manifestPaths ? new Set(manifestPaths) : null;
  const direct = new Set();
  for (const [pkgPath, info] of Object.entries(packages)) {
    if (!isManifestPath(pkgPath, manifestSet) || !info || typeof info !== 'object') continue;
    for (const name of Object.keys(info.dependencies || {})) direct.add(name);
    for (const name of Object.keys(info.devDependencies || {})) direct.add(name);
  }

  return { versions, direct, packages };
}
