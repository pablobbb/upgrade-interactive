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
 * @returns {Promise<{ offline: boolean, vulns: Map<string, object> }>}
 *   Each vuln entry: { advisories, severity, isDirect, cve, url, affectedRange,
 *   firstPatched, safeVersions }.
 */
export async function computeVulnerabilities({ descriptors = [], installed = null } = {}) {
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
    const meta = await fetchPackageMeta(d.name);
    if (!meta) return;
    const best = semver.maxSatisfying(meta.versions, d.range, { includePrerelease: false });
    if (best) add(d.name, best);
  });

  if (Object.keys(versionsByName).length === 0) {
    return { offline: false, vulns: new Map() };
  }

  const { ok, advisories } = await fetchBulkAdvisories(versionsByName);

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
    const meta = await fetchPackageMeta(name);
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

  return { offline: !ok, vulns };
}
