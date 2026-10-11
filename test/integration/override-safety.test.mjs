// Assert the resolved tree after audit -> selection -> write, not just npm's
// exit code. Advisory data is frozen; npm generates the lockfiles itself.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import semver from 'semver';
import { loadManifest, applyUpgrades } from '../../src/package-file.js';
import { loadInstalledVersions } from '../../src/lockfile.js';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';
import { defaultOverrideSelection } from '../../src/override-select.js';
import { FIXTURES_DIR, stageFixture, stubFromSnapshot } from '../fixture-helpers.mjs';

const exec = promisify(execFile);
const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
async function npm(cwd, args) {
  await exec('npm', args, {
    cwd, env: { ...process.env, ASDF_NODEJS_VERSION: process.versions.node }, timeout: 120000,
  });
}
const install = (cwd) => npm(cwd, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);

// The npm these tests drive (CI runs npm 10 and 11). How npm treats several
// override keys for one parent changed between releases, so an assertion about
// that behaviour only runs on the releases it was measured on
// (docs/2026-10-11-spike-override-keys.md). The tool's own refusals hold on all.
const { stdout: npmVersion } = await exec('npm', ['--version'], {
  env: { ...process.env, ASDF_NODEJS_VERSION: process.versions.node },
});
const npmAtLeast = (version) => semver.gte(npmVersion.trim(), version);

// The version of `name` the lockfile entry at `from` resolves to, by node's lookup.
function resolvedFrom(packages, from, name) {
  for (let prefix = from; ; ) {
    const hit = packages[`${prefix ? `${prefix}/` : ''}node_modules/${name}`];
    if (hit) return hit.version;
    if (!prefix) return null;
    const at = prefix.lastIndexOf('/node_modules/');
    prefix = at === -1 ? '' : prefix.slice(0, at);
  }
}

