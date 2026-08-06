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

  it('unions direct deps across the root and every workspace manifest', async () => {
    // A workspaces lockfile: root + two workspaces (plain repo paths), the
    // symlink nodes npm adds (link: true, no version), hoisted installs, and one
    // workspace-local (non-hoisted) install.
    const dir = await projectWithLock({
      packages: {
        '': { name: 'root', dependencies: { chalk: '^5.0.0' } },
        'packages/a': { name: '@acme/a', dependencies: { lodash: '^4.0.0' } },
        'packages/b': { name: '@acme/b', devDependencies: { 'left-pad': '^1.0.0' } },
        'node_modules/@acme/a': { link: true, resolved: 'packages/a' },
        'node_modules/@acme/b': { link: true, resolved: 'packages/b' },
        'node_modules/chalk': { version: '5.3.0' },
        'node_modules/lodash': { version: '4.17.21' }, // hoisted to the root
        'packages/b/node_modules/left-pad': { version: '1.3.0' }, // workspace-local
      },
    });

    const res = await loadInstalledVersions(dir, ['', 'packages/a', 'packages/b']);

    // Direct = union of the root's and both workspaces' declared deps; the
    // symlink names (@acme/a, @acme/b) are dependency records, not direct deps.
    assert.deepEqual([...res.direct].sort(), ['chalk', 'left-pad', 'lodash']);
    // Link entries carry no version, so they never pollute the version map...
    assert.equal(res.versions.has('@acme/a'), false);
    // ...while both hoisted and workspace-local installs are collected.
    assert.deepEqual([...res.versions.get('lodash')], ['4.17.21']);
    assert.deepEqual([...res.versions.get('left-pad')], ['1.3.0']);
  });

  // npm implements workspaces as `file:` links, so a plain local dependency
  // produces a top-level relative-path entry with exactly a workspace's shape.
  // Only the discovered manifest set can tell them apart — a single-package
  // project must keep counting just its own declared deps as direct.
  it('does not treat a file: dependency as one of the project\'s manifests', async () => {
    const dir = await projectWithLock({
      packages: {
        '': { name: 'app', dependencies: { chalk: '^5.0.0', lib: 'file:./lib' } },
        lib: { name: 'lib', version: '1.0.0', dependencies: { lodash: '^4.0.0' } },
        'node_modules/lib': { link: true, resolved: 'lib' },
        'node_modules/chalk': { version: '5.3.0' },
        'node_modules/lodash': { version: '4.17.21' },
      },
    });

    const res = await loadInstalledVersions(dir, ['']);

    assert.deepEqual([...res.direct].sort(), ['chalk', 'lib'], "only the root's own deps are direct");
    assert.equal(res.direct.has('lodash'), false, "the local package's deps are not the project's");
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
