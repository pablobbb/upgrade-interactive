// Turns raw npm advisory data into a per-package vulnerability summary the UI
// can render, plus the list of safe versions the override picker offers.

import semver from 'semver';
import { fetchPackageMeta, fetchBulkAdvisories, mapWithConcurrency } from './registry.js';
import { parentOverrideKey, isPinnableInstance, defaultScopedChoiceIndex } from './override-select.js';
import { overrideKeyName, overrideKeySpec, overrideBucketsConflict, risksEoverride } from './override-keys.js';

// The four standard npm/GitHub severity levels, ranked worst-first, with the
// color used to render them. Centralized so Row.js and the picker agree.
export const SEVERITY = {
  critical: { label: 'critical', color: 'red', rank: 4 },
  high: { label: 'high', color: 'red', rank: 3 },
  moderate: { label: 'moderate', color: 'yellow', rank: 2 },
  low: { label: 'low', color: 'gray', rank: 1 },
};

const CONCURRENCY = 8;

function severityRank(sev) {
  return (SEVERITY[sev] && SEVERITY[sev].rank) || 0;
}

function satisfiesAdvisory(version, advisory) {
  try {
    return semver.satisfies(version, advisory.vulnerable_versions, { includePrerelease: true });
  } catch {
    return false;
  }
}

function matchesAny(version, advisories) {
  return advisories.some((a) => satisfiesAdvisory(version, a));
}

/** Union two { name: Set<version> } maps into a fresh one. */
function mergeVersionSets(a, b) {
  const merged = {};
  for (const source of [a, b]) {
    for (const [name, set] of Object.entries(source)) {
      if (!merged[name]) merged[name] = new Set();
      for (const v of set) merged[name].add(v);
    }
  }
  return merged;
}

/** Highest valid semver in a list, or null. */
function maxVersion(list) {
  let max = null;
  for (const v of list) {
    if (!v || !semver.valid(v)) continue;
    if (!max || semver.gt(v, max)) max = v;
  }
  return max;
}

function advisoryCve(advisory) {
  if (advisory && Array.isArray(advisory.cves) && advisory.cves[0]) return advisory.cves[0];
  if (advisory && advisory.github_advisory_id) return advisory.github_advisory_id;
  // The bulk endpoint doesn't return the CVE number directly, but its URL is a
  // GitHub advisory (GHSA) page that lists it — use the GHSA id as the label.
  const ghsa = advisory && advisory.url && advisory.url.match(/GHSA-[0-9a-z-]+/i);
  if (ghsa) return ghsa[0];
  if (advisory && advisory.id != null) return `advisory ${advisory.id}`;
  return 'advisory';
}

// Every semver range that some package in the installed tree declares for
// `name` — i.e. what would have to resolve if a manual override were removed.
const RANGE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
function requiredRangesFor(packages, name) {
  const ranges = new Set();
  for (const info of Object.values(packages || {})) {
    if (!info || typeof info !== 'object') continue;
    for (const field of RANGE_FIELDS) {
      const section = info[field];
      if (section && typeof section === 'object' && section[name] != null) {
        ranges.add(section[name]);
      }
    }
  }
  return [...ranges];
}

// The version a fresh resolve of `range` lands on, which is also what
// `npm update` picks: the newest published non-prerelease version it admits
// (docs/2026-10-11-spike-override-keys.md, Finding 5). Null when the range isn't
// semver or admits nothing. Both "is this override still needed?" and "would
// re-resolving fix this without one?" ask where a range lands, and both use this.
function newestInRange(versions, range) {
  if (!semver.validRange(range)) return null;
  return semver.maxSatisfying(versions, range, { includePrerelease: false });
}

/** Package name from a lockfile path ("node_modules/@scope/x" -> "@scope/x"). */
function nameFromLockPath(pkgPath) {
  const marker = 'node_modules/';
  const idx = pkgPath.lastIndexOf(marker);
  return idx === -1 ? null : pkgPath.slice(idx + marker.length) || null;
}

/** The range some parent declares for `name`, or null if it doesn't need it. */
function declaredRangeFor(info, name) {
  for (const field of RANGE_FIELDS) {
    const section = info[field];
    if (section && typeof section === 'object' && section[name] != null) return section[name];
  }
  return null;
}

// Resolve which installed node a `name` dependency of the package at
// `parentPath` points to, following node's "nearest node_modules, then walk up
// to the root" resolution. Returns the winning lockfile path, or null.
function resolveInstalledPath(packages, parentPath, name) {
  let prefix = parentPath;
  // Guard against a malformed tree causing an unbounded walk.
  for (let i = 0; i < 64; i++) {
    const candidate = prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate] && packages[candidate].version) return candidate;
    const idx = prefix.lastIndexOf('/node_modules/');
    if (idx !== -1) prefix = prefix.slice(0, idx);
    else if (prefix !== '') prefix = ''; // a top-level package -> try the root
    else return null;
  }
  return null;
}

