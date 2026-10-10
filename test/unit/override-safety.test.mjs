import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';
import { defaultOverrideSelection } from '../../src/override-select.js';

// Match the bulk endpoint: return only advisories affecting a submitted version.
// Returning every advisory for a name would hide missing candidate verification.
function registry(versions, advisories) {
  const requests = [];
  return {
    requests,
    fetchPackageMeta: async () => ({ versions, distTags: {} }),
    fetchBulkAdvisories: async (query) => {
      requests.push(Object.fromEntries(Object.entries(query).map(([n, vs]) => [n, [...vs]])));
      const found = new Map();
      for (const [name, vs] of Object.entries(query)) {
        const matching = advisories.filter((a) => [...vs].some((v) => semver.satisfies(v, a.vulnerable_versions)));
        if (matching.length) found.set(name, matching);
      }
      return { ok: true, advisories: found };
    },
  };
}

const currentAdvisory = { vulnerable_versions: '<1.1.0', severity: 'high', patched_versions: '>=1.1.0' };
const currentTree = {
  versions: new Map([['child', new Set(['1.0.0'])]]),
  packages: {
    '': { dependencies: { parent: '1.0.0' } },
    'node_modules/parent': { version: '1.0.0', dependencies: { child: '^1.0.0' } },
    'node_modules/child': { version: '1.0.0' },
  },
};

describe('override safety — candidate advisories', () => {
  it('excludes a candidate affected by an advisory absent from the current-version response', async () => {
    const deps = registry(['1.0.0', '1.1.0', '1.2.0', '2.0.0'], [
      currentAdvisory,
      { vulnerable_versions: '1.1.0', severity: 'critical' },
    ]);
    const { vulns } = await computeVulnerabilities({ installed: currentTree }, deps);
    const v = vulns.get('child');
    assert.deepEqual(v.safeVersions, ['1.2.0', '2.0.0']);
    assert.deepEqual(v.instances[0].safeCandidates, ['1.2.0']);
    assert.equal(v.firstPatched, '1.2.0');
    assert.equal(defaultOverrideSelection(v), '1.2.0');
    assert.equal(v.severity, 'high', 'candidate-only advisories must not change the installed warning');
    assert.deepEqual(v.advisories, [currentAdvisory]);
    assert.ok(deps.requests.some((q) => q.child?.includes('1.1.0')), 'the target itself must be audited');
  });

  it('retains the vulnerability but offers no pins when candidate verification fails', async () => {
    const deps = registry(['1.0.0', '1.1.0'], [currentAdvisory]);
    const getAdvisories = deps.fetchBulkAdvisories;
    deps.fetchBulkAdvisories = async (query) => {
      if ([...(query.child || [])].includes('1.1.0')) return { ok: false, advisories: new Map() };
      return getAdvisories(query);
    };
    const result = await computeVulnerabilities({ installed: currentTree }, deps);
    const v = result.vulns.get('child');
    assert.equal(result.offline, true);
    assert.equal(v.current, '1.0.0');
    assert.deepEqual(v.safeVersions, []);
    assert.deepEqual(v.instances[0].safeCandidates, []);
    assert.equal(v.firstPatched, null, 'do not label an unverified candidate fixed');
    assert.equal(defaultOverrideSelection(v), null);
  });

  it('does not advertise the first advisory\'s patch when every candidate has another advisory', async () => {
    const deps = registry(['1.0.0', '1.1.0'], [currentAdvisory, { vulnerable_versions: '1.1.0', severity: 'critical' }]);
    const { vulns } = await computeVulnerabilities({ installed: currentTree }, deps);
    const v = vulns.get('child');
    assert.deepEqual(v.safeVersions, []);
    assert.equal(v.firstPatched, null);
    assert.equal(defaultOverrideSelection(v), null);
  });
});
