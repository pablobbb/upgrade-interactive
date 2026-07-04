// Unit tests for reading the installed tree out of package-lock.json.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInstalledVersions } from '../../src/lockfile.js';

const tmpDirs = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function projectWithLock(lock) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nui-lock-'));
  tmpDirs.push(dir);
  if (lock !== undefined) {
    await writeFile(path.join(dir, 'package-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock), 'utf8');
  }
  return dir;
}

describe('loadInstalledVersions', () => {
  it('collects installed versions across the tree, including scoped and nested copies', async () => {
    const dir = await projectWithLock({
      packages: {
        '': { dependencies: { chalk: '^5.0.0' } },
        'node_modules/chalk': { version: '5.3.0' },
        'node_modules/@babel/core': { version: '7.24.0' },
        'node_modules/nested/node_modules/chalk': { version: '4.1.2' },
      },
    });

    const res = await loadInstalledVersions(dir);

    assert.deepEqual([...res.versions.get('chalk')].sort(), ['4.1.2', '5.3.0']);
    assert.deepEqual([...res.versions.get('@babel/core')], ['7.24.0']);
  });

  it('derives the direct dependency set from the lockfile root entry', async () => {
    const dir = await projectWithLock({
      packages: {
        '': { dependencies: { chalk: '^5.0.0' }, devDependencies: { eslint: '^9.0.0' } },
        'node_modules/chalk': { version: '5.3.0' },
      },
    });

    const res = await loadInstalledVersions(dir);

    assert.deepEqual([...res.direct].sort(), ['chalk', 'eslint']);
  });

  it('exposes the raw packages map for override analysis', async () => {
    const dir = await projectWithLock({
      packages: { '': {}, 'node_modules/x': { version: '1.0.0', dependencies: { y: '^1.0.0' } } },
    });

    const res = await loadInstalledVersions(dir);

    assert.equal(res.packages['node_modules/x'].dependencies.y, '^1.0.0');
  });

  it('skips the root entry when collecting versions', async () => {
    const dir = await projectWithLock({
      packages: { '': { name: 'root', version: '1.0.0' }, 'node_modules/x': { version: '2.0.0' } },
    });

    const res = await loadInstalledVersions(dir);

    assert.deepEqual([...res.versions.keys()], ['x']);
  });

  it('returns an empty direct set when the lockfile has no root entry', async () => {
    const dir = await projectWithLock({
      packages: { 'node_modules/x': { version: '1.0.0' } },
    });

    const res = await loadInstalledVersions(dir);

    assert.equal(res.direct.size, 0);
    assert.deepEqual([...res.versions.keys()], ['x']);
  });

  it('returns null when there is no lockfile', async () => {
    const dir = await projectWithLock(undefined);

    assert.equal(await loadInstalledVersions(dir), null);
  });

  it('returns null when the lockfile is not valid JSON', async () => {
    const dir = await projectWithLock('not json{');

    assert.equal(await loadInstalledVersions(dir), null);
  });

  it('returns null for a legacy lockfile with no packages map', async () => {
    const dir = await projectWithLock({ dependencies: {} });

    assert.equal(await loadInstalledVersions(dir), null);
  });
});
