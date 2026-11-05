// What the CLI reports after `npm install`, against the lockfile real npm writes.
//
// The 2026-11-04 field report's shape, cut down: a workspace reaches co-body (qs
// ^6.5.2) and editorconfig (minimatch ~10.2.4), pins are written for both, and
// npm keeps the locked versions. One pin is inside its dependent's range and one
// isn't, so both of checkInstall's routes are exercised. Needs the registry.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import semver from 'semver';
import { loadProject, applyProject } from '../../src/package-file.js';
import { loadInstalledVersions } from '../../src/lockfile.js';
import { checkInstall } from '../../src/vulnerabilities.js';
import { present } from '../narrow.mjs';

const exec = promisify(execFile);
const env = { ...process.env, ASDF_NODEJS_VERSION: process.versions.node };
/**
 * @param {string} cwd
 * @param {string[]} args
 */
const npm = (cwd, args) => exec('npm', [...args, '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, env, timeout: 120000 });
const { stdout: npmVersion } = await exec('npm', ['--version'], { env });
// Measured on npm 10.9.9, 11.9.0, 11.13.0 and 12.2.0: a new pin doesn't move a
// locked copy that only a workspace reaches, and deleting the pin then running
// `npm update` lands the newest version in range (field report, F1 and F2).
const measured = semver.gte(npmVersion.trim(), '10.9.9');

/** @type {string[]} */
const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} file
 * @param {unknown} value
 */
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function scaffold() {
  const root = await mkdtemp(path.join(tmpdir(), 'nui-install-check-'));
  dirs.push(root);
  await writeFile(path.join(root, '.tool-versions'), `nodejs ${process.versions.node}\n`);
  await writeJson(path.join(root, 'package.json'), { name: 'install-check', private: true, workspaces: ['packages/*'] });
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true });
  await writeJson(path.join(root, 'packages', 'a', 'package.json'), {
    name: 'a',
    version: '1.0.0',
    dependencies: { 'co-body': '6.2.0', editorconfig: '3.0.2' },
  });
  // Lock qs 6.16.0 and minimatch 10.2.6, from before their fixes.
  await npm(root, ['install', '--before=2026-10-01']);
  return root;
}

/** @param {string} root */
async function check(root) {
  const project = await loadProject(root);
  const { packages } = present(await loadInstalledVersions(root), 'lockfile');
  return { project, packages };
}

describe('install check — real npm', () => {
  it('reports the pins npm left unapplied, each under the route that lands it', async () => {
    const root = await scaffold();
    const { overrides: written } = await applyProject(await loadProject(root), new Map(), {
      qs: '6.17.1',
      minimatch: '11.0.4',
    });
    await npm(root, ['install']);

    const { project, packages } = await check(root);
    const { notLanded } = checkInstall(packages, project.root.json.overrides, written, null);

    // Whatever this npm did, the report matches the lockfile it wrote.
    for (const [name, pin] of [['qs', '6.17.1'], ['minimatch', '11.0.4']]) {
      const locked = present(packages[`node_modules/${name}`]?.version, `${name} in the lockfile`);
      assert.equal(notLanded.some((g) => g.name === name), semver.lt(locked, pin), `${name} is reported exactly when ${locked} < ${pin}`);
    }
    if (!measured) return;
    assert.deepEqual(
      notLanded.map((g) => [g.name, g.copies.map((c) => c.version), g.inRange]),
      [['qs', ['6.16.0'], true], ['minimatch', ['10.2.6'], false]]
    );
  });

  // The in-range route the report prints: delete the pin, then `npm update`.
  it('clears an in-range gap with the route it gives', { skip: !measured && `measured on npm 10.9.9+, this is ${npmVersion.trim()}` }, async () => {
    const root = await scaffold();
    const { overrides: written } = await applyProject(await loadProject(root), new Map(), { qs: '6.17.1' });
    await npm(root, ['install']);
    const file = path.join(root, 'package.json');
    const json = JSON.parse(await readFile(file, 'utf8'));
    delete json.overrides;
    await writeJson(file, json);
    await npm(root, ['update', 'qs']);

    const { project, packages } = await check(root);

    assert.ok(semver.gte(present(packages['node_modules/qs']?.version), '6.17.1'), 'npm update reaches the fix');
    assert.deepEqual(checkInstall(packages, project.root.json.overrides, written, null).notLanded, []);
  });
});
