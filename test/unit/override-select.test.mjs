// Unit tests for the default override-selection helper — the single source of
// truth the interactive pickers and the fixture harness share for "what does
// pressing `o` then <enter> stage?". Locking it down here keeps the pickers and
// the harness from silently drifting apart.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  isPinnableInstance,
  pinnableInstances,
  defaultScopedChoiceIndex,
  shouldScope,
  defaultOverrideSelection,
  scopedOverrideSelection,
  crossedDependents,
  narrowerKey,
} from '../../src/override-select.js';
import { instanceFixture, vulnFixture } from '../typed-fixtures.mjs';
import { FIXTURES_DIR, readJson, stageFixture, auditFixture } from '../fixture-helpers.mjs';
import { present } from '../narrow.mjs';

// A vuln instance as computeVulnerabilities emits it (only the fields the
// selector reads).
/**
 * @param {{ parentName?: string | null, parentVersion?: string | null, vulnerable?: boolean, safeCandidates?: string[] }} fields
 */
function instance({ parentName, parentVersion, vulnerable = true, safeCandidates = [] }) {
  return instanceFixture({ parentName, parentVersion, vulnerable, safeCandidates });
}

describe('isPinnableInstance', () => {
  it('is true only for a vulnerable instance with an in-range safe candidate', () => {
    assert.equal(isPinnableInstance(instance({ vulnerable: true, safeCandidates: ['1.2.3'] })), true);
    assert.equal(isPinnableInstance(instance({ vulnerable: false, safeCandidates: ['1.2.3'] })), false);
    assert.equal(isPinnableInstance(instance({ vulnerable: true, safeCandidates: [] })), false);
  });

  it('is false when an existing override would shadow the pin', () => {
    assert.equal(isPinnableInstance({ ...instance({ safeCandidates: ['1.2.3'] }), pinRefusal: { kind: 'shadowed', by: 'parent' } }), false);
  });

  it('is false for nullish or malformed instances', () => {
    assert.equal(isPinnableInstance(null), false);
    assert.equal(isPinnableInstance(undefined), false);
    // @ts-expect-error a malformed instance, on purpose
    assert.equal(isPinnableInstance({ vulnerable: true, safeCandidates: 'nope' }), false);
  });
});

describe('defaultScopedChoiceIndex', () => {
  it('points at the newest in-range safe version (last candidate)', () => {
    assert.equal(defaultScopedChoiceIndex(instanceFixture({ safeCandidates: ['1.1.16', '1.1.17', '1.1.18'] })), 2);
    // Must equal what vulnerabilities.js records as bestSafeInRange for the same
    // list, so the picker default and the audit's summary agree.
    const safeCandidates = ['2.0.2', '2.1.2'];
    assert.equal(safeCandidates[defaultScopedChoiceIndex(instanceFixture({ safeCandidates }))], '2.1.2');
  });
});

describe('shouldScope', () => {
  it('scopes a multi-version package with at least one fixable instance', () => {
    const vuln = vulnFixture({
      pinStrategy: 'scoped',
      instances: [instance({ parentName: 'a', safeCandidates: ['1.1.16'] })],
    });
    assert.equal(shouldScope(vuln), true);
  });

  it('does not scope when the strategy is global', () => {
    const vuln = vulnFixture({
      pinStrategy: 'global',
      instances: [instance({ parentName: 'a', safeCandidates: ['1.1.16'] })],
    });
    assert.equal(shouldScope(vuln), false);
  });

  it('does not scope when no instance is pinnable', () => {
    const vuln = vulnFixture({
      pinStrategy: 'scoped',
      instances: [instance({ parentName: 'a', vulnerable: true, safeCandidates: [] })],
    });
    assert.equal(shouldScope(vuln), false);
  });
});