// The version of a lockfile entry known to have one: resolveInstalledPath and
// the unappliedOverrides index only ever yield entries with a version.
function versionAt(packages, at) {
  return packages[at].version;
}

// npm override keys are either a bare package name or a version-qualified
// "name@range". Only the bare form is understood here: a selector needs
// range-intersection logic, and guessing at one risks calling a live pin
// unapplied. `null` means "can't say", which every caller treats as "not
// unapplied" — the conservative direction.
function bareOverrideKeyName(key) {
  // Index 0 is a scope ("@scope/pkg"), not a selector separator.
  return key.lastIndexOf('@') > 0 ? null : key;
}

// Split a *parent* override key, which the writer already emits qualified
// ("vite@5.0.0") when one parent needs two different pins.
function splitParentKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, version: null };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

// Every installed copy of `name`, with the ranges its dependents (the root
// manifest included) declare for it.
function installedCopies(packages, name) {
  const copies = new Map();
  for (const [from, info] of Object.entries(packages)) {
    if (!info || typeof info !== 'object') continue;
    const range = declaredRangeFor(info, name);
    if (range == null) continue;
    const at = resolveInstalledPath(packages, from, name);
    if (!at) continue;
    let copy = copies.get(at);
    if (!copy) copies.set(at, (copy = { path: at, version: versionAt(packages, at), ranges: [] }));
    copy.ranges.push(range);
  }
  return [...copies.values()];
}

// A "parent@version" key also applies to every other copy of the parent whose
// dependents declare a range admitting that version: npm matches keys against
// declared ranges, not installed versions. Measured on npm 11.13 through 12.2
// (docs/2026-10-11-spike-override-keys.md), a "minimatch@3.0.4" pin also
// changed glob's own minimatch@3.1.2, reached through glob's "^3.0.4". So each pin that needs such a key keeps only the versions
// that are harmless for every copy it reaches — inside that copy's declared
// range for `name`, and no downgrade — and is refused when none are. A copy
// already covered by an existing key of the parent isn't reached: npm uses the
// first matching key, and existing keys come first.
function limitToCopiesReached(name, instances, keysOf, packages) {
  const copiesByParent = new Map();
  for (const i of instances) {
    if (!isPinnableInstance(i) || i.parentName == null || !i.parentVersion) continue;
    const parent = i.parentName;
    const parentVersion = i.parentVersion;
    if (!instances.some((o) => o.parentName === parent && o.parentVersion !== parentVersion)) continue;
    let copies = copiesByParent.get(parent);
    if (!copies) copiesByParent.set(parent, (copies = installedCopies(packages, parent)));
    const covered = (version) =>
      keysOf(parent).some((k) => {
        const spec = overrideKeySpec(k);
        return spec != null && semver.validRange(spec) && semver.satisfies(version, spec);
      });
    let fits = i.safeCandidates;
    for (const copy of copies) {
      if (copy.version === parentVersion || covered(copy.version)) continue;
      if (!copy.ranges.some((r) => !semver.validRange(r) || semver.intersects(r, parentVersion))) continue;
      const range = declaredRangeFor(packages[copy.path], name);
      if (range == null) continue;
      const resolved = resolveInstalledPath(packages, copy.path, name);
      const floor = resolved ? packages[resolved].version : null;
      fits = fits.filter((v) => semver.validRange(range) && semver.satisfies(v, range) && (!floor || semver.gte(v, floor)));
      if (fits.length === 0) {
        i.pinRefusal = { kind: 'reaches', copy: `${parent}@${copy.version}` };
        break;
      }
    }
    if (!i.pinRefusal && fits !== i.safeCandidates) {
      i.safeCandidates = fits;
      i.bestSafeInRange = fits[fits.length - 1];
    }
  }
}

