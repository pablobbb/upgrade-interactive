// Assert the resolved tree after audit -> selection -> write, not just npm's
// exit code. Advisory data is frozen; npm generates the lockfiles itself.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadManifest, applyUpgrades } from '../../src/package-file.js';
import { loadInstalledVersions } from '../../src/lockfile.js';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';

const exec = promisify(execFile);
const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
async function npm(cwd, args) {
  await exec('npm', args, {
    cwd, env: { ...process.env, ASDF_NODEJS_VERSION: process.versions.node }, timeout: 120000,
  });
}
const install = (cwd) => npm(cwd, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);

describe('override safety — real npm resolution', () => {
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
