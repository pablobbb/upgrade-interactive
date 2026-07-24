// Unit tests for npm-workspaces discovery: glob expansion and root detection.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandWorkspaces, findProjectRoot, discoverWorkspaces } from '../../src/workspaces.js';

const tmpDirs = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Build a directory tree from a { relPath: manifestObjectOrNull } spec. A null
// value creates the directory without a package.json; a string is written raw.
async function scaffold(tree) {
  const root = await mkdtemp(path.join(tmpdir(), 'nui-ws-'));
  tmpDirs.push(root);
  for (const [rel, manifest] of Object.entries(tree)) {
    const dir = path.join(root, rel);
    await mkdir(dir, { recursive: true });
    if (manifest == null) continue;
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    await writeFile(path.join(dir, 'package.json'), body, 'utf8');
  }
  return root;
}

describe('expandWorkspaces', () => {
  it('expands a "*" segment to each direct subdirectory with a package.json', async () => {
    const root = await scaffold({
      '.': { name: 'root', workspaces: ['packages/*'] },
      'packages/a': { name: '@acme/a' },
      'packages/b': { name: '@acme/b' },
    });

    const ws = await expandWorkspaces(root, ['packages/*']);

    assert.deepEqual(ws.map((w) => w.relPath), [path.join('packages', 'a'), path.join('packages', 'b')]);
    assert.deepEqual(ws.map((w) => w.name), ['@acme/a', '@acme/b']);
  });

  it('accepts the object form { packages: [...] }', async () => {
    const root = await scaffold({
      'packages/a': { name: 'a' },
    });

    const ws = await expandWorkspaces(root, { packages: ['packages/*'] });

    assert.deepEqual(ws.map((w) => w.name), ['a']);
  });

  it('matches literal paths', async () => {
    const root = await scaffold({
      'apps/web': { name: 'web' },
      'apps/api': { name: 'api' },
    });

    const ws = await expandWorkspaces(root, ['apps/web']);

    assert.deepEqual(ws.map((w) => w.relPath), [path.join('apps', 'web')]);
  });

  it('expands a trailing "**" to the directory and all descendants', async () => {
    const root = await scaffold({
      'packages/a': { name: 'a' },
      'packages/group/b': { name: 'b' },
      'packages/group/nested/c': { name: 'c' },
    });

    const ws = await expandWorkspaces(root, ['packages/**']);

    assert.deepEqual(ws.map((w) => w.name).sort(), ['a', 'b', 'c']);
  });

  it('keeps only directories that contain a package.json', async () => {
    const root = await scaffold({
      'packages/a': { name: 'a' },
      'packages/scripts': null, // dir, but no package.json
    });

    const ws = await expandWorkspaces(root, ['packages/*']);

    assert.deepEqual(ws.map((w) => w.relPath), [path.join('packages', 'a')]);
  });

  it('never descends into node_modules', async () => {
    const root = await scaffold({
      'packages/a': { name: 'a' },
      'node_modules/dep': { name: 'dep' },
      'packages/node_modules/hoisted': { name: 'hoisted' },
    });

    const star = await expandWorkspaces(root, ['*/*']);
    const globstar = await expandWorkspaces(root, ['**']);

    assert.ok(!star.some((w) => w.relPath.includes('node_modules')));
    assert.ok(!globstar.some((w) => w.relPath.includes('node_modules')));
    assert.ok(globstar.some((w) => w.name === 'a'));
    assert.ok(!globstar.some((w) => w.name === 'hoisted'));
  });

  it('de-dupes a directory matched by more than one pattern', async () => {
    const root = await scaffold({
      'packages/a': { name: 'a' },
    });

    const ws = await expandWorkspaces(root, ['packages/*', 'packages/a']);

    assert.equal(ws.length, 1);
  });

  it('excludes the root itself', async () => {
    const root = await scaffold({
      '.': { name: 'root', workspaces: ['.', 'packages/a'] },
      'packages/a': { name: 'a' },
    });

    const ws = await expandWorkspaces(root, ['.', 'packages/a']);

    assert.deepEqual(ws.map((w) => w.name), ['a']);
  });

  it('returns an empty list for an empty or malformed field', async () => {
    const root = await scaffold({ '.': { name: 'root' } });

    assert.deepEqual(await expandWorkspaces(root, []), []);
    assert.deepEqual(await expandWorkspaces(root, undefined), []);
    assert.deepEqual(await expandWorkspaces(root, { nope: 1 }), []);
  });
});

describe('findProjectRoot', () => {
  it('returns the root when run from the root directory', async () => {
    const root = await scaffold({
      '.': { name: 'root', workspaces: ['packages/*'] },
      'packages/a': { name: 'a' },
    });

    const found = await findProjectRoot(root);

    assert.equal(found.rootDir, root);
    assert.deepEqual(found.workspaces.map((w) => w.name), ['a']);
  });

  it('walks up from inside a workspace to the owning root', async () => {
    const root = await scaffold({
      '.': { name: 'root', workspaces: ['packages/*'] },
      'packages/a/src': null,
      'packages/a': { name: 'a' },
    });

    const found = await findProjectRoot(path.join(root, 'packages', 'a', 'src'));

    assert.equal(found.rootDir, root);
  });

  it('returns null for a standalone package with no workspaces field', async () => {
    const root = await scaffold({ '.': { name: 'solo' } });

    assert.equal(await findProjectRoot(root), null);
  });

  it('ignores an ancestor workspaces root that does not own cwd', async () => {
    // cwd is a sibling directory not covered by the root's `packages/*` glob.
    const root = await scaffold({
      '.': { name: 'root', workspaces: ['packages/*'] },
      'packages/a': { name: 'a' },
      'unrelated': { name: 'unrelated' },
    });

    const found = await findProjectRoot(path.join(root, 'unrelated'));

    assert.equal(found, null);
  });
});

describe('discoverWorkspaces', () => {
  it('lists the root first, then each workspace', async () => {
    const root = await scaffold({
      '.': { name: 'root', workspaces: ['packages/*'] },
      'packages/a': { name: '@acme/a' },
      'packages/b': { name: '@acme/b' },
    });

    const list = await discoverWorkspaces(root);

    assert.deepEqual(
      list.map((p) => ({ name: p.name, relPath: p.relPath })),
      [
        { name: 'root', relPath: '.' },
        { name: '@acme/a', relPath: path.join('packages', 'a') },
        { name: '@acme/b', relPath: path.join('packages', 'b') },
      ]
    );
  });

  it('returns null for a standalone package', async () => {
    const root = await scaffold({ '.': { name: 'solo' } });

    assert.equal(await discoverWorkspaces(root), null);
  });
});