describe('defaultOverrideSelection', () => {
  it('returns a scoped spec pinning each fixable dependent to its newest safe version', () => {
    const vuln = vulnFixture({
      pinStrategy: 'scoped',
      instances: [
        instance({ parentName: 'minimatch', parentVersion: '3.1.5', safeCandidates: ['1.1.15', '1.1.16'] }),
        instance({ parentName: 'minimatch', parentVersion: '9.0.9', safeCandidates: ['2.0.2', '2.1.2'] }),
        // already-safe instance: not vulnerable, so it's left alone
        instance({ parentName: 'other', vulnerable: false, safeCandidates: ['9.9.9'] }),
      ],
    });
    assert.deepEqual(defaultOverrideSelection(vuln), {
      scoped: [
        { parentName: 'minimatch', parentVersion: '3.1.5', parentSelector: 'minimatch@3.1.5', version: '1.1.16' },
        { parentName: 'minimatch', parentVersion: '9.0.9', parentSelector: 'minimatch@9.0.9', version: '2.1.2' },
      ],
    });
  });

  it('returns the lowest safe version string for a global vuln', () => {
    const vuln = vulnFixture({ pinStrategy: 'global', safeVersions: ['1.2.6', '1.2.7', '1.2.8'] });
    assert.equal(defaultOverrideSelection(vuln), '1.2.6');
  });

  it('returns null when there is no safe fix to offer', () => {
    assert.equal(defaultOverrideSelection(vulnFixture({ pinStrategy: 'global', safeVersions: [] })), null);
    assert.equal(defaultOverrideSelection(vulnFixture({ pinStrategy: 'global' })), null);
  });

  it('falls back to a global pin when a scoped vuln has no pinnable instance', () => {
    const vuln = vulnFixture({
      pinStrategy: 'scoped',
      instances: [instance({ parentName: 'a', vulnerable: true, safeCandidates: [] })],
      safeVersions: ['3.0.0', '3.0.1'],
    });
    assert.equal(defaultOverrideSelection(vuln), '3.0.0');
  });
});

describe('scopedOverrideSelection', () => {
  it('preserves scope and a user-selected version when other parent versions are not pinnable', () => {
    const instances = [
      instance({ parentName: '@scope/parent', parentVersion: '2.0.0', vulnerable: false, safeCandidates: ['2.1.0'] }),
      instance({ parentName: '@scope/parent', parentVersion: '1.0.0', safeCandidates: ['1.1.0', '1.2.0'] }),
      instance({ parentName: '@scope/parent', parentVersion: '3.0.0', safeCandidates: [] }),
    ];
    assert.deepEqual(scopedOverrideSelection(instances, [0]), {
      scoped: [{ parentName: '@scope/parent', parentVersion: '1.0.0', parentSelector: '@scope/parent@1.0.0', version: '1.1.0' }],
    });
  });

  it('keeps distinct selectors even when two parent versions choose the same target', () => {
    // A bare key would also pin the safe parent@2.0.0. In the real flow the audit
    // refuses this pair before selection (npm drops one of two same-version
    // keys); the writer refuses it too if the picker produces it.
    const spec = scopedOverrideSelection([
      instance({ parentName: 'parent', parentVersion: '1.0.0', safeCandidates: ['1.2.0'] }),
      instance({ parentName: 'parent', parentVersion: '1.1.0', safeCandidates: ['1.2.0'] }),
      instance({ parentName: 'parent', parentVersion: '2.0.0', vulnerable: false, safeCandidates: ['2.0.0'] }),
    ]);
    assert.deepEqual(spec.scoped.map((p) => p.parentSelector), ['parent@1.0.0', 'parent@1.1.0']);
  });
});

describe('pinnableInstances', () => {
  it('keeps only the vulnerable, fixable instances and tolerates a missing list', () => {
    const vuln = vulnFixture({
      instances: [
        instance({ parentName: 'a', vulnerable: true, safeCandidates: ['1.0.0'] }),
        instance({ parentName: 'b', vulnerable: false, safeCandidates: ['1.0.0'] }),
      ],
    });
    assert.deepEqual(pinnableInstances(vuln).map((i) => i.parentName), ['a']);
    assert.deepEqual(pinnableInstances({}), []);
  });
});