// Refuse, up front, each scoped pin npm would ignore or reject (the rules are in
// override-keys.js). A pin is checked against the overrides already in
// package.json, the root's own dependencies, and this package's other pins at
// their default versions, keyed exactly as the writer will key them. A refused
// instance records why as `pinRefusal`, which makes it unpinnable. The tool used
// to write such pins: npm then either ignored them while the tool reported them
// applied, or failed the install.
function markPinRefusals(name, instances, overrides, packages) {
  const existing = overrides && typeof overrides === 'object' ? overrides : {};
  const keysOf = (parent) => Object.keys(existing).filter((k) => overrideKeyName(k) === parent);
  const bucketOf = (key) => (existing[key] && typeof existing[key] === 'object' ? existing[key] : {});

  if (packages) limitToCopiesReached(name, instances, keysOf, packages);

  const pins = instances
    .filter((i) => i.parentName != null && isPinnableInstance(i))
    .map((i) => ({ i, key: parentOverrideKey(instances, i), version: i.safeCandidates[defaultScopedChoiceIndex(i)] }));

  // Refusals that hold whatever else gets staged: the key's form clashes with an
  // existing one, or npm would fail the install.
  for (const pin of pins) {
    const parent = pin.i.parentName;
    const bare = pin.key === parent;
    const otherForm = keysOf(parent).find((k) => (k === parent) !== bare);
    if (otherForm) {
      pin.i.pinRefusal = { kind: 'shadowed', by: otherForm };
      continue;
    }
    const rootSpec = packages && packages[''] ? declaredRangeFor(packages[''], parent) : null;
    if (!bare && risksEoverride(pin.key, { ...bucketOf(pin.key), [name]: pin.version }, rootSpec)) {
      pin.i.pinRefusal = { kind: 'eoverride', key: pin.key, name: parent, rootSpec };
    }
  }

  // Qualified keys for one parent, existing or about to be written, must
  // conflict pairwise. Pins that would leave two of them compatible are refused
  // together — npm would keep only one of them, and can't be told which.
  const live = pins.filter((p) => !p.i.pinRefusal && p.key !== p.i.parentName);
  for (const pin of live) {
    const parent = pin.i.parentName;
    const layout = new Map(keysOf(parent).filter((k) => k !== parent).map((k) => [k, bucketOf(k)]));
    for (const p of live) {
      if (p.i.parentName === parent) layout.set(p.key, { ...(layout.get(p.key) || {}), [name]: p.version });
    }
    const mine = layout.get(pin.key);
    for (const [key, bucket] of layout) {
      if (key === pin.key || overrideBucketsConflict(mine, bucket)) continue;
      // Say which side the other key is on. A pin this run proposes isn't in
      // package.json yet, and naming it like an existing key sent the user
      // looking for one that wasn't there. Two proposed pins for `name` that
      // don't conflict pin the same version.
      pin.i.pinRefusal = live.some((p) => p.key === key)
        ? { kind: 'shadowed', by: key, proposed: true, key: pin.key, name, version: pin.version }
        : { kind: 'shadowed', by: key };
      break;
    }
  }
}

/**
 * Overrides the manifest mandates that the installed tree does not reflect.
 *
 * npm applies `overrides` during resolution, so an override added *after* its
 * lockfile entry was resolved can sit in package.json with no effect: the entry
 * still satisfies its parent's declared range, and npm does not revisit it. The
 * audit then reads the un-overridden version out of the lockfile and flags it,
 * while the pin the user would write is already present — so accepting the fix
 * writes nothing and the tool reports "no changes". Detecting the contradiction
 * is what lets us say so instead.
 *
 * Verified against npm 11.13.0 (docs/2026-08-26-spike-reresolve.md): this state
 * only persists in *workspace* projects. A standalone project applies the new
 * mandate on its next `npm install`, so callers scope the warning accordingly.
 *
 * Returns Map<topLevelOverrideKey, { mandates: [{ name, mandated, found }] }>,
 * keyed so `collectRemovableOverrides` can gate on it directly. `found` lists
 * the offending edges: { parentName, parentVersion, path, installedVersion }.
 */
