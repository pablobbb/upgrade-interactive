// Turns raw npm advisory data into a per-package vulnerability summary the UI
// can render, plus the list of safe versions the override picker offers.

import semver from 'semver';
import { fetchPackageMeta, fetchBulkAdvisories, mapWithConcurrency } from './registry.js';

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

/** Highest valid semver in a list, or null. */
function maxVersion(list) {
  let max = null;
  for (const v of list) {
    if (!semver.valid(v)) continue;
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

// Build the per-parent picture of where a vulnerable package is installed:
// every dependent, the version its edge resolves to, whether that version is
// vulnerable, and the safe versions its declared range could accept without a
// downgrade. `publishedSafe` is every published non-vulnerable version (NOT
// gated to the global reference — each parent gets targets relative to its own
// installed version). A parent of `null` means the root project (a direct
// dependency), whose pin is top-level rather than nested.
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
function collectRemovableOverrides(overrideInfo, ok, advisories) {
  const removable = new Map();
  for (const [name, info] of overrideInfo) {
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

/**
 * Given the direct descriptors and the installed tree (from the lockfile),
 * check every relevant version against npm's advisory database.
 *
 * @returns {Promise<{ offline, vulns, removableOverrides }>}
 *   Each vuln entry: { advisories, severity, isDirect, cve, url, affectedRange,
 *   firstPatched, safeVersions }. `removableOverrides` maps an existing
 *   `overrides` package name -> { pin, reason: 'dead' | 'redundant' }.
 */
export async function computeVulnerabilities(
  { descriptors = [], installed = null, overrides = {} } = {},
  deps = {}
) {
  // Registry collaborators are injectable so this decision logic can be unit
  // tested against fixed advisory/metadata fixtures instead of the live npm API.
  const getMeta = deps.fetchPackageMeta || fetchPackageMeta;
  const getAdvisories = deps.fetchBulkAdvisories || fetchBulkAdvisories;

  const versionsByName = {};
  const add = (name, version) => {
    if (!version) return;
    if (!versionsByName[name]) versionsByName[name] = new Set();
    versionsByName[name].add(version);
  };

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

  // For each existing top-level override, work out what version(s) would be
  // installed *without* it, so we can tell whether it's still doing anything.
  const overrideEntries = Object.entries(overrides || {}).filter(
    ([, pin]) => typeof pin === 'string' && !pin.startsWith('$')
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
      if (!semver.validRange(r)) {
        resolvable = false;
        continue;
      }
      const best = semver.maxSatisfying(meta.versions, r, { includePrerelease: false });
      if (best) candidates.push(best);
      else resolvable = false;
    }
    for (const c of candidates) add(name, c);
    overrideInfo.set(name, { pin, ranges, candidates, resolvable });
  });

  if (Object.keys(versionsByName).length === 0) {
    // Nothing to check for vulnerabilities, but a 'dead' override needs no
    // advisory data — still surface it instead of silently dropping it.
    return {
      offline: false,
      vulns: new Map(),
      removableOverrides: collectRemovableOverrides(overrideInfo, false, new Map()),
    };
  }

  const { ok, advisories } = await getAdvisories(versionsByName);

  const directSet = new Set(descriptors.map((d) => d.name));
  if (installed && installed.direct) for (const n of installed.direct) directSet.add(n);

  const vulnNames = [...advisories.keys()].filter((name) => {
    const versions = versionsByName[name] ? [...versionsByName[name]] : [];
    return versions.some((v) => matchesAny(v, advisories.get(name)));
  });

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

    // Every published version affected by none of the matching advisories,
    // ungated — the per-parent instance analysis needs targets relative to each
    // parent's own installed version, not the whole tree's newest.
    const reference = maxVersion(flagged);
    let publishedSafe = [];
    const meta = await getMeta(name);
    if (meta) {
      publishedSafe = meta.versions
        .filter((v) => semver.valid(v) && !semver.prerelease(v))
        .filter((v) => !matchesAny(v, matching))
        .sort(semver.compare);
    }
    // The global picker still only offers versions at or above the newest one we
    // currently have anywhere in the tree.
    const safeVersions = reference ? publishedSafe.filter((v) => semver.gte(v, reference)) : publishedSafe;

    let firstPatched = safeVersions.length > 0 ? safeVersions[0] : null;
    if (!firstPatched && primary && primary.patched_versions && primary.patched_versions !== '<0.0.0') {
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
    const instances =
      installed && installed.packages ? collectPinInstances(installed.packages, name, list, publishedSafe) : [];
    const pinStrategy = decidePinStrategy(instances, publishedSafe);

    vulns.set(name, {
      advisories: matching,
      severity,
      isDirect: directSet.has(name),
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
    });
  });

  return { offline: !ok, vulns, removableOverrides: collectRemovableOverrides(overrideInfo, ok, advisories) };
}