// The global picker's warning (the 2026-11-04 field report, F3): a pin to 11
// moved eslint's minimatch@3, which the advisory doesn't affect, and nothing said so.
describe('crossedDependents', () => {
  /**
   * @param {string} declaredRange
   * @param {string | null} installedVersion
   * @param {boolean} [vulnerable]
   * @param {string} [parentName]
   */
  const dep = (declaredRange, installedVersion, vulnerable = true, parentName = 'p') =>
    instanceFixture({ parentName, declaredRange, installedVersion, vulnerable });
  /**
   * @param {ReturnType<typeof dep>[]} instances
   * @param {string} version
   */
  const crossed = (instances, version) => {
    const { crossed: c, alreadySafe } = crossedDependents(vulnFixture({ instances }), version);
    return { crossed: c.map((i) => i.declaredRange), alreadySafe: alreadySafe.map((i) => i.declaredRange) };
  };

  it('names a dependent the pin takes to another major', () => {
    assert.deepEqual(crossed([dep('^10.2.2', '10.2.6')], '11.0.4').crossed, ['^10.2.2']);
  });

  // follow-redirects in the field report: nx declares exact 1.16.0.
  it('stays quiet for a patch past an exact version', () => {
    assert.deepEqual(crossed([dep('1.16.0', '1.16.1')], '1.16.2').crossed, []);
  });

  it('treats a 0.x minor as a major', () => {
    assert.deepEqual(crossed([dep('^0.8.8', '0.8.9')], '0.9.0').crossed, ['^0.8.8']);
    assert.deepEqual(crossed([dep('~0.8.8', '0.8.9')], '0.8.10').crossed, [], 'in range');
  });

  it('stays quiet when the version is inside the range', () => {
    assert.deepEqual(crossed([dep('^3.25.0 || ^4.0.0', '4.5.4')], '4.6.7').crossed, []);
    assert.deepEqual(crossed([dep('^1.0.0-rc.1', '1.0.0-rc.1')], '1.0.0').crossed, []);
  });

  it('skips a range it cannot read', () => {
    assert.deepEqual(crossed([dep('github:user/repo', '1.0.0')], '2.0.0').crossed, []);
  });

  it('marks the already-safe dependents the pin would move', () => {
    const result = crossed([dep('^3.1.2', '3.1.5', false), dep('^10.2.2', '10.2.6')], '11.0.4');

    assert.deepEqual(result, { crossed: ['^3.1.2', '^10.2.2'], alreadySafe: ['^3.1.2'] });
  });

  // The second run: the pin already moved them, so it moves nothing now. They're
  // still outside their declared major, so they're still named.
  it("doesn't count a safe dependent already on the pin's line, or one with no version", () => {
    const result = crossed([dep('^3.1.2', '11.0.4', false), dep('^3.1.2', null, false)], '11.0.4');

    assert.deepEqual(result, { crossed: ['^3.1.2', '^3.1.2'], alreadySafe: [] });
  });
});

describe('narrowerKey', () => {
  /**
   * @param {string[]} ranges  one advisory per range
   * @param {[string, boolean][]} copies  installed version, vulnerable
   */
  const vuln = (ranges, copies) =>
    vulnFixture({
      advisories: ranges.map((vulnerable_versions) => ({ vulnerable_versions })),
      instances: copies.map(([installedVersion, vulnerable]) => ({ installedVersion, vulnerable })),
    });

  it('starts the key where the advisory does, leaving older copies alone', () => {
    assert.equal(narrowerKey('minimatch', vuln(['>=7.0.0 <11.0.1'], [['3.1.5', false], ['10.2.6', true]]), '11.0.1'), 'minimatch@>=7');
  });

  it('keeps a lower bound that is not a major boundary', () => {
    assert.equal(narrowerKey('pkg', vuln(['>=2.3.0 <2.5.0'], [['2.1.0', false], ['2.4.0', true]]), '2.5.0'), 'pkg@>=2.3.0');
  });

  it('offers none without a safe copy below the advisory', () => {
    assert.equal(narrowerKey('glob', vuln(['>=9.0.0 <=14.0.1'], [['10.5.0', true], ['13.0.6', true]]), '14.0.2'), null);
  });

  it('offers none when an advisory has no lower bound', () => {
    assert.equal(narrowerKey('pkg', vuln(['<2.0.0'], [['0.5.0', false], ['1.0.0', true]]), '2.0.0'), null);
  });

  // The key would catch a newer, already-safe copy and lower it to the pin.
  it('offers none when the key would catch a newer copy', () => {
    assert.equal(narrowerKey('pkg', vuln(['>=7.0.0 <11.0.1'], [['3.1.5', false], ['10.2.6', true], ['12.0.0', false]]), '11.0.1'), null);
  });
});

describe('global-pin-moves-safe-copies fixture', () => {
  /** @type {string[]} */
  const dirs = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('warns that the default pin moves the copy the advisory leaves alone', async () => {
    const fixture = path.join(FIXTURES_DIR, 'global-pin-moves-safe-copies');
    const work = await stageFixture(fixture);
    dirs.push(work);
    const { vulns } = await auditFixture(work, await readJson(path.join(fixture, 'registry.snapshot.json')));
    const vuln = present(vulns.get('minimatch'), 'minimatch row');

    const version = present(defaultOverrideSelection(vuln));
    assert.equal(version, '11.0.1');
    const { crossed, alreadySafe } = crossedDependents(vuln, /** @type {string} */ (version));

    assert.deepEqual(crossed.map((i) => `${i.parentName}@${i.parentVersion}`), ['glob@7.2.3', 'glob@11.1.0']);
    assert.deepEqual(alreadySafe.map((i) => `${i.parentName}@${i.parentVersion}`), ['glob@7.2.3']);
    assert.equal(narrowerKey('minimatch', vuln, /** @type {string} */ (version)), 'minimatch@>=7');
  });
});
