// Unit tests for the vulnerability + removable-override decision logic.
//
// The registry collaborators (metadata + advisory lookups) are stubbed, so
// these tests are fully isolated from the network: fast, deterministic, and
// trustworthy. Each test follows Arrange / Act / Assert and checks one behavior.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';

// --- Test data builders ------------------------------------------------------

// A registry double: `meta` maps name -> { versions, distTags }; `advisories`
// maps name -> advisory[]. `ok:false` simulates a failed advisory lookup.
function stubRegistry({ meta = {}, advisories = {}, ok = true } = {}) {
  return {
    fetchPackageMeta: async (name) => (name in meta ? meta[name] : null),
    fetchBulkAdvisories: async (versionsByName) => {
      const found = new Map();
      for (const name of Object.keys(versionsByName)) {
        if (advisories[name]) found.set(name, advisories[name]);
      }
      return { ok, advisories: found };
    },
  };
}

function advisory(overrides = {}) {
  return {
    vulnerable_versions: '<1.0.0',
    severity: 'low',
    url: 'https://github.com/advisories/GHSA-test',
    cves: [],
    ...overrides,
  };
}

// An `installed` tree with one benign package, so tests exercise a realistic
// non-empty tree without every test having to spell one out.
function treeWith(extra = {}) {
  return {
    versions: new Map([['keep-alive', new Set(['1.0.0'])]]),
    direct: new Set(),
    packages: { '': {} },
    ...extra,
  };
}

// --- Vulnerability detection -------------------------------------------------

describe('computeVulnerabilities — detection', () => {
  it('flags an installed direct dependency whose version is vulnerable', async () => {
    const installed = {
      versions: new Map([['lodash', new Set(['4.17.11'])]]),
      direct: new Set(['lodash']),
      packages: {},
    };
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.11', '4.17.21'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19', severity: 'high' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);

    const v = vulns.get('lodash');
    assert.ok(v, 'lodash should be flagged');
    assert.equal(v.severity, 'high');
    assert.equal(v.isDirect, true);
    assert.equal(v.firstPatched, '4.17.21');
  });

  it('marks a vulnerable transitive dependency as not direct', async () => {
    const installed = {
      versions: new Map([['minimist', new Set(['1.2.0'])]]),
      direct: new Set(['some-cli']), // minimist is only transitive
      packages: {},
    };
    const registry = stubRegistry({
      meta: { minimist: { versions: ['1.2.0', '1.2.6'], distTags: {} } },
      advisories: { minimist: [advisory({ vulnerable_versions: '<1.2.6', severity: 'critical' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);

    assert.equal(vulns.get('minimist').isDirect, false);
  });

  it('reports the worst severity and its advisory when several match', async () => {
    const installed = {
      versions: new Map([['pkg', new Set(['1.0.0'])]]),
      direct: new Set(['pkg']),
      packages: {},
    };
    const registry = stubRegistry({
      meta: { pkg: { versions: ['1.0.0', '2.0.0'], distTags: {} } },
      advisories: {
        pkg: [
          advisory({ vulnerable_versions: '<2.0.0', severity: 'moderate' }),
          advisory({ vulnerable_versions: '<1.5.0', severity: 'critical', url: 'https://github.com/advisories/GHSA-crit' }),
        ],
      },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);

    const v = vulns.get('pkg');
    assert.equal(v.severity, 'critical');
    assert.equal(v.cve, 'GHSA-crit', 'the critical advisory should drive the primary link');
  });

  it('reports offline (and no vulns) when the advisory lookup fails', async () => {
    const installed = {
      versions: new Map([['pkg', new Set(['1.0.0'])]]),
      direct: new Set(['pkg']),
      packages: {},
    };
    const registry = stubRegistry({
      meta: { pkg: { versions: ['1.0.0'], distTags: {} } },
      ok: false,
    });

    const { offline, vulns } = await computeVulnerabilities({ installed }, registry);

    assert.equal(offline, true);
    assert.equal(vulns.size, 0);
  });

  it('returns empty results when there is nothing to check', async () => {
    const registry = stubRegistry();

    const res = await computeVulnerabilities({ descriptors: [], installed: null }, registry);

    assert.equal(res.offline, false);
    assert.equal(res.vulns.size, 0);
    assert.equal(res.removableOverrides.size, 0);
  });
});

// --- Removable-override analysis ---------------------------------------------

describe('computeVulnerabilities — removable overrides', () => {
  it("flags an override as 'dead' when nothing in the tree depends on it", async () => {
    const installed = treeWith({ packages: { '': {}, 'node_modules/unrelated': { version: '1.0.0' } } });
    const registry = stubRegistry();

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { leftpad: '1.3.0' }, installed },
      registry
    );

    assert.deepEqual(removableOverrides.get('leftpad'), { pin: '1.3.0', reason: 'dead' });
  });

  it("flags an override as 'redundant' when deps would now resolve to a safe version", async () => {
    const installed = treeWith({
      packages: { '': {}, 'node_modules/consumer': { version: '1.0.0', dependencies: { lodash: '^4.17.0' } } },
    });
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.11', '4.17.21'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19' })] },
    });

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { lodash: '4.17.21' }, installed },
      registry
    );

    assert.deepEqual(removableOverrides.get('lodash'), { pin: '4.17.21', reason: 'redundant' });
  });

  it('does NOT flag an override that is still preventing a vulnerable resolution', async () => {
    const installed = treeWith({
      packages: { '': {}, 'node_modules/consumer': { version: '1.0.0', dependencies: { lodash: '^4.17.0' } } },
    });
    // No non-vulnerable version is published, so removing the pin would regress.
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.11', '4.17.15'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19' })] },
    });

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { lodash: '4.17.21' }, installed },
      registry
    );

    assert.equal(removableOverrides.has('lodash'), false);
  });

  it('never flags a non-dead override when the advisory lookup failed', async () => {
    const installed = treeWith({
      packages: { '': {}, 'node_modules/consumer': { version: '1.0.0', dependencies: { lodash: '^4.17.0' } } },
    });
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.11', '4.17.21'], distTags: {} } },
      ok: false,
    });

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { lodash: '4.17.21' }, installed },
      registry
    );

    assert.equal(removableOverrides.has('lodash'), false);
  });

  it('still flags a dead override even when the advisory lookup failed', async () => {
    const installed = treeWith({ packages: { '': {}, 'node_modules/unrelated': { version: '1.0.0' } } });
    const registry = stubRegistry({ ok: false });

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { leftpad: '1.3.0' }, installed },
      registry
    );

    assert.equal(removableOverrides.get('leftpad').reason, 'dead');
  });

  it('does not flag when the override target metadata cannot be fetched', async () => {
    const installed = treeWith({
      packages: { '': {}, 'node_modules/consumer': { version: '1.0.0', dependencies: { ghost: '^1.0.0' } } },
    });
    const registry = stubRegistry({ meta: {} }); // getMeta('ghost') -> null

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { ghost: '1.0.0' }, installed },
      registry
    );

    assert.equal(removableOverrides.has('ghost'), false);
  });

  it('ignores overrides that reference another dependency ($-syntax)', async () => {
    const installed = treeWith();
    const registry = stubRegistry();

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { foo: '$foo' }, installed },
      registry
    );

    assert.equal(removableOverrides.has('foo'), false);
  });
});
