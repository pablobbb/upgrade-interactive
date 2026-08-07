// Unit tests for the vulnerability + removable-override decision logic.
//
// The registry collaborators (metadata + advisory lookups) are stubbed, so
// these tests are fully isolated from the network: fast, deterministic, and
// trustworthy. Each test follows Arrange / Act / Assert and checks one behavior.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';
import { defaultOverrideSelection, isPinBlocked } from '../../src/override-select.js';

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
    assert.equal(v.current, '4.17.11', 'the newest still-vulnerable installed version');
    assert.equal(v.firstPatched, '4.17.21');
  });

  it('flags a vulnerable transitive dependency the descriptors never mention', async () => {
    const installed = {
      versions: new Map([['minimist', new Set(['1.2.0'])]]),
      packages: {},
    };
    const registry = stubRegistry({
      meta: { minimist: { versions: ['1.2.0', '1.2.6'], distTags: {} } },
      advisories: { minimist: [advisory({ vulnerable_versions: '<1.2.6', severity: 'critical' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);

    const v = vulns.get('minimist');
    assert.ok(v, 'a package only present in the lockfile is still audited');
    assert.equal(v.severity, 'critical');
    assert.equal(v.firstPatched, '1.2.6');
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

// --- Pin-strategy / instance analysis (scoped overrides) ---------------------

describe('computeVulnerabilities — pin instances', () => {
  // dependency-a is vulnerable at 1.2 under pkg-a but installed safe at 0.4
  // under pkg-b (a version a global 1.3 pin would break). This is the case
  // scoped pins exist for.
  it('goes scoped when a safe instance would be disturbed by a global pin', async () => {
    const installed = {
      versions: new Map([['dependency-a', new Set(['1.2.0', '0.4.0'])]]),
      direct: new Set(['pkg-a', 'pkg-b']),
      packages: {
        '': { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } },
        'node_modules/pkg-a': { version: '1.0.0', dependencies: { 'dependency-a': '^1.2.0' } },
        'node_modules/pkg-b': { version: '1.0.0', dependencies: { 'dependency-a': '^0.4.0' } },
        'node_modules/dependency-a': { version: '1.2.0' }, // hoisted for pkg-a
        'node_modules/pkg-b/node_modules/dependency-a': { version: '0.4.0' }, // nested for pkg-b
      },
    };
    const registry = stubRegistry({
      meta: { 'dependency-a': { versions: ['0.4.0', '1.2.0', '1.3.0'], distTags: {} } },
      advisories: { 'dependency-a': [advisory({ vulnerable_versions: '>=1.0.0 <1.3.0', severity: 'high' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);
    const v = vulns.get('dependency-a');

    assert.equal(v.pinStrategy, 'scoped');
    const byParent = Object.fromEntries(v.instances.map((i) => [i.parentName, i]));
    assert.equal(byParent['pkg-a'].vulnerable, true);
    assert.equal(byParent['pkg-a'].bestSafeInRange, '1.3.0', 'the vulnerable instance can move to 1.3.0');
    assert.equal(byParent['pkg-b'].vulnerable, false, 'the 0.4.0 instance is already safe');
    assert.equal(byParent['pkg-b'].installedVersion, '0.4.0', 'nested resolution finds the right node');
  });

  it('stays global when every instance is vulnerable and one safe version fits all', async () => {
    const installed = {
      versions: new Map([['dependency-a', new Set(['1.2.0', '1.1.0'])]]),
      direct: new Set(['pkg-a', 'pkg-b']),
      packages: {
        '': { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } },
        'node_modules/pkg-a': { version: '1.0.0', dependencies: { 'dependency-a': '^1.2.0' } },
        'node_modules/pkg-b': { version: '1.0.0', dependencies: { 'dependency-a': '^1.1.0' } },
        'node_modules/dependency-a': { version: '1.2.0' },
        'node_modules/pkg-b/node_modules/dependency-a': { version: '1.1.0' },
      },
    };
    const registry = stubRegistry({
      meta: { 'dependency-a': { versions: ['1.1.0', '1.2.0', '1.3.0'], distTags: {} } },
      advisories: { 'dependency-a': [advisory({ vulnerable_versions: '>=1.0.0 <1.3.0', severity: 'high' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);

    assert.equal(vulns.get('dependency-a').pinStrategy, 'global');
  });

  it('goes scoped when vulnerable instances need different safe versions per major', async () => {
    const installed = {
      versions: new Map([['dependency-a', new Set(['2.5.0', '1.2.0'])]]),
      direct: new Set(['pkg-a', 'pkg-b']),
      packages: {
        '': { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } },
        'node_modules/pkg-a': { version: '1.0.0', dependencies: { 'dependency-a': '^2.0.0' } },
        'node_modules/pkg-b': { version: '1.0.0', dependencies: { 'dependency-a': '^1.0.0' } },
        'node_modules/dependency-a': { version: '2.5.0' },
        'node_modules/pkg-b/node_modules/dependency-a': { version: '1.2.0' },
      },
    };
    const registry = stubRegistry({
      // 1.2.0 and 2.5.0 are the only bad versions; each major has an in-range fix.
      meta: { 'dependency-a': { versions: ['1.2.0', '1.4.0', '2.5.0', '2.7.0'], distTags: {} } },
      advisories: { 'dependency-a': [advisory({ vulnerable_versions: '1.2.0 || 2.5.0', severity: 'high' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);
    const v = vulns.get('dependency-a');
    const byParent = Object.fromEntries(v.instances.map((i) => [i.parentName, i]));

    assert.equal(v.pinStrategy, 'scoped');
    assert.equal(byParent['pkg-a'].bestSafeInRange, '2.7.0');
    assert.equal(byParent['pkg-b'].bestSafeInRange, '1.4.0', 'the 1.x consumer gets an in-range 1.x fix, not a forced major bump');
  });

  it('stays global for a single installed version even across several dependents', async () => {
    const installed = {
      versions: new Map([['lodash', new Set(['4.17.11'])]]),
      direct: new Set(['pkg-a']),
      packages: {
        '': { dependencies: { 'pkg-a': '^1.0.0' } },
        'node_modules/pkg-a': { version: '1.0.0', dependencies: { lodash: '^4.0.0' } },
        'node_modules/pkg-b': { version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
        'node_modules/lodash': { version: '4.17.11' },
      },
    };
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.11', '4.17.21'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19', severity: 'high' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);

    assert.equal(vulns.get('lodash').pinStrategy, 'global');
  });

  it('collapses copies of the same parent@version into a single scoped decision', async () => {
    // pkg-a@1.0.0 is installed twice (different tree locations), each resolving
    // dependency-a to a different vulnerable version. npm can't pin those two
    // copies separately, so they must become one row. pkg-b keeps an unrelated
    // safe copy, which forces the overall strategy to scoped.
    const installed = {
      versions: new Map([['dependency-a', new Set(['1.2.0', '1.4.0', '0.4.0'])]]),
      direct: new Set(['pkg-a', 'pkg-b']),
      packages: {
        '': { dependencies: { x: '^1.0.0', y: '^1.0.0', 'pkg-b': '^1.0.0' } },
        'node_modules/x/node_modules/pkg-a': { version: '1.0.0', dependencies: { 'dependency-a': '^1.0.0' } },
        'node_modules/y/node_modules/pkg-a': { version: '1.0.0', dependencies: { 'dependency-a': '^1.0.0' } },
        'node_modules/x/node_modules/pkg-a/node_modules/dependency-a': { version: '1.2.0' },
        'node_modules/y/node_modules/pkg-a/node_modules/dependency-a': { version: '1.4.0' },
        'node_modules/pkg-b': { version: '1.0.0', dependencies: { 'dependency-a': '^0.4.0' } },
        'node_modules/pkg-b/node_modules/dependency-a': { version: '0.4.0' },
      },
    };
    const registry = stubRegistry({
      meta: { 'dependency-a': { versions: ['0.4.0', '1.2.0', '1.4.0', '1.5.0'], distTags: {} } },
      advisories: { 'dependency-a': [advisory({ vulnerable_versions: '>=1.0.0 <1.5.0', severity: 'high' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);
    const v = vulns.get('dependency-a');

    assert.equal(v.pinStrategy, 'scoped');
    const pkgA = v.instances.filter((i) => i.parentName === 'pkg-a');
    assert.equal(pkgA.length, 1, 'the two pkg-a@1.0.0 copies collapse into one instance');
    assert.equal(pkgA[0].installedVersion, '1.4.0', 'the merged floor is the highest installed copy (no downgrade)');
    assert.equal(pkgA[0].vulnerable, true);
    assert.equal(pkgA[0].bestSafeInRange, '1.5.0', 'one version fixes both copies');
    assert.equal(v.instances.length, 2, 'pkg-a (merged) + pkg-b');
  });

  it('falls back to global when there is no lockfile tree to inspect', async () => {
    const installed = {
      versions: new Map([['lodash', new Set(['4.17.11'])]]),
      direct: new Set(['lodash']),
      packages: {},
    };
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.11', '4.17.21'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19' })] },
    });

    const { vulns } = await computeVulnerabilities({ installed }, registry);

    assert.equal(vulns.get('lodash').pinStrategy, 'global');
    assert.deepEqual(vulns.get('lodash').instances, []);
  });
});

// --- Advisory labeling and fix-version fallbacks ------------------------------

describe('computeVulnerabilities — advisory fallbacks', () => {
  // One vulnerable installed package; only the advisory shape varies per test.
  function vulnerableWith(advisoryFields, metaVersions = ['1.0.0', '2.0.0']) {
    const installed = {
      versions: new Map([['pkg', new Set(['1.0.0'])]]),
      direct: new Set(['pkg']),
      packages: {},
    };
    const registry = stubRegistry({
      meta: { pkg: { versions: metaVersions, distTags: {} } },
      advisories: { pkg: [advisory({ vulnerable_versions: '<2.0.0', ...advisoryFields })] },
    });
    return computeVulnerabilities({ installed }, registry);
  }

  it('prefers the CVE number over the GHSA id as the label', async () => {
    const { vulns } = await vulnerableWith({ cves: ['CVE-2020-1234'], github_advisory_id: 'GHSA-zzzz' });

    assert.equal(vulns.get('pkg').cve, 'CVE-2020-1234');
  });

  it('falls back to the GHSA id and derives the advisory url from it', async () => {
    const { vulns } = await vulnerableWith({ url: null, github_advisory_id: 'GHSA-abcd' });

    const v = vulns.get('pkg');
    assert.equal(v.cve, 'GHSA-abcd');
    assert.equal(v.url, 'https://github.com/advisories/GHSA-abcd');
  });

  it('labels by numeric advisory id when no CVE, GHSA id, or GHSA url exists', async () => {
    const { vulns } = await vulnerableWith({ url: 'https://example.com/adv/9', id: 9 });

    assert.equal(vulns.get('pkg').cve, 'advisory 9');
  });

  it('derives firstPatched from patched_versions when no safe version is published yet', async () => {
    const { vulns } = await vulnerableWith({ patched_versions: '>=2.0.0' }, ['1.0.0']);

    const v = vulns.get('pkg');
    assert.deepEqual(v.safeVersions, [], 'nothing published is safe');
    assert.equal(v.firstPatched, '2.0.0', 'the advisory itself names the fix');
  });

  it('ignores an advisory whose affected range is unparseable instead of crashing', async () => {
    const { vulns } = await vulnerableWith({ vulnerable_versions: 'garbage ~~ range' });

    assert.equal(vulns.has('pkg'), false);
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

  it("does not flag when a dependent's range is not a semver range at all", async () => {
    const installed = treeWith({
      packages: { '': {}, 'node_modules/consumer': { version: '1.0.0', dependencies: { lodash: 'git://github.com/x/y' } } },
    });
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.21'], distTags: {} } },
    });

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { lodash: '4.17.21' }, installed },
      registry
    );

    assert.equal(removableOverrides.has('lodash'), false, 'unresolvable ranges must never be treated as safe to unpin');
  });

  it("does not flag when a dependent's range matches no published version", async () => {
    const installed = treeWith({
      packages: { '': {}, 'node_modules/consumer': { version: '1.0.0', dependencies: { lodash: '^99.0.0' } } },
    });
    const registry = stubRegistry({
      meta: { lodash: { versions: ['4.17.21'], distTags: {} } },
    });

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { lodash: '4.17.21' }, installed },
      registry
    );

    assert.equal(removableOverrides.has('lodash'), false);
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

  it('ignores a nested (object-valued) override entry', async () => {
    const installed = treeWith();
    const registry = stubRegistry();

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { 'pkg-a': { 'dependency-a': '1.3.0' } }, installed },
      registry
    );

    assert.equal(removableOverrides.has('pkg-a'), false);
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

  // Regression: a dead override must survive the "nothing to vuln-check" early
  // return. Here the lockfile shows an empty tree (nothing installed), so there
  // are no versions to check, yet the override is genuinely dead weight.
  it('surfaces a dead override even when there is nothing else to vuln-check', async () => {
    const installed = { versions: new Map(), direct: new Set(), packages: { '': {} } };
    const registry = stubRegistry();

    const { removableOverrides } = await computeVulnerabilities(
      { overrides: { leftpad: '1.3.0' }, installed },
      registry
    );

    assert.deepEqual(removableOverrides.get('leftpad'), { pin: '1.3.0', reason: 'dead' });
  });

  // Regression: without a lockfile we cannot see the tree, so we must NOT guess
  // that an override is dead — that would be a false positive. A resolvable
  // descriptor is present so this reaches the full analysis (not the early
  // return), which is where the old code wrongly flagged it as dead.
  it('does not classify an override as dead when there is no lockfile to inspect', async () => {
    const registry = stubRegistry({
      meta: { somepkg: { versions: ['1.0.0'], distTags: {} } },
    });

    const { removableOverrides } = await computeVulnerabilities(
      {
        descriptors: [{ name: 'somepkg', range: '^1.0.0', field: 'dependencies' }],
        overrides: { leftpad: '1.3.0' },
        installed: null,
      },
      registry
    );

    assert.equal(removableOverrides.has('leftpad'), false);
  });
});

// --- Workspaces --------------------------------------------------------------
// The instance walk (resolveInstalledPath) must resolve a workspace's edges,
// whether the dependency is hoisted to the root node_modules or installed local
// to the workspace, and classify a workspace's direct dep as direct.
describe('computeVulnerabilities — workspaces', () => {
  const lodashRegistry = () =>
    stubRegistry({
      meta: { lodash: { versions: ['4.17.11', '4.17.21'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19', severity: 'high' })] },
    });
  const lodashDescriptor = [{ name: 'lodash', range: '^4.17.0', field: 'dependencies' }];

  it('classifies a workspace direct dependency as direct and resolves its hoisted install', async () => {
    const packages = {
      '': { name: 'root' },
      'packages/a': { name: '@acme/a', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
      'node_modules/@acme/a': { link: true, resolved: 'packages/a' }, // symlink node, no version
      'node_modules/lodash': { version: '4.17.11' }, // hoisted to the root
    };
    const installed = { versions: new Map([['lodash', new Set(['4.17.11'])]]), direct: new Set(['lodash']), packages };

    const { vulns } = await computeVulnerabilities({ descriptors: lodashDescriptor, installed }, lodashRegistry());

    const v = vulns.get('lodash');
    assert.ok(v, 'lodash should be flagged');
    assert.equal(v.pinStrategy, 'global', 'one hoisted version → a single global pin');
    assert.deepEqual(v.instances.map((i) => i.installedVersion), ['4.17.11'], "the workspace's edge resolves to the hoisted copy");
    assert.equal(v.firstPatched, '4.17.21');
  });

  it('resolves a workspace-local (non-hoisted) install', async () => {
    const packages = {
      '': { name: 'root' },
      'packages/a': { name: '@acme/a', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
      'node_modules/@acme/a': { link: true, resolved: 'packages/a' },
      'packages/a/node_modules/lodash': { version: '4.17.11' }, // local to the workspace, not hoisted
    };
    const installed = { versions: new Map([['lodash', new Set(['4.17.11'])]]), direct: new Set(['lodash']), packages };

    const { vulns } = await computeVulnerabilities({ descriptors: lodashDescriptor, installed }, lodashRegistry());

    const v = vulns.get('lodash');
    assert.ok(v);
    assert.deepEqual(v.instances.map((i) => i.installedVersion), ['4.17.11'], 'the workspace-local copy is resolved');
  });

  it('still merges manifests that agree on the declared range', async () => {
    const packages = {
      '': { name: 'root', dependencies: { lodash: '^4.17.0' } },
      'packages/a': { name: '@acme/a', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
      'node_modules/@acme/a': { link: true, resolved: 'packages/a' },
      'node_modules/lodash': { version: '4.17.11' },
    };
    const installed = { versions: new Map([['lodash', new Set(['4.17.11'])]]), direct: new Set(['lodash']), packages };

    const { vulns } = await computeVulnerabilities({ descriptors: lodashDescriptor, installed }, lodashRegistry());

    const v = vulns.get('lodash');
    assert.equal(v.pinConflict, false, 'agreeing manifests are not a conflict');
    assert.equal(v.instances.length, 1, 'the root and the workspace collapse into one pin');
    assert.deepEqual(v.instances[0].safeCandidates, ['4.17.21']);
  });

  // npm honors `overrides` only in the root manifest, so when the root and a
  // workspace declare different ranges for the same package there is no single
  // entry that fixes both: a pin satisfying one silently rewrites or under-fixes
  // the other. Offer nothing rather than something wrong.
  it('refuses to pin when manifests declare different ranges', async () => {
    const registry = stubRegistry({
      meta: { lodash: { versions: ['3.10.1', '4.17.11', '4.17.21'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19', severity: 'high' })] },
    });
    const packages = {
      '': { name: 'root', dependencies: { lodash: '^3.0.0' } },
      'packages/a': { name: '@acme/a', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
      'node_modules/@acme/a': { link: true, resolved: 'packages/a' },
      'node_modules/lodash': { version: '3.10.1' }, // the root's copy, hoisted
      'packages/a/node_modules/lodash': { version: '4.17.11' }, // the workspace's own
    };
    const installed = {
      versions: new Map([['lodash', new Set(['3.10.1', '4.17.11'])]]),
      direct: new Set(['lodash']),
      packages,
    };

    const { vulns } = await computeVulnerabilities(
      {
        descriptors: [{ name: 'lodash', range: '^3.0.0', field: 'dependencies' }],
        installed,
        manifestPaths: ['', 'packages/a'],
      },
      registry
    );

    const v = vulns.get('lodash');
    assert.ok(v, 'lodash is still flagged as vulnerable');
    assert.equal(v.pinConflict, true, 'the divergent ranges are reported as a conflict');
    const merged = v.instances.find((i) => i.conflict);
    assert.ok(merged, 'the collapsed root/workspace instance carries the flag');
    assert.deepEqual(merged.safeCandidates, [], 'no candidate is offered for the conflicted instance');
    assert.equal(merged.bestSafeInRange, null);
    assert.deepEqual(merged.conflictRanges.sort(), ['^3.0.0', '^4.17.0']);
    assert.equal(
      defaultOverrideSelection(v),
      null,
      'the default selection stages nothing, so `o` cannot write a wrong pin'
    );
    assert.equal(isPinBlocked(v), true);
  });

  // npm implements workspaces as `file:` links, so an ordinary local dependency
  // ("lib": "file:./lib") produces a top-level `lib` lockfile entry with exactly
  // a workspace's shape. Path shape therefore cannot decide what is one of our
  // manifests — only the discovered set can. A single-package project must not
  // be treated as a monorepo and must keep its pre-workspaces behavior.
  it('does not report a conflict for a file: dependency in a single-package project', async () => {
    const registry = stubRegistry({
      meta: { lodash: { versions: ['3.10.1', '4.17.11', '4.17.21'], distTags: {} } },
      advisories: { lodash: [advisory({ vulnerable_versions: '<4.17.19', severity: 'high' })] },
    });
    // Identical to the two-workspace case above, except `lib` is a plain local
    // dependency and the project declares no workspaces.
    const packages = {
      '': { name: 'app', dependencies: { lodash: '^3.0.0', lib: 'file:./lib' } },
      lib: { name: 'lib', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
      'node_modules/lib': { link: true, resolved: 'lib' },
      'node_modules/lodash': { version: '3.10.1' },
      'lib/node_modules/lodash': { version: '4.17.11' },
    };
    const installed = {
      versions: new Map([['lodash', new Set(['3.10.1', '4.17.11'])]]),
      direct: new Set(['lodash']),
      packages,
    };

    const { vulns } = await computeVulnerabilities(
      {
        descriptors: [{ name: 'lodash', range: '^3.0.0', field: 'dependencies' }],
        installed,
        manifestPaths: [''], // standalone: the root is the only manifest
      },
      registry
    );

    const v = vulns.get('lodash');
    assert.ok(v, 'lodash is still flagged as vulnerable');
    assert.equal(v.pinConflict, false, 'a local dependency is not a second manifest');
    assert.ok(!v.instances.some((i) => i.conflict), 'no instance is flagged');
  });
});