function unappliedOverrides(packages, overrides) {
  const out = new Map();
  if (!packages || !overrides || typeof overrides !== 'object') return out;

  // One pass over the tree, because the naive form rescans `packages` per
  // override key — O(overrides × tree) on exactly the projects big enough to
  // have both. Skips the "" root, and any entry with no `version` of its own:
  // a workspace link is versionless, and comparing `undefined` to a mandate
  // would invent a finding for every workspace in the project.
  const pathsByName = new Map();
  for (const [pkgPath, info] of Object.entries(packages)) {
    if (!pkgPath || !info || typeof info !== 'object' || !info.version || info.link) continue;
    const name = nameFromLockPath(pkgPath);
    if (!name) continue;
    let paths = pathsByName.get(name);
    if (!paths) pathsByName.set(name, (paths = []));
    paths.push(pkgPath);
  }

  const add = (key, name, mandated, found) => {
    if (found.length === 0) return;
    let entry = out.get(key);
    if (!entry) out.set(key, (entry = { mandates: [] }));
    entry.mandates.push({ name, mandated, found });
  };

  // A top-level pin governs every copy of the package.
  const checkTopLevel = (key, name, pin) => {
    const found = [];
    for (const pkgPath of pathsByName.get(name) || []) {
      const installedVersion = versionAt(packages, pkgPath);
      if (installedVersion !== pin) {
        found.push({ parentName: null, parentVersion: null, path: pkgPath, installedVersion });
      }
    }
    add(key, name, pin, found);
  };

  // A scoped pin governs only the edges leaving that parent. The parent key is
  // also the entry's identity, so it doubles as the map key.
  const checkScoped = (parentKey, name, pin) => {
    const parent = splitParentKey(parentKey);
    const found = [];
    for (const parentPath of pathsByName.get(parent.name) || []) {
      const info = packages[parentPath];
      if (parent.version && info.version !== parent.version) continue;
      if (declaredRangeFor(info, name) == null) continue;
      const resolved = resolveInstalledPath(packages, parentPath, name);
      if (!resolved) continue;
      const installedVersion = versionAt(packages, resolved);
      if (installedVersion !== pin) {
        found.push({
          parentName: parent.name,
          parentVersion: versionAt(packages, parentPath),
          path: resolved,
          installedVersion,
        });
      }
    }
    add(parentKey, name, pin, found);
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      // "$pkg" defers to the project's own declared range; there is no version
      // to compare against.
      if (value.startsWith('$')) continue;
      const name = bareOverrideKeyName(key);
      if (name) checkTopLevel(key, name, value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [childName, pin] of Object.entries(value)) {
      if (typeof pin !== 'string' || pin.startsWith('$')) continue;
      if (childName === '.') {
        // A self-pin sharing its key with nested children — same reach as a
        // top-level pin.
        const name = bareOverrideKeyName(key);
        if (name) checkTopLevel(key, name, pin);
        continue;
      }
      const name = bareOverrideKeyName(childName);
      if (name) checkScoped(key, name, pin);
    }
  }

  return out;
}

// Build the per-parent picture of where a vulnerable package is installed:
// every dependent, the version its edge resolves to, whether that version is
// vulnerable, and the safe versions its declared range could accept without a
// downgrade. `publishedSafe` is every published non-vulnerable version (NOT
// gated to the global reference — each parent gets targets relative to its own
// installed version). A parent of `null` means the root project (a direct
// dependency), whose pin is top-level rather than nested.
//
// A workspace manifest (a lockfile path like `packages/foo`) also has no
// `node_modules/` segment, so its edges surface as null-parent (root-like)
// instances — correct for the common case, where npm hoists a shared version and
// a single top-level pin fixes every workspace. npm `overrides` are root-global
// and cannot give two workspaces *different* versions of the same direct
// dependency, so when manifests disagree on the declared range there is no
// pin to offer at all: mergeInstancesByOverrideKey flags that group and
// `pinConflict` refuses `o` on the row. Documented in the README's Workspaces
// section.
//
// Known limitation: a `file:` local dependency's link target is a lockfile path
// with no `node_modules/` segment too, so it also lands here as root-like. That
// is why the *conflict* check consults the discovered manifest set rather than
// the path — but the instance itself still merges with the root, so a
// divergent-range local dependency can still take a pin aimed at the root. The
// fix is to classify a non-manifest, non-`node_modules` path as a named parent
// (its own `overrides` key) instead of a root edge.
function collectPinInstances(packages, name, advisoryList, publishedSafe) {
  const instances = [];
  for (const [parentPath, info] of Object.entries(packages || {})) {
    if (!info || typeof info !== 'object') continue;
    const declaredRange = declaredRangeFor(info, name);
    if (declaredRange == null) continue;
    const resolvedPath = resolveInstalledPath(packages, parentPath, name);
    const installedVersion = resolvedPath ? packages[resolvedPath].version : null;
    if (!installedVersion) continue;
    // Safe versions this parent could take: in its declared range and not a
    // downgrade from what it already has, newest last.
    const safeCandidates = semver.validRange(declaredRange)
      ? publishedSafe.filter((v) => semver.satisfies(v, declaredRange) && semver.gte(v, installedVersion))
      : [];
    instances.push({
      parentName: parentPath === '' ? null : nameFromLockPath(parentPath),
      parentPath,
      parentVersion: info.version || null,
      declaredRange,
      installedVersion,
      vulnerable: matchesAny(installedVersion, advisoryList),
      safeCandidates,
      bestSafeInRange: safeCandidates.length ? safeCandidates[safeCandidates.length - 1] : null,
    });
  }
  return instances;
}