// Every installed copy of `name`, with what `child` resolves to from it.
async function copiesOf(dir, name, child) {
  const { packages } = await loadInstalledVersions(dir);
  return Object.entries(packages)
    .filter(([p]) => p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`))
    .map(([p, info]) => ({ version: info.version, [child]: resolvedFrom(packages, p, child) }));
}

describe('override safety — real npm resolution', () => {
  it('fixes one parent version without downgrading its already-safe sibling', async () => {
    const dir = await stageFixture(path.join(FIXTURES_DIR, 'stale-transitive-minimatch'));
    dirs.push(dir);
    const file = path.join(dir, 'package.json');
    const json = await readJson(file);
    // Establish a safe 2.x branch with npm, then keep the generated lockfile
    // while removing the temporary pin. The older 1.x branch stays vulnerable.
    json.overrides = { 'minimatch@9.0.9': { 'brace-expansion': '2.1.4' } };
    await writeJson(file, json);
    await install(dir);
    delete json.overrides;
    await writeJson(file, json);

    // Read through node's lookup: npm releases nest the copies differently.
    const braceExpansion = async () =>
      Object.fromEntries((await copiesOf(dir, 'minimatch', 'brace-expansion')).map((c) => [c.version, c['brace-expansion']]));
    assert.deepEqual(await braceExpansion(), { '3.1.5': '1.1.11', '9.0.9': '2.1.4' });
    const installed = await loadInstalledVersions(dir);
    const { vulns } = await computeVulnerabilities({ installed }, stubFromSnapshot({
      meta: { 'brace-expansion': { versions: ['1.1.11', '1.1.12', '2.1.4'], distTags: {} } },
      advisories: { 'brace-expansion': [{ vulnerable_versions: '<1.1.12', severity: 'low' }] },
    }));
    await applyUpgrades(await loadManifest(dir), new Map(), {
      'brace-expansion': defaultOverrideSelection(vulns.get('brace-expansion')),
    });
    assert.deepEqual((await readJson(file)).overrides, {
      'minimatch@3.1.5': { 'brace-expansion': '1.1.12' },
    });
    await install(dir);
    assert.deepEqual(await braceExpansion(), { '3.1.5': '1.1.12', '9.0.9': '2.1.4' }, 'the safe branch must stay on its own major');
  });

  it('refuses a scoped pin that an existing bare parent key would shadow', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-safety-npm-'));
    dirs.push(dir);
    const file = path.join(dir, 'package.json');
    // glob@7.2.3 at the root and glob@10 under rimraf, so a pin for glob@7's
    // minimatch must be keyed "glob@7.2.3". Lock that minimatch at a vulnerable
    // 3.1.1, then leave only the user's own bare "glob" override in place.
    const base = { name: 'nui-safety-app', version: '1.0.0', dependencies: { glob: '7.2.3', rimraf: '5.0.5' } };
    await writeJson(file, { ...base, overrides: { 'glob@7.2.3': { minimatch: '3.1.1' } } });
    await install(dir);
    const bare = { glob: { inflight: '1.0.6' } };
    await writeJson(file, { ...base, overrides: bare });
    const glob7Minimatch = async () => (await copiesOf(dir, 'glob', 'minimatch')).find((c) => c.version === '7.2.3').minimatch;
    assert.equal(await glob7Minimatch(), '3.1.1');

    const { vulns } = await computeVulnerabilities({ installed: await loadInstalledVersions(dir), overrides: bare }, stubFromSnapshot({
      meta: { minimatch: { versions: ['3.1.1', '3.1.2'], distTags: {} } },
      advisories: { minimatch: [{ vulnerable_versions: '<3.1.2', severity: 'high' }] },
    }));
    const vuln = vulns.get('minimatch');
    assert.deepEqual(vuln.instances.find((i) => i.vulnerable).pinRefusal, { kind: 'shadowed', by: 'glob' });
    assert.equal(defaultOverrideSelection(vuln), null);

    // Why it is refused: npm ignores the pin the tool used to write, which lands
    // after the existing bare key. Measured on npm 9.9 through 12.2. (With the
    // keys the other way round, npm 9 and 10 apply both and 11.13+ neither.)
    const overrides = { ...bare, 'glob@7.2.3': { minimatch: '3.1.2' } };
    await writeJson(file, { ...base, overrides });
    await install(dir);
    assert.equal(await glob7Minimatch(), '3.1.1', `npm applied ${JSON.stringify(overrides)}`);
  });

  it('refuses two copies of a parent pinned to the same version, which npm would half-apply', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-safety-npm-'));
    dirs.push(dir);
    const file = path.join(dir, 'package.json');
    // minimatch at 3.x (glob@7), 5.x (filelist) and 9.x (rimraf@5). The 5.x and
    // 9.x copies accept the same brace-expansion fix; 3.x is left alone.
    const base = {
      name: 'nui-safety-app', version: '1.0.0', dependencies: { filelist: '1.0.4', glob: '7.2.3', rimraf: '5.0.5' },
    };
    await writeJson(file, base);
    await install(dir);
    const v = Object.fromEntries((await copiesOf(dir, 'minimatch', 'brace-expansion')).map((c) => [c.version.split('.')[0], c.version]));
    const pins = (a, b) => ({ [`minimatch@${v[5]}`]: { 'brace-expansion': a }, [`minimatch@${v[9]}`]: { 'brace-expansion': b } });
    // Lock vulnerable 2.0.x under both (different versions, so npm applies both), then drop the pins.
    await writeJson(file, { ...base, overrides: pins('2.0.1', '2.0.2') });
    await install(dir);
    await writeJson(file, base);

    const { vulns } = await computeVulnerabilities({ installed: await loadInstalledVersions(dir) }, stubFromSnapshot({
      meta: { 'brace-expansion': { versions: ['2.0.1', '2.0.2', '2.1.7'], distTags: {} } },
      advisories: { 'brace-expansion': [{ vulnerable_versions: '>=2.0.0 <2.0.3', severity: 'high' }] },
    }));
    const vuln = vulns.get('brace-expansion');
    assert.deepEqual(vuln.instances.filter((i) => i.vulnerable).map((i) => i.pinRefusal?.kind), ['shadowed', 'shadowed']);
    assert.equal(defaultOverrideSelection(vuln), null);

    // Why: with both keys on the same version, npm 11.13+ drops one copy's pin
    // (npm 9 and 10 apply both). The refusal holds either way: the lockfile may
    // be regenerated by any npm.
    if (!npmAtLeast('11.13.0')) return;
    await writeJson(file, { ...base, overrides: pins('2.1.7', '2.1.7') });
    await install(dir);
    const fixed = (await copiesOf(dir, 'minimatch', 'brace-expansion')).filter((c) => !c.version.startsWith('3.'));
    assert.ok(fixed.some((c) => c['brace-expansion'] !== '2.1.7'), `npm applied both pins: ${JSON.stringify(fixed)}`);
  });

  // The setup relies on how npm 11.13+ places the two copies; npm 9 and 10 merge
  // them. The audit side is covered in the unit tests on every npm.
  it('pins only versions that are harmless for another copy the key also reaches', {
    skip: !npmAtLeast('11.13.0') && `measured on npm 11.13+, this is ${npmVersion.trim()}`,
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-safety-npm-'));
    dirs.push(dir);
    const file = path.join(dir, 'package.json');
    const lockFile = path.join(dir, 'package-lock.json');
    // The root's minimatch@3.0.4 has a vulnerable brace-expansion; glob@7.1.6 has
    // its own minimatch@3.1.2 with a safe 1.1.21, reached through its "^3.0.4" —
    // a range that admits 3.0.4, so a "minimatch@3.0.4" key applies to it too.
    const base = { name: 'nui-safety-app', version: '1.0.0', dependencies: { minimatch: '3.0.4', glob: '7.1.6' } };
    await writeJson(file, {
      ...base,
      overrides: { glob: { minimatch: '3.1.2', 'brace-expansion': '1.1.21' }, 'minimatch@3.0.4': { 'brace-expansion': '1.1.11' } },
    });
    await install(dir);
    await writeJson(file, base);
    await install(dir);
    const staleLock = await readFile(lockFile, 'utf8');
    const braceExpansion = async () =>
      Object.fromEntries((await copiesOf(dir, 'minimatch', 'brace-expansion')).map((c) => [c.version, c['brace-expansion']]));
    assert.deepEqual(await braceExpansion(), { '3.0.4': '1.1.11', '3.1.2': '1.1.21' });
    const audit = async (versions) =>
      (await computeVulnerabilities({ installed: await loadInstalledVersions(dir) }, stubFromSnapshot({
        meta: { 'brace-expansion': { versions, distTags: {} } },
        advisories: { 'brace-expansion': [{ vulnerable_versions: '<1.1.12', severity: 'high' }] },
      }))).vulns.get('brace-expansion');

    // Only 1.1.12 is on offer: it would downgrade glob's copy, so the pin is refused.
    const refused = await audit(['1.1.11', '1.1.12']);
    assert.deepEqual(refused.instances.find((i) => i.vulnerable).pinRefusal, { kind: 'reaches', copy: 'minimatch@3.1.2' });
    assert.equal(defaultOverrideSelection(refused), null);

    // With 1.1.21 on offer, that's the only harmless fix, and it's what gets pinned.
    const spec = defaultOverrideSelection(await audit(['1.1.11', '1.1.12', '1.1.21']));
    await applyUpgrades(await loadManifest(dir), new Map(), { 'brace-expansion': spec });
    assert.deepEqual((await readJson(file)).overrides, { 'minimatch@3.0.4': { 'brace-expansion': '1.1.21' } });
    await install(dir);
    assert.deepEqual(await braceExpansion(), { '3.0.4': '1.1.21', '3.1.2': '1.1.21' });

    // Why: the refused pin would have downgraded glob's copy along with the root's.
    await writeFile(lockFile, staleLock);
    await writeJson(file, { ...base, overrides: { 'minimatch@3.0.4': { 'brace-expansion': '1.1.12' } } });
    await install(dir);
    assert.equal((await braceExpansion())['3.1.2'], '1.1.12');
  });

  it('refuses a parent@version pin beside one that pins a different package, which npm would drop', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-safety-npm-'));
    dirs.push(dir);
    const file = path.join(dir, 'package.json');
    const base = { name: 'nui-safety-app', version: '1.0.0', dependencies: { glob: '7.2.3', rimraf: '5.0.5' } };
    await writeJson(file, { ...base, overrides: { 'glob@7.2.3': { minimatch: '3.1.1' } } });
    await install(dir);
    // The user's own pin under the other copy of glob, for a package glob@7 doesn't share.
    const glob10 = (await copiesOf(dir, 'glob', 'minipass')).find((c) => c.version.startsWith('10.'));
    const theirs = { [`glob@${glob10.version}`]: { minipass: glob10.minipass } };
    await writeJson(file, { ...base, overrides: theirs });
    const glob7Minimatch = async () => (await copiesOf(dir, 'glob', 'minimatch')).find((c) => c.version === '7.2.3').minimatch;
    assert.equal(await glob7Minimatch(), '3.1.1');

    const { vulns } = await computeVulnerabilities({ installed: await loadInstalledVersions(dir), overrides: theirs }, stubFromSnapshot({
      meta: { minimatch: { versions: ['3.1.1', '3.1.2'], distTags: {} } },
      advisories: { minimatch: [{ vulnerable_versions: '<3.1.2', severity: 'high' }] },
    }));
    const vuln = vulns.get('minimatch');
    assert.deepEqual(vuln.instances.find((i) => i.vulnerable).pinRefusal, { kind: 'shadowed', by: Object.keys(theirs)[0] });
    assert.equal(defaultOverrideSelection(vuln), null);

    // Why: npm 11.12+ drops the hoisted copy's pin when the two keys share no
    // package (npm 9 through 11.11 apply both). The refusal holds either way:
    // the lockfile may be regenerated by any npm.
    if (!npmAtLeast('11.12.0')) return;
    await writeJson(file, { ...base, overrides: { ...theirs, 'glob@7.2.3': { minimatch: '3.1.2' } } });
    await install(dir);
    assert.equal(await glob7Minimatch(), '3.1.1');
  });

  it('refuses a parent@version pin that npm would reject against a root dependency range', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-safety-npm-'));
    dirs.push(dir);
    const file = path.join(dir, 'package.json');
    const base = { name: 'nui-safety-app', version: '1.0.0', dependencies: { glob: '^7.2.0', rimraf: '5.0.5' } };
    // "." keeps this temporary pin itself clear of EOVERRIDE.
    await writeJson(file, { ...base, overrides: { 'glob@7.2.3': { '.': '^7.2.0', minimatch: '3.1.1' } } });
    await install(dir);
    await writeJson(file, base);

    const { vulns } = await computeVulnerabilities({ installed: await loadInstalledVersions(dir) }, stubFromSnapshot({
      meta: { minimatch: { versions: ['3.1.1', '3.1.2'], distTags: {} } },
      advisories: { minimatch: [{ vulnerable_versions: '<3.1.2', severity: 'high' }] },
    }));
    const vuln = vulns.get('minimatch');
    assert.deepEqual(vuln.instances.find((i) => i.vulnerable).pinRefusal, {
      kind: 'eoverride', key: 'glob@7.2.3', name: 'glob', rootSpec: '^7.2.0',
    });
    assert.equal(defaultOverrideSelection(vuln), null);

    // Why: the key the tool used to write fails the install outright.
    await writeJson(file, { ...base, overrides: { 'glob@7.2.3': { minimatch: '3.1.2' } } });
    await assert.rejects(install(dir), /EOVERRIDE/);
  });

  it('preserves an active qualified override on an exact transitive dependency', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-safety-npm-'));
    dirs.push(dir);
    // brace-expansion@1.1.11 depends on exactly concat-map 0.0.1; npm 9.9
    // through 12.2 all apply this override. concat-map is a resolution fixture,
    // not an asserted vulnerable package.
    await writeJson(path.join(dir, 'package.json'), {
      name: 'nui-safety-app', version: '1.0.0',
      dependencies: { 'brace-expansion': '1.1.11' },
      overrides: { 'concat-map@0.0.1': '0.0.2' },
    });
    await install(dir);
    const manifest = await loadManifest(dir);
    const installed = await loadInstalledVersions(dir);
    assert.deepEqual([...installed.versions.get('concat-map')], ['0.0.2']);
    const { removableOverrides } = await computeVulnerabilities({ installed, overrides: manifest.json.overrides }, {
      fetchPackageMeta: async () => null,
      fetchBulkAdvisories: async () => ({ ok: true, advisories: new Map() }),
    });
    assert.equal(removableOverrides.has('concat-map@0.0.1'), false);
    await applyUpgrades(manifest, new Map(), {}, [...removableOverrides.keys()]);
    await install(dir);
    assert.deepEqual([...(await loadInstalledVersions(dir)).versions.get('concat-map')], ['0.0.2']);
  });
});
