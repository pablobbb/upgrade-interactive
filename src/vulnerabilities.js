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

function advisoryUrl(advisory) {
  if (advisory && advisory.url) return advisory.url;
  if (advisory && advisory.github_advisory_id) {
    return `https://github.com/advisories/${advisory.github_advisory_id}`;
  }
  return null;
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
    const ranges = installed && installed.packages ? requiredRangesFor(installed.packages, name) : [];
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
    return { offline: false, vulns: new Map(), removableOverrides: new Map() };
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

    // Safe versions = published versions affected by none of the matching
    // advisories, at or above the newest version we currently have.
    const reference = maxVersion(flagged);
    let safeVersions = [];
    const meta = await getMeta(name);
    if (meta) {
      safeVersions = meta.versions
        .filter((v) => semver.valid(v) && !semver.prerelease(v))
        .filter((v) => !matchesAny(v, matching))
        .filter((v) => !reference || semver.gte(v, reference))
        .sort(semver.compare);
    }

    let firstPatched = safeVersions.length > 0 ? safeVersions[0] : null;
    if (!firstPatched && primary && primary.patched_versions && primary.patched_versions !== '<0.0.0') {
      try {
        const mv = semver.minVersion(primary.patched_versions);
        if (mv) firstPatched = mv.version;
      } catch {
        // no derivable fix
      }
    }

    vulns.set(name, {
      advisories: matching,
      severity,
      isDirect: directSet.has(name),
      cve: advisoryCve(primary),
      url: advisoryUrl(primary),
      affectedRange: (primary && primary.vulnerable_versions) || '',
      firstPatched,
      safeVersions,
    });
  });

  // An override is removable when nothing depends on the package anymore
  // ('dead'), or when — given we could reach the advisory data — every version
  // its dependents would resolve to without the override is non-vulnerable
  // ('redundant'). We never flag when we couldn't check or resolve, to avoid
  // suggesting the removal of an override that's still protecting the tree.
  const removableOverrides = new Map();
  for (const [name, info] of overrideInfo) {
    if (info.reason === 'dead') {
      removableOverrides.set(name, { pin: info.pin, reason: 'dead' });
      continue;
    }
    if (!ok || !info.resolvable || info.candidates.length === 0) continue;
    const adv = advisories.get(name) || [];
    const stillVulnerable = info.candidates.some((v) => matchesAny(v, adv));
    if (!stillVulnerable) removableOverrides.set(name, { pin: info.pin, reason: 'redundant' });
  }

  return { offline: !ok, vulns, removableOverrides };
}