// Decide whether one global override suffices or per-parent scoped pins are
// needed. A global pin forces *every* instance to one version, so it's only
// safe when there's a single installed version, or when every instance is
// vulnerable and one safe version satisfies all their declared ranges without
// downgrading any of them. If any instance is already safe (a global pin would
// disturb it) or the vulnerable instances need different safe versions, we go
// scoped.
function decidePinStrategy(instances, publishedSafe) {
  if (instances.length === 0) return 'global';
  if (new Set(instances.map((i) => i.installedVersion)).size <= 1) return 'global';
  if (instances.some((i) => !i.vulnerable)) return 'scoped';
  const universal = publishedSafe.find((v) =>
    instances.every(
      (i) =>
        semver.validRange(i.declaredRange) &&
        semver.satisfies(v, i.declaredRange) &&
        semver.gte(v, i.installedVersion)
    )
  );
  return universal ? 'global' : 'scoped';
}

// A grouping key standing for the npm `overrides` entry an instance would be
// written under: a top-level pin for a direct dependency, else the parent (later
// qualified by version when a parent name spans several versions). Two instances
// that share this key are a single addressable pin — npm can't force one copy of
// parent@version to a different child version than another copy of the *same*
// parent@version. The key never leaves this module; "#" is only a separator that
// can't appear in a package name (the written keys come from writeOverrideSpec).
function overrideKeyOf(i) {
  return i.parentName == null ? '#root' : `${i.parentName}#${i.parentVersion ?? ''}`;
}

// Collapse instances that resolve to the same override key into one decision.
// This is what keeps the picker (and the written overrides) honest: several
// installed copies of the exact same parent@version can't be pinned separately,
// so they become one row pinned to a single version that fixes every vulnerable
// copy without downgrading any of them. Instances with distinct keys (including
// the same parent name at *different* versions) are left untouched.
function mergeInstancesByOverrideKey(instances, manifestPaths) {
  const groups = new Map();
  for (const i of instances) {
    const key = overrideKeyOf(i);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(i);
  }
  const merged = [];
  for (const copies of groups.values()) {
    if (copies.length === 1) {
      merged.push(copies[0]);
      continue;
    }
    // Merging is only sound when the copies agree on the declared range: that
    // assumption is what lets us union their candidate lists and keep one
    // copy's range on the result. Manifests in the same project (the root and
    // each workspace) share the '#root' key while declaring whatever they like,
    // so a group spanning several manifests with different ranges has no single
    // honest pin — one npm `overrides` entry can't give two workspaces
    // different versions. Flag it and offer nothing rather than writing a
    // version that satisfies only one of them.
    //
    // The copies must be *known* project manifests, not merely lockfile paths
    // that look like one: a `file:` local dependency produces the same shape
    // (see isManifestPath in lockfile.js). Without the discovered set we can't
    // tell, so we don't claim a conflict — that keeps a single-package project
    // on exactly its pre-workspaces behavior.
    const conflictingPaths = new Set(copies.map((c) => c.parentPath));
    const conflict =
      new Set(copies.map((c) => c.declaredRange)).size > 1 &&
      conflictingPaths.size > 1 &&
      !!manifestPaths &&
      [...conflictingPaths].filter((p) => manifestPaths.has(p)).length > 1;
    // Pin no lower than the highest installed copy so none is downgraded, and
    // only to a version safe for every copy.
    const floor = maxVersion(copies.map((c) => c.installedVersion));
    const candidateSet = new Set();
    if (!conflict) for (const c of copies) for (const v of c.safeCandidates || []) candidateSet.add(v);
    const safeCandidates = [...candidateSet]
      .filter((v) => !floor || semver.gte(v, floor))
      .sort(semver.compare);
    merged.push({
      ...copies[0],
      installedVersion: floor,
      vulnerable: copies.some((c) => c.vulnerable),
      conflict,
      // What the conflicting manifests each declare, for the row's explanation.
      conflictRanges: conflict ? [...new Set(copies.map((c) => c.declaredRange))] : undefined,
      safeCandidates,
      bestSafeInRange: safeCandidates.length ? safeCandidates[safeCandidates.length - 1] : null,
    });
  }
  return merged;
}

function advisoryUrl(advisory) {
  if (advisory && advisory.url) return advisory.url;
  if (advisory && advisory.github_advisory_id) {
    return `https://github.com/advisories/${advisory.github_advisory_id}`;
  }
  return null;
}

