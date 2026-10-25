import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';
import { defaultOverrideSelection, isPinBlocked } from '../../src/override-select.js';
import { loadManifest, applyUpgrades } from '../../src/package-file.js';
import { pinBlockedNote } from '../../src/components/Row.js';
import { FIXTURES_DIR, stageFixture, auditFixture, readJson } from '../fixture-helpers.mjs';
import { present, scopedOf } from '../narrow.mjs';
import { treeFixture } from '../typed-fixtures.mjs';

/** @import { Advisory, BulkAdvisories, InstalledTree, Overrides, Vuln } from '../../src/types.js' */

/** @type {string[]} */
const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Match the bulk endpoint: return only advisories affecting a submitted version.
// Returning every advisory for a name would hide missing candidate verification.
/**
 * @param {string[]} versions
 * @param {Advisory[]} advisories
 */
function registry(versions, advisories) {
  /** @type {Record<string, string[]>[]} */
  const requests = [];
  return {
    requests,
    fetchPackageMeta: async () => ({ versions, distTags: {} }),
    /**
     * @param {Record<string, Iterable<string>>} query
     * @returns {Promise<BulkAdvisories>}
     */
    fetchBulkAdvisories: async (query) => {
      requests.push(Object.fromEntries(Object.entries(query).map(([n, vs]) => [n, [...vs]])));
      /** @type {Map<string, Advisory[]>} */
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
    assert.ok(v);
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
    assert.ok(v);
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
    assert.ok(v);
    assert.deepEqual(v.safeVersions, []);
    assert.equal(v.firstPatched, null);
    assert.equal(defaultOverrideSelection(v), null);
  });
});

describe('override safety — removal selectors', () => {
  for (const [name, selector] of [['child', 'child@^1'], ['@scope/child', '@scope/child@1.0.0']]) {
    it(`does not offer ${selector} for removal, even offline`, async () => {
      const installed = {
        versions: new Map([[name, new Set(['1.1.0'])]]),
        packages: {
          '': {},
          'node_modules/parent': { version: '1.0.0', dependencies: { [name]: '1.0.0' } },
          [`node_modules/${name}`]: { version: '1.1.0' },
        },
      };
      const result = await computeVulnerabilities({ installed, overrides: { [selector]: '1.1.0' } }, {
        fetchPackageMeta: async () => { throw new Error('unsupported selectors must not be fetched as package names'); },
        fetchBulkAdvisories: async () => ({ ok: false, advisories: new Map() }),
      });
      assert.equal(result.removableOverrides.has(selector), false);
    });
  }
});

describe('override safety — scoped selections reach the writer', () => {
  it('qualifies the vulnerable parent when another version of it is already safe', async () => {
    const installed = {
      versions: new Map([['child', new Set(['1.0.0', '2.0.0'])]]),
      packages: {
        ...currentTree.packages,
        'node_modules/other/node_modules/parent': { version: '2.0.0', dependencies: { child: '^2.0.0' } },
        'node_modules/other/node_modules/parent/node_modules/child': { version: '2.0.0' },
      },
    };
    const { vulns } = await computeVulnerabilities({ installed }, registry(['1.0.0', '1.1.0', '2.0.0'], [currentAdvisory]));
    const spec = scopedOf(defaultOverrideSelection(present(vulns.get('child'))));
    assert.equal(spec.scoped.length, 1, 'the safe instance should not be selected');
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-safety-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'package.json'), '{}\n');
    const manifest = await loadManifest(dir);
    await applyUpgrades(manifest, new Map(), { child: spec });
    const written = JSON.parse(await readFile(manifest.filePath, 'utf8'));
    assert.deepEqual(written.overrides, { 'parent@1.0.0': { child: '1.1.0' } });
  });
});

