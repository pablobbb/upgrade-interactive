// npm-workspaces discovery: find the project root (the manifest whose
// `workspaces` field owns `cwd`) and expand that field into concrete workspace
// directories. Uses a deliberately minimal in-house glob so we add no new
// dependencies and stay on Node 18 (no fs.glob).

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** A platform-separated relative path as a POSIX one. */
function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * Read a directory's package.json. Returns { name } (name is null when the
 * manifest declares none), or null when there is no readable/valid manifest.
 */
async function readManifest(dir) {
  let raw;
  try {
    raw = await readFile(path.join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const json = JSON.parse(raw);
    return { name: typeof json.name === 'string' ? json.name : null, workspaces: json.workspaces };
  } catch {
    return null;
  }
}

/**
 * Accept both the array form and the `{ packages: [...] }` object form, split
 * into the patterns that select directories and the `!`-prefixed ones that
 * exclude them. Like minimatch, negations apply to the whole positive result
 * regardless of where they appear in the list, so order doesn't matter here.
 */
function normalizePatterns(workspacesField) {
  const list = Array.isArray(workspacesField)
    ? workspacesField
    : workspacesField && Array.isArray(workspacesField.packages)
      ? workspacesField.packages
      : [];
  const include = [];
  const exclude = [];
  for (const p of list) {
    if (typeof p !== 'string' || p.length === 0) continue;
    if (p.startsWith('!')) {
      const rest = p.slice(1);
      if (rest.length > 0) exclude.push(rest);
    } else {
      include.push(p);
    }
  }
  return { include, exclude };
}

/** Escape the characters that would otherwise be regex syntax. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one pattern segment into a predicate over a directory name. `*` stands
 * for any run of characters *within* the segment, so npm's `packages/*-api` and
 * `apps/web-*` work, not just a bare `*`. A segment with no `*` is an exact match.
 */
function segmentMatcher(segment) {
  if (segment === '*') return () => true;
  if (!segment.includes('*')) return (name) => name === segment;
  const re = new RegExp(`^${segment.split('*').map(escapeRegExp).join('[^/]*')}$`);
  return (name) => re.test(name);
}

/** Absolute directories under `root` matched by any of `patterns`. */
async function matchPatterns(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    const segments = pattern.split('/').map((s) => s.trim()).filter(Boolean);
    dirs.push(...(await matchSegments(root, segments)));
  }
  return dirs;
}

/** Immediate subdirectories of `dir`, excluding node_modules. Never throws. */
async function listSubdirs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // isDirectory() does not follow symlinks, so symlinked dirs are ignored —
  // that (plus skipping node_modules) keeps the globstar walk cycle-free.
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort();
}

/**
 * Return absolute directories under `base` matching `segments`, a path split on
 * "/". Supported (a subset of npm's minimatch):
 *   - literal segments      ("packages/foo")
 *   - "*" anywhere in a segment ("packages/*", "packages/*-api", "apps/web-*")
 *   - a trailing "**"       ("packages/**" — that dir and all descendants)
 * A "**" is only meaningful as the final segment; anything after it is ignored.
 * Negation is handled a level up, in normalizePatterns/expandWorkspaces.
 */
async function matchSegments(base, segments) {
  if (segments.length === 0) return [base];
  const [head, ...rest] = segments;

  if (head === '**') {
    // Trailing globstar: `base` and every descendant directory.
    const out = [base];
    for (const name of await listSubdirs(base)) {
      out.push(...(await matchSegments(path.join(base, name), ['**'])));
    }
    return out;
  }

  // One branch for literal and `*`-bearing segments alike: both descend only
  // into subdirectories that really exist, so the exact-match case needs no
  // special handling beyond the predicate.
  const matches = segmentMatcher(head);
  const out = [];
  for (const name of await listSubdirs(base)) {
    if (!matches(name)) continue;
    out.push(...(await matchSegments(path.join(base, name), rest)));
  }
  return out;
}

/**
 * Expand a `workspaces` field into `[{ dir, name, relPath }]`, one entry per
 * matched directory that actually contains a package.json. Excludes the root
 * itself, anything a `!` pattern excludes, and de-dupes directories matched by
 * more than one pattern. Sorted by relative path for stable ordering.
 *
 * `relPath` is always POSIX-separated, on every platform. It is an identity and
 * display value — the key `-w` matches against, the id descriptors carry, the
 * heading the TUI prints, the shape lockfile keys take — and never a path handed
 * back to the filesystem (that is what `dir` is for). Normalizing once here is
 * what makes `-w packages/api` work on Windows, where `path.relative` would
 * otherwise yield `packages\api` and match nothing a user could reasonably type.
 */
export async function expandWorkspaces(rootDir, workspacesField) {
  const root = path.resolve(rootDir);
  const { include, exclude } = normalizePatterns(workspacesField);
  const excluded = new Set(await matchPatterns(root, exclude));
  const seen = new Set();
  const result = [];
  for (const dir of await matchPatterns(root, include)) {
    if (dir === root || seen.has(dir) || excluded.has(dir)) continue;
    seen.add(dir);
    const manifest = await readManifest(dir);
    if (!manifest) continue; // no package.json here — not a workspace
    result.push({ dir, name: manifest.name, relPath: toPosix(path.relative(root, dir)) });
  }
  result.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return result;
}

/** True when `child` is `parent` or nested beneath it. */
function isWithin(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return p === c || c.startsWith(p + path.sep);
}

/**
 * Walk up from `cwd` to the nearest ancestor whose package.json declares a
 * `workspaces` field that expands to include `cwd` (or is `cwd` itself). Returns
 * { rootDir, workspacesField, workspaces } — `workspaces` excludes the root.
 * Returns null when `cwd` is a standalone package (no owning workspace root),
 * so callers degrade to single-manifest behavior.
 */
export async function findProjectRoot(cwd) {
  const start = path.resolve(cwd);
  let dir = start;
  while (true) {
    const manifest = await readManifest(dir);
    if (manifest && manifest.workspaces != null) {
      const workspaces = await expandWorkspaces(dir, manifest.workspaces);
      // The root owns `cwd` if we started at the root, or `cwd` lives inside
      // one of the expanded workspaces (running from packages/foo/... too).
      if (dir === start || workspaces.some((w) => isWithin(w.dir, start))) {
        return { rootDir: dir, workspacesField: manifest.workspaces, workspaces };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * High-level entry point for Phase 2. Returns the project's package directories
 * as `[{ dir, name, relPath }]` with the root first (relPath "."), followed by
 * each workspace, or null when `cwd` is standalone (no workspaces).
 */
export async function discoverWorkspaces(cwd) {
  const found = await findProjectRoot(cwd);
  if (!found) return null;
  const rootManifest = await readManifest(found.rootDir);
  return [
    { dir: found.rootDir, name: rootManifest ? rootManifest.name : null, relPath: '.' },
    ...found.workspaces,
  ];
}