// Decide which existing overrides are safe to drop from the resolved override
// info. A 'dead' override (nothing in the tree depends on it) needs no advisory
// data; a 'redundant' one is only flagged when we could reach the advisories
// (`ok`) and resolve every version its dependents would fall back to. We never
// flag when we couldn't check or resolve, to avoid suggesting the removal of an
// override that's still protecting the tree.
function collectRemovableOverrides(overrideInfo, ok, advisories, unapplied) {
  const removable = new Map();
  for (const [name, info] of overrideInfo) {
    // An override the tree never applied can't be judged by looking at the tree.
    // Both verdicts below ask "what would happen without this override?" and
    // read the answer off the installed versions — but those versions are what
    // resolution produced *ignoring* this pin, so 'dead' and 'redundant' are
    // both unsound here. Never offer to delete a pin whose effect we can't see.
    if (unapplied && unapplied.has(name)) continue;
    if (info.reason === 'dead') {
      removable.set(name, { pin: info.pin, reason: 'dead' });
      continue;
    }
    if (!ok || !info.resolvable || info.candidates.length === 0) continue;
    const adv = advisories.get(name) || [];
    const stillVulnerable = info.candidates.some((v) => matchesAny(v, adv));
    if (!stillVulnerable) removable.set(name, { pin: info.pin, reason: 'redundant' });
  }
  return removable;
}