// npm applies only one of a bare "parent" key and a "parent@version" key, so a
// pin in the other form beside an existing key would be reported and ignored.
describe('override safety — pins npm would shadow', () => {
  const twoParentVersions = {
    versions: new Map([['child', new Set(['1.0.0', '2.0.0'])]]),
    packages: {
      ...currentTree.packages,
      'node_modules/other/node_modules/parent': { version: '2.0.0', dependencies: { child: '^2.0.0' } },
      'node_modules/other/node_modules/parent/node_modules/child': { version: '2.0.0' },
    },
  };
  const deps = () => registry(['1.0.0', '1.1.0', '2.0.0'], [currentAdvisory]);

  it('refuses a parent@version pin beside an existing bare parent key', async () => {
    const overrides = { parent: { unrelated: '1.0.0' } };
    const v = (await computeVulnerabilities({ installed: twoParentVersions, overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.deepEqual(v.instances.find((i) => i.parentVersion === '1.0.0')?.pinRefusal, { kind: 'shadowed', by: 'parent' });
    assert.equal(isPinBlocked(v), true, 'falling back to a global pin would also hit the safe parent@2.0.0');
    assert.equal(defaultOverrideSelection(v), null);
  });

  it('refuses a bare parent pin beside an existing parent@version key', async () => {
    const installed = {
      versions: new Map([['child', new Set(['1.0.0', '2.0.0'])]]),
      packages: {
        '': { dependencies: { parent: '1.0.0', other: '1.0.0' } },
        'node_modules/parent': { version: '1.0.0', dependencies: { child: '^1.0.0' } },
        'node_modules/child': { version: '1.0.0' },
        'node_modules/other': { version: '1.0.0', dependencies: { child: '^2.0.0' } },
        'node_modules/other/node_modules/child': { version: '2.0.0' },
      },
    };
    const overrides = { 'parent@0.9.0': { unrelated: '1.0.0' } };
    const v = (await computeVulnerabilities({ installed, overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.deepEqual(v.instances.find((i) => i.parentName === 'parent')?.pinRefusal, { kind: 'shadowed', by: 'parent@0.9.0' });
    assert.equal(defaultOverrideSelection(v), null);
  });

  it('still pins the other dependents', async () => {
    const installed = {
      ...twoParentVersions,
      packages: {
        ...twoParentVersions.packages,
        'node_modules/sibling': { version: '1.0.0', dependencies: { child: '^1.0.0' } },
      },
    };
    const overrides = { parent: { unrelated: '1.0.0' } };
    const v = (await computeVulnerabilities({ installed, overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.equal(isPinBlocked(v), false);
    assert.deepEqual(defaultOverrideSelection(v), {
      scoped: [{ parentName: 'sibling', parentVersion: '1.0.0', version: '1.1.0' }],
    });
  });

  it('pins as before when the existing key has the same form', async () => {
    const overrides = { 'parent@1.0.0': { unrelated: '1.0.0' } };
    const v = (await computeVulnerabilities({ installed: twoParentVersions, overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.deepEqual(defaultOverrideSelection(v), {
      scoped: [{ parentName: 'parent', parentVersion: '1.0.0', parentSelector: 'parent@1.0.0', version: '1.1.0' }],
    });
  });
});

// Two "parent@version" keys keep their pins only if they pin some package to
// versions that don't overlap; and a "parent@version" key fails the install
// (EOVERRIDE) when the root declares parent with another spec that admits it.
describe('override safety — pins npm would drop or reject', () => {
  const deps = (versions = ['1.0.0', '1.1.0', '2.0.0']) => registry(versions, [currentAdvisory]);
  // parent@1.0.0 and parent@1.1.0 share the vulnerable child@1.0.0; parent@2.0.0 is safe.
  /** @param {string[]} [declared] */
  const threeParents = (declared = ['^1.0.0', '^1.0.0']) => treeFixture({
    versions: new Map([['child', new Set(['1.0.0', '2.0.0'])]]),
    packages: {
      '': { dependencies: { parent: '1.0.0' } },
      'node_modules/parent': { version: '1.0.0', dependencies: { child: declared[0] } },
      'node_modules/child': { version: '1.0.0' },
      'node_modules/x/node_modules/parent': { version: '1.1.0', dependencies: { child: declared[1] } },
      'node_modules/y/node_modules/parent': { version: '2.0.0', dependencies: { child: '^2.0.0' } },
      'node_modules/y/node_modules/parent/node_modules/child': { version: '2.0.0' },
    },
  });
  /** @param {Vuln} v */
  const refusals = (v) => Object.fromEntries(v.instances.filter((i) => i.vulnerable).map((i) => [i.parentVersion, i.pinRefusal]));

  it('refuses two copies of a parent pinned to the same version beside a copy left alone', async () => {
    const v = (await computeVulnerabilities({ installed: threeParents() }, deps())).vulns.get('child');
    assert.ok(v);
    assert.deepEqual(refusals(v), {
      '1.0.0': { kind: 'shadowed', by: 'parent@1.1.0', proposed: true, key: 'parent@1.0.0', name: 'child', version: '1.1.0' },
      '1.1.0': { kind: 'shadowed', by: 'parent@1.0.0', proposed: true, key: 'parent@1.1.0', name: 'child', version: '1.1.0' },
    });
    assert.equal(isPinBlocked(v), true);
  });

  // Neither key is in package.json: the note must not read as "an existing key
  // is in the way" (the 2026-10-17 field report, F1 c). Every dependent's
  // newest in-range child is safe, so re-resolving fixes it with no pin.
  it('names both proposed pins in the note, not an existing key', async () => {
    const v = (await computeVulnerabilities({ installed: threeParents() }, deps())).vulns.get('child');
    assert.ok(v);
    assert.equal(
      pinBlockedNote(v, 'child'),
      'ⓘ npm keeps only one of the identical pins "parent@1.0.0" and "parent@1.1.0" (child 1.1.0) — run npm update child instead'
    );
  });

  it('calls an existing key the user\'s own override', async () => {
    const overrides = { 'parent@2.0.0': { other: '1.0.0' } };
    const installed = { ...threeParents(), packages: { ...threeParents().packages } };
    delete installed.packages['node_modules/x/node_modules/parent'];
    const v = (await computeVulnerabilities({ installed, overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.equal(
      pinBlockedNote(v, 'child'),
      'ⓘ npm would ignore a pin beside your override "parent@2.0.0" — run npm update child instead'
    );
  });

  // child 1.2.0, the newest ^1.0.0, is vulnerable too: only a pin at 1.1.0
  // fixes the parent@1.x copies, so there is no route around the refusal.
  it('leaves the overrides to the user when re-resolving would not fix it', async () => {
    const reg = registry(['1.0.0', '1.1.0', '1.2.0', '2.0.0'], [
      currentAdvisory,
      { vulnerable_versions: '>=1.2.0 <2.0.0', severity: 'high' },
    ]);
    const v = (await computeVulnerabilities({ installed: threeParents() }, reg)).vulns.get('child');
    assert.ok(v);
    assert.equal(v.inRangeFix, false);
    assert.equal(
      pinBlockedNote(v, 'child'),
      'ⓘ npm keeps only one of the identical pins "parent@1.0.0" and "parent@1.1.0" (child 1.1.0) — edit overrides by hand'
    );
  });

  // The shape of the 2026-10-17 field report's brace-expansion: two copies of a
  // parent whose existing keys both pin the vulnerable child. Refusing a new
  // pair is right; the way out is to drop those pins and re-resolve.
  it('names the user\'s own pins that hold the vulnerable version, and the way out', async () => {
    const overrides = { 'parent@1.0.0': { child: '1.0.0' }, 'parent@1.1.0': { child: '1.0.0' } };
    const v = (await computeVulnerabilities({ installed: threeParents(), overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.equal(isPinBlocked(v), true);
    assert.deepEqual(v.heldBy, [
      { key: 'parent@1.0.0', pin: '1.0.0' },
      { key: 'parent@1.1.0', pin: '1.0.0' },
    ]);
    assert.equal(
      pinBlockedNote(v, 'child'),
      'ⓘ your overrides "parent@1.0.0" and "parent@1.1.0" pin child to 1.0.0 — remove those pins, then run npm update child'
    );
  });

  it('offers no route when an override can\'t be judged', async () => {
    const overrides = { 'parent@1.0.0': { child: '$child' } };
    const v = (await computeVulnerabilities({ installed: threeParents(), overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.equal(v.heldBy, null);
    assert.match(present(pinBlockedNote(v, 'child')), /— edit overrides by hand$/);
  });

  it('pins both copies when their versions differ', async () => {
    const installed = threeParents(['>=1.0.0 <1.2.0', '^1.0.0']);
    const v = (await computeVulnerabilities({ installed }, deps(['1.0.0', '1.1.0', '1.2.0', '2.0.0']))).vulns.get('child');
    assert.ok(v);
    assert.deepEqual(scopedOf(defaultOverrideSelection(v)).scoped.map((p) => [p.parentSelector, p.version]), [
      ['parent@1.0.0', '1.1.0'],
      ['parent@1.1.0', '1.2.0'],
    ]);
  });

  it('refuses a pin beside an existing parent@version key that pins something else', async () => {
    const overrides = { 'parent@2.0.0': { other: '1.0.0' } };
    const installed = { ...threeParents(), packages: { ...threeParents().packages } };
    delete installed.packages['node_modules/x/node_modules/parent'];
    const v = (await computeVulnerabilities({ installed, overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.deepEqual(refusals(v), { '1.0.0': { kind: 'shadowed', by: 'parent@2.0.0' } });
  });

  it('pins beside an existing parent@version key that pins the same package elsewhere', async () => {
    const overrides = { 'parent@2.0.0': { child: '2.0.0' } };
    const installed = { ...threeParents(), packages: { ...threeParents().packages } };
    delete installed.packages['node_modules/x/node_modules/parent'];
    const v = (await computeVulnerabilities({ installed, overrides }, deps())).vulns.get('child');
    assert.ok(v);
    assert.deepEqual(scopedOf(defaultOverrideSelection(v)).scoped.map((p) => p.parentSelector), ['parent@1.0.0']);
  });

  for (const [rootSpec, refused] of /** @type {[string, boolean][]} */ ([['^1.0.0', true], ['1.0.0', false], ['^2.0.0', false]])) {
    it(`${refused ? 'refuses' : 'allows'} a parent@1.0.0 pin when the root declares parent ${rootSpec}`, async () => {
      /** @type {InstalledTree} */
      const installed = { ...threeParents(), packages: { ...threeParents().packages, '': { dependencies: { parent: rootSpec } } } };
      delete installed.packages['node_modules/x/node_modules/parent'];
      const v = (await computeVulnerabilities({ installed }, deps())).vulns.get('child');
      assert.ok(v);
      assert.deepEqual(
        refusals(v)['1.0.0'],
        refused ? { kind: 'eoverride', key: 'parent@1.0.0', name: 'parent', rootSpec } : undefined
      );
    });
  }
});

// npm matches a "parent@1.0.0" key against the range each dependent declares, so
// it also reaches another copy of parent whose dependent's range admits 1.0.0.
describe('override safety — pins that reach another copy of the parent', () => {
  // a -> parent@1.0.0 (vulnerable child@1.0.0); b -> parent@1.2.0, nested, with
  // its own child. `bRange` is what b declares for parent.
  const overlap = ({ range = '^1.0.0', child = '1.1.0', bRange = '^1.0.0' } = {}) => ({
    versions: new Map([['child', new Set(['1.0.0', child])]]),
    packages: {
      '': { dependencies: { a: '1.0.0', b: '1.0.0' } },
      'node_modules/a': { version: '1.0.0', dependencies: { parent: '1.0.0' } },
      'node_modules/parent': { version: '1.0.0', dependencies: { child: range } },
      'node_modules/child': { version: '1.0.0' },
      'node_modules/b': { version: '1.0.0', dependencies: { parent: bRange } },
      'node_modules/b/node_modules/parent': { version: '1.2.0', dependencies: { child: '^1.0.0' } },
      'node_modules/b/node_modules/parent/node_modules/child': { version: child },
    },
  });
  /**
   * @param {InstalledTree} installed
   * @param {Overrides} [overrides]
   */
  const audit = async (installed, overrides) =>
    (await computeVulnerabilities({ installed, overrides }, registry(['1.0.0', '1.1.0', '1.2.0'], [currentAdvisory]))).vulns.get('child');
  /** @param {Vuln} v */
  const pinned = (v) => present(v.instances.find((i) => i.parentVersion === '1.0.0'), 'instance under parent@1.0.0');

  it('pins when the fix is harmless for the copy it also reaches', async () => {
    const v = await audit(overlap());
    assert.ok(v);
    assert.deepEqual(scopedOf(defaultOverrideSelection(v)).scoped.map((p) => [p.parentSelector, p.version]), [['parent@1.0.0', '1.2.0']]);
  });

  it('drops the versions that would downgrade the copy it also reaches', async () => {
    const v = await audit(overlap({ child: '1.2.0' }));
    assert.ok(v);
    assert.deepEqual(pinned(v).safeCandidates, ['1.2.0']);
  });

  it('refuses the pin when every fix would downgrade the copy it also reaches', async () => {
    const v = await audit(overlap({ range: '>=1.0.0 <1.2.0', child: '1.2.0' }));
    assert.ok(v);
    assert.deepEqual(pinned(v).pinRefusal, { kind: 'reaches', copy: 'parent@1.2.0' });
    assert.equal(isPinBlocked(v), true);
  });

  it('ignores a copy whose dependents rule the pinned version out', async () => {
    const v = await audit(overlap({ range: '>=1.0.0 <1.2.0', child: '1.2.0', bRange: '^1.2.0' }));
    assert.ok(v);
    assert.deepEqual(pinned(v).safeCandidates, ['1.1.0']);
  });

  it('ignores a copy an existing key already covers, since npm applies that key first', async () => {
    const overrides = { 'parent@1.2.0': { child: '1.2.0' } };
    const v = await audit(overlap({ range: '>=1.0.0 <1.2.0', child: '1.2.0' }), overrides);
    assert.ok(v);
    assert.deepEqual(scopedOf(defaultOverrideSelection(v)).scoped.map((p) => [p.parentSelector, p.version]), [['parent@1.0.0', '1.1.0']]);
  });
});

// The 2026-10-17 field report's brace-expansion, on an npm-built lockfile: the
// user's own identical keys hold both 2.x copies on a vulnerable version.
describe('override safety — overrides that hold a vulnerable version', () => {
  it('names the held pins and the in-range way out on a real lockfile', async () => {
    const fixtureDir = path.join(FIXTURES_DIR, 'held-by-scoped-pins');
    const work = await stageFixture(fixtureDir);
    dirs.push(work);
    const { vulns } = await auditFixture(work, await readJson(path.join(fixtureDir, 'registry.snapshot.json')));
    const v = vulns.get('brace-expansion');
    assert.ok(v);

    assert.equal(isPinBlocked(v), true, 'two identical new pins would be refused');
    assert.equal(v.inRangeFix, true);
    assert.deepEqual(v.heldBy, [
      { key: 'minimatch@5.1.9', pin: '2.1.4' },
      { key: 'minimatch@9.0.9', pin: '2.1.4' },
    ]);
    assert.equal(
      pinBlockedNote(v, 'brace-expansion'),
      'ⓘ your overrides "minimatch@5.1.9" and "minimatch@9.0.9" pin brace-expansion to 2.1.4 — remove those pins, then run npm update brace-expansion'
    );
  });
});
