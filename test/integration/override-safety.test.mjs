// Assert the resolved tree after audit -> selection -> write, not just npm's
// exit code. Advisory data is frozen; npm generates the lockfiles itself.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

    const installed = await loadInstalledVersions(dir);
    const vulnerablePath = 'node_modules/brace-expansion';
    const safePath = 'node_modules/rimraf/node_modules/brace-expansion';
    assert.equal(installed.packages[vulnerablePath].version, '1.1.11');
    assert.equal(installed.packages[safePath].version, '2.1.4');
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
    const after = await loadInstalledVersions(dir);
    assert.equal(after.packages[vulnerablePath].version, '1.1.12');
    assert.equal(after.packages[safePath].version, '2.1.4', 'the safe branch must stay on its own major');
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
    const glob7Minimatch = async () => {
      const { packages } = await loadInstalledVersions(dir);
      return (packages['node_modules/glob/node_modules/minimatch'] || packages['node_modules/minimatch']).version;
    };
    assert.equal(await glob7Minimatch(), '3.1.1');

    const { vulns } = await computeVulnerabilities({ installed: await loadInstalledVersions(dir), overrides: bare }, stubFromSnapshot({
      meta: { minimatch: { versions: ['3.1.1', '3.1.2'], distTags: {} } },
      advisories: { minimatch: [{ vulnerable_versions: '<3.1.2', severity: 'high' }] },
    }));
    const vuln = vulns.get('minimatch');
    assert.deepEqual(vuln.instances.find((i) => i.vulnerable).pinRefusal, { kind: 'shadowed', by: 'glob' });
    assert.equal(defaultOverrideSelection(vuln), null);

    // Why it is refused: npm ignores the pin the tool used to write, in either
    // key order. If this starts failing, npm combines the keys and the refusal
    // can be revisited.
    for (const overrides of [
      { ...bare, 'glob@7.2.3': { minimatch: '3.1.2' } },
      { 'glob@7.2.3': { minimatch: '3.1.2' }, ...bare },
    ]) {
      await writeJson(file, { ...base, overrides });
      await install(dir);
      assert.equal(await glob7Minimatch(), '3.1.1', `npm applied ${JSON.stringify(overrides)}`);
    }
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
    const parentDir = path.join(dir, 'parent');
    await mkdir(parentDir);
    // Use a tarball: npm does not apply this override to a file: directory link.
    // left-pad is a resolution fixture, not an asserted vulnerable package.
    await writeJson(path.join(parentDir, 'package.json'), {
      name: 'nui-safety-parent', version: '1.0.0', dependencies: { 'left-pad': '1.1.0' },
    });
    await npm(parentDir, ['pack', '--ignore-scripts']);
    await writeJson(path.join(dir, 'package.json'), {
      name: 'nui-safety-app', version: '1.0.0',
      dependencies: { 'nui-safety-parent': 'file:./parent/nui-safety-parent-1.0.0.tgz' },
      overrides: { 'left-pad@1.1.0': '1.3.0' },
    });
    await install(dir);
    const manifest = await loadManifest(dir);
    const installed = await loadInstalledVersions(dir);
    assert.deepEqual([...installed.versions.get('left-pad')], ['1.3.0']);
    const { removableOverrides } = await computeVulnerabilities({ installed, overrides: manifest.json.overrides }, {
      fetchPackageMeta: async () => null,
      fetchBulkAdvisories: async () => ({ ok: true, advisories: new Map() }),
    });
    assert.equal(removableOverrides.has('left-pad@1.1.0'), false);
    await applyUpgrades(manifest, new Map(), {}, [...removableOverrides.keys()]);
    await install(dir);
    assert.deepEqual([...(await loadInstalledVersions(dir)).versions.get('left-pad')], ['1.3.0']);
  });
});