// Existing `overrides` entries that pin `name` somewhere a fix can't land, as
// [{ key, pin }]: a top-level pin (a string, or the "." of an object), or a pin
// one level down under a parent key, the only depths the writer uses. Each
// counts unless it resolves to a verified-safe version. A scoped pin holding a
// vulnerable version used to go unnamed: the row said no fix was possible while
// the user's own override was what held it in place (the 2026-10-17 field
// report, F1). Not matched to edges, since npm matches a key by declared range,
// not by installed version (docs/2026-10-11-spike-override-keys.md, Finding 4).
// Null when some entry can't be judged: a "$" reference, or `name` nested deeper.
function unsafePinsOf(overrides, name, isSafe) {
  if (!overrides || typeof overrides !== 'object') return [];
  const pins = [];
  let unreadable = false;
  const consider = (key, pin) => {
    if (typeof pin !== 'string') return;
    if (pin.startsWith('$')) unreadable = true;
    else if (!isSafe(pin)) pins.push({ key, pin });
  };
  const mentions = (value) =>
    !!value && typeof value === 'object' &&
    Object.entries(value).some(([k, v]) => overrideKeyName(k) === name || mentions(v));
  for (const [key, value] of Object.entries(overrides)) {
    const self = overrideKeyName(key) === name;
    if (typeof value === 'string') {
      if (self) consider(key, value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (self) consider(key, value['.']);
    for (const [child, pin] of Object.entries(value)) {
      if (child === '.') continue;
      if (overrideKeyName(child) === name) {
        if (typeof pin === 'string') consider(key, pin);
        else unreadable = true;
      } else if (mentions(pin)) {
        unreadable = true;
      }
    }
  }
  return unreadable ? null : pins;
}

/**
 * Given the direct descriptors and the installed tree (from the lockfile),
 * check every relevant version against npm's advisory database.
 *
 * @returns {Promise<{ offline, vulns, removableOverrides, unappliedOverrides }>}
 *   Each vuln entry: { advisories, severity, cve, url, affectedRange,
 *   firstPatched, safeVersions, instances, pinStrategy, pinConflict,
 *   inRangeFix, heldBy }.
 *   `removableOverrides` maps an existing `overrides` package name ->
 *   { pin, reason: 'dead' | 'redundant' }.
 *   `unappliedOverrides` maps an `overrides` key -> { mandates } for pins the
 *   installed tree does not reflect (see `unappliedOverrides` above).
 */
export async function computeVulnerabilities(
  { descriptors = [], installed = null, overrides = {}, manifestPaths = null } = {},
  deps = {}
) {
  // Which lockfile entries are this project's own manifests. Only a real
  // multi-manifest project can produce an unpinnable cross-manifest conflict.
  const manifestSet = manifestPaths ? new Set(manifestPaths) : null;
  // Registry collaborators are injectable so this decision logic can be unit
  // tested against fixed advisory/metadata fixtures instead of the live npm API.
  const getMeta = deps.fetchPackageMeta || fetchPackageMeta;
  const getAdvisories = deps.fetchBulkAdvisories || fetchBulkAdvisories;

  // Two version sets with different jobs. `versionsByName` is what the project
  // actually has — the installed tree, plus whatever each direct range resolves
  // to — and it alone decides which packages get flagged. `probeVersions` holds
  // the counterfactual "what would install if this override were removed"
  // versions, which exist only to judge whether an existing override still earns
  // its keep. Both are queried for advisories; only the first can flag.
  //
  // Keeping them apart is the point: a package you have correctly pinned to a
  // safe version is not vulnerable, however bad the version its dependents would
  // fall back to. Merged, it would resurface in "Override to a safe version"
  // labelled with a version installed nowhere in the tree.
  const versionsByName = {};
  const probeVersions = {};
  const adder = (bucket) => (name, version) => {
    if (!version) return;
    if (!bucket[name]) bucket[name] = new Set();
    bucket[name].add(version);
  };
  const add = adder(versionsByName);
  const addProbe = adder(probeVersions);

  // Installed versions across the whole tree (direct + transitive).
  if (installed && installed.versions) {
    for (const [name, set] of installed.versions) {
      for (const v of set) add(name, v);
    }
  }

  // Also check the version each direct range currently resolves to, in case a
  // range points at a vulnerable version that isn't installed yet.
  await mapWithConcurrency(descriptors, CONCURRENCY, async (d) => {
    if (!d.range || !semver.validRange(d.range)) return;
    const meta = await getMeta(d.name);
    if (!meta) return;
    const best = semver.maxSatisfying(meta.versions, d.range, { includePrerelease: false });
    if (best) add(d.name, best);
  });

  // Which overrides the tree never applied. Computed before the removability
  // pass because it gates it: an unapplied pin must never be offered for
  // deletion. Cheap and offline — it reads the lockfile the caller already
  // loaded, with no registry involvement.
  const unapplied = unappliedOverrides(installed && installed.packages, overrides);

  // Only bare top-level names are understood by requiredRangesFor. A qualified
  // key ("pkg@^1") is a selector, not a dependency name: looking it up verbatim
  // would misclassify an active pin as dead. Leave these entries untouched until
  // removability can evaluate selector intersections.
  const overrideEntries = Object.entries(overrides || {}).filter(
    ([name, pin]) => bareOverrideKeyName(name) && typeof pin === 'string' && !pin.startsWith('$')
  );
  const overrideInfo = new Map();
  await mapWithConcurrency(overrideEntries, CONCURRENCY, async ([name, pin]) => {
    // Without a lockfile we can't see the tree, so we can't conclude the
    // override is unneeded — leave it unresolvable rather than guess 'dead'.
    if (!installed || !installed.packages) {
      overrideInfo.set(name, { pin, candidates: [], resolvable: false });
      return;
    }
    const ranges = requiredRangesFor(installed.packages, name);
    if (ranges.length === 0) {
      // Nothing in the tree depends on it anymore — the override is dead weight.
      overrideInfo.set(name, { pin, reason: 'dead', candidates: [], resolvable: true });
      return;
    }
    const meta = await getMeta(name);
    if (!meta) {
      overrideInfo.set(name, { pin, ranges, candidates: [], resolvable: false });
      return;
    }
    const candidates = [];
    let resolvable = true;
    for (const r of ranges) {
      const best = newestInRange(meta.versions, r);
      if (best) candidates.push(best);
      else resolvable = false;
    }
    for (const c of candidates) addProbe(name, c);
    overrideInfo.set(name, { pin, ranges, candidates, resolvable });
  });

  // The advisory query spans both sets — an override's fallback versions still
  // need checking when nothing real is left to flag, which is exactly the case
  // for a project whose only finding is an override that has outlived its need.
  const queryVersions = mergeVersionSets(versionsByName, probeVersions);

  if (Object.keys(queryVersions).length === 0) {
    // Nothing to check for vulnerabilities, but a 'dead' override needs no
    // advisory data — still surface it instead of silently dropping it.
    return {
      offline: false,
      vulns: new Map(),
      removableOverrides: collectRemovableOverrides(overrideInfo, false, new Map(), unapplied),
      unappliedOverrides: unapplied,
    };
  }

  const { ok, advisories } = await getAdvisories(queryVersions);

  const vulnNames = [...advisories.keys()].filter((name) => {
    const versions = versionsByName[name] ? [...versionsByName[name]] : [];
    return versions.some((v) => matchesAny(v, advisories.get(name)));
  });

  // The bulk endpoint returns only advisories affecting a submitted version.
  // A fix for the current advisory can have a different advisory of its own,
  // so audit candidate versions too before calling them safe. Keep this query
  // separate: candidate-only advisories must not flag the installed tree.
  const candidatesByName = {};
  const publishedByName = {};
  await mapWithConcurrency(vulnNames, CONCURRENCY, async (name) => {
    const meta = await getMeta(name);
    if (!meta) return;
    publishedByName[name] = meta.versions;
    const candidates = meta.versions
      .filter((v) => semver.valid(v) && !semver.prerelease(v))
      .filter((v) => !matchesAny(v, advisories.get(name)))
      .sort(semver.compare);
    if (candidates.length > 0) candidatesByName[name] = candidates;
  });
  const { ok: candidatesOk, advisories: candidateAdvisories } = Object.keys(candidatesByName).length > 0
    ? await getAdvisories(candidatesByName)
    : { ok: true, advisories: new Map() };

  const vulns = new Map();
  await mapWithConcurrency(vulnNames, CONCURRENCY, async (name) => {
    const list = advisories.get(name);
    const versions = versionsByName[name] ? [...versionsByName[name]] : [];
    const flagged = versions.filter((v) => matchesAny(v, list));
    if (flagged.length === 0) return;

    // Keep only advisories that actually affect a version we have/resolve to.
    const matching = list.filter((a) => flagged.some((v) => satisfiesAdvisory(v, a)));

    // Worst severity across matching advisories drives the label + primary link.
    let severity = 'low';
    let primary = matching[0] || list[0];
    for (const a of matching) {
      const s = (a.severity || 'low').toLowerCase();
      if (severityRank(s) > severityRank(severity)) {
        severity = s;
        primary = a;
      }
    }
    if (!SEVERITY[severity]) severity = 'low';

    // Verified candidates are ungated by version here: each parent needs fixes
    // relative to its own installed version. If any candidate query failed,
    // fail closed rather than offer unverified versions from a partial result.
    const reference = maxVersion(flagged);
    const publishedSafe = candidatesOk
      ? (candidatesByName[name] || []).filter((v) => !matchesAny(v, candidateAdvisories.get(name) || []))
      : [];
    // The global picker still only offers versions at or above the newest one we
    // currently have anywhere in the tree.
    const safeVersions = reference ? publishedSafe.filter((v) => semver.gte(v, reference)) : publishedSafe;

    let firstPatched = safeVersions.length > 0 ? safeVersions[0] : null;
    // Only fall back to an advisory's promised fix when no candidates were
    // available to verify. Do not advertise one we just rejected via another
    // advisory (or failed to verify).
    if (
      candidatesOk && !candidatesByName[name] && !firstPatched &&
      primary && primary.patched_versions && primary.patched_versions !== '<0.0.0'
    ) {
      try {
        const mv = semver.minVersion(primary.patched_versions);
        if (mv) firstPatched = mv.version;
      } catch {
        // no derivable fix
      }
    }

    // Map out where this package is installed across the tree so the UI can
    // choose between one global pin and per-parent scoped pins. Without a
    // lockfile there's no tree to inspect, so fall back to the global path.
    const rawInstances =
      installed && installed.packages ? collectPinInstances(installed.packages, name, list, publishedSafe) : [];
    // Strategy is decided from the full picture; the picker/serialization then
    // work off instances collapsed by override key, so copies of the same
    // parent@version become one pin instead of colliding.
    const pinStrategy = decidePinStrategy(rawInstances, publishedSafe);
    const instances = mergeInstancesByOverrideKey(rawInstances, manifestSet);
    markPinRefusals(name, instances, overrides, installed && installed.packages);

    // Would re-resolving fix every copy with no override at all? Each
    // dependent's newest in-range version must be verified safe and no
    // downgrade. `npm update` moves already-safe copies too, so they count.
    // This is the question collectRemovableOverrides asks of a pin, asked
    // before one is written (the 2026-10-17 field report, F2).
    const published = publishedByName[name] || [];
    const safeSet = new Set(publishedSafe);
    const inRangeFix =
      rawInstances.length > 0 &&
      rawInstances.every((i) => {
        const newest = newestInRange(published, i.declaredRange);
        return !!newest && safeSet.has(newest) && !!semver.valid(i.installedVersion) && semver.gte(newest, i.installedVersion);
      });

    vulns.set(name, {
      advisories: matching,
      severity,
      cve: advisoryCve(primary),
      url: advisoryUrl(primary),
      affectedRange: (primary && primary.vulnerable_versions) || '',
      // Newest version we currently have that's still vulnerable — the "current"
      // side of the current → fixed pair the override rows render.
      current: reference,
      firstPatched,
      safeVersions,
      instances,
      pinStrategy,
      // No pin is expressible: two manifests in this project declare different
      // ranges for the same package and npm honors `overrides` only at the
      // root. `o` is refused entirely — including the global path, which would
      // otherwise rewrite whichever manifest happens to declare it directly.
      pinConflict: instances.some((i) => i.conflict),
      inRangeFix,
      // The user's own overrides that pin this package where no fix lands, or
      // null when they can't be judged (unverified candidates included).
      heldBy: candidatesOk ? unsafePinsOf(overrides, name, (pin) => safeSet.has(newestInRange(published, pin))) : null,
    });
  });

  return {
    offline: !ok || !candidatesOk,
    vulns,
    removableOverrides: collectRemovableOverrides(overrideInfo, ok, advisories, unapplied),
    unappliedOverrides: unapplied,
  };
}
