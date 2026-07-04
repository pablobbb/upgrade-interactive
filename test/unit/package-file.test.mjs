// Unit tests for manifest loading and the upgrade/override write-back logic.
//
// These use real temp files (no network, no shared state): each test gets a
// fresh throwaway project directory, cleaned up afterwards.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadManifest, applyUpgrades } from '../../src/package-file.js';

const tmpDirs = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function project(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nui-pkg-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

const pkg = (obj, indent = 2, trailingNewline = true) =>
  JSON.stringify(obj, null, indent) + (trailingNewline ? '\n' : '');

async function readJson(dir) {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
}
async function readRaw(dir) {
  return readFile(path.join(dir, 'package.json'), 'utf8');
}

// --- loadManifest ------------------------------------------------------------

describe('loadManifest', () => {
  it('extracts and alphabetically sorts descriptors across both fields', async () => {
    const dir = await project({
      'package.json': pkg({ dependencies: { chalk: '^5.0.0', axios: '^1.0.0' }, devDependencies: { zod: '^3.0.0' } }),
    });

    const m = await loadManifest(dir);

    assert.deepEqual(m.descriptors.map((d) => d.name), ['axios', 'chalk', 'zod']);
    assert.equal(m.descriptors.find((d) => d.name === 'zod').field, 'devDependencies');
  });

  it('detects the tab indentation used by the manifest', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }, '\t') });

    const m = await loadManifest(dir);

    assert.equal(m.indent, '\t');
  });

  it('records whether the manifest ended with a trailing newline', async () => {
    const withNl = await project({ 'package.json': '{}\n' });
    const withoutNl = await project({ 'package.json': '{}' });

    assert.equal((await loadManifest(withNl)).trailingNewline, true);
    assert.equal((await loadManifest(withoutNl)).trailingNewline, false);
  });

  it('throws a helpful error when package.json is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-pkg-'));
    tmpDirs.push(dir);

    await assert.rejects(() => loadManifest(dir), /No package\.json found/);
  });

  it('throws when package.json is not valid JSON', async () => {
    const dir = await project({ 'package.json': '{ not json' });

    await assert.rejects(() => loadManifest(dir), /Could not parse/);
  });
});

// --- applyUpgrades -----------------------------------------------------------

describe('applyUpgrades', () => {
  it('applies a changed selection and writes it back to disk', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { chalk: '^4.0.0' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map([['chalk', '^5.0.0']]));

    assert.deepEqual(res.applied, [{ name: 'chalk', field: 'dependencies', from: '^4.0.0', to: '^5.0.0' }]);
    assert.equal((await readJson(dir)).dependencies.chalk, '^5.0.0');
  });

  it('does not apply (or write) a selection equal to the current range', async () => {
    const original = pkg({ dependencies: { chalk: '^4.0.0' } });
    const dir = await project({ 'package.json': original });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map([['chalk', '^4.0.0']]));

    assert.equal(res.applied.length, 0);
    assert.equal(await readRaw(dir), original, 'file should be left untouched');
  });

  it('adds a new npm override, creating the overrides block', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), { minimist: '1.2.6' });

    assert.deepEqual(res.overrides, [{ name: 'minimist', to: '1.2.6' }]);
    assert.deepEqual((await readJson(dir)).overrides, { minimist: '1.2.6' });
  });

  it('writes scoped pins as nested per-parent overrides', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), {
      'dependency-a': {
        scoped: [
          { parentName: 'pkg-a', version: '1.3.0' },
          { parentName: 'pkg-b', version: '0.4.2' },
        ],
      },
    });

    assert.deepEqual(res.overrides, [
      { name: 'dependency-a', to: '1.3.0', parent: 'pkg-a' },
      { name: 'dependency-a', to: '0.4.2', parent: 'pkg-b' },
    ]);
    assert.deepEqual((await readJson(dir)).overrides, {
      'pkg-a': { 'dependency-a': '1.3.0' },
      'pkg-b': { 'dependency-a': '0.4.2' },
    });
  });

  it('qualifies keys with parent@version when one parent needs different child pins', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), {
      'dependency-a': {
        scoped: [
          { parentName: 'pkg-a', parentVersion: '1.0.0', version: '1.3.0' },
          { parentName: 'pkg-a', parentVersion: '2.0.0', version: '2.5.0' },
        ],
      },
    });

    assert.deepEqual((await readJson(dir)).overrides, {
      'pkg-a@1.0.0': { 'dependency-a': '1.3.0' },
      'pkg-a@2.0.0': { 'dependency-a': '2.5.0' },
    });
    assert.deepEqual(res.overrides, [
      { name: 'dependency-a', to: '1.3.0', parent: 'pkg-a@1.0.0' },
      { name: 'dependency-a', to: '2.5.0', parent: 'pkg-a@2.0.0' },
    ]);
  });

  it('keeps a bare parent key when the same parent maps to a single target', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': {
        scoped: [
          { parentName: 'pkg-a', parentVersion: '1.0.0', version: '1.3.0' },
          { parentName: 'pkg-a', parentVersion: '1.0.1', version: '1.3.0' },
        ],
      },
    });

    assert.deepEqual((await readJson(dir)).overrides, { 'pkg-a': { 'dependency-a': '1.3.0' } });
  });

  it('adds a qualified key alongside a pre-existing bare parent override', async () => {
    const dir = await project({ 'package.json': pkg({ overrides: { 'pkg-a': { other: '2.0.0' } } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': {
        scoped: [
          { parentName: 'pkg-a', parentVersion: '1.0.0', version: '1.3.0' },
          { parentName: 'pkg-a', parentVersion: '2.0.0', version: '2.5.0' },
        ],
      },
    });

    assert.deepEqual((await readJson(dir)).overrides, {
      'pkg-a': { other: '2.0.0' },
      'pkg-a@1.0.0': { 'dependency-a': '1.3.0' },
      'pkg-a@2.0.0': { 'dependency-a': '2.5.0' },
    });
  });

  it('qualifies a scoped-package parent name correctly', async () => {
    const dir = await project({ 'package.json': pkg({}) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': {
        scoped: [
          { parentName: '@scope/pkg', parentVersion: '1.0.0', version: '1.3.0' },
          { parentName: '@scope/pkg', parentVersion: '2.0.0', version: '2.5.0' },
        ],
      },
    });

    assert.deepEqual((await readJson(dir)).overrides, {
      '@scope/pkg@1.0.0': { 'dependency-a': '1.3.0' },
      '@scope/pkg@2.0.0': { 'dependency-a': '2.5.0' },
    });
  });

  it('falls back to a bare key when a colliding parent has no recorded version', async () => {
    const dir = await project({ 'package.json': pkg({}) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': {
        scoped: [
          { parentName: 'pkg-a', parentVersion: null, version: '1.3.0' },
          { parentName: 'pkg-a', parentVersion: null, version: '2.5.0' },
        ],
      },
    });

    // Can't disambiguate without versions — one bare key, last write wins.
    assert.deepEqual((await readJson(dir)).overrides, { 'pkg-a': { 'dependency-a': '2.5.0' } });
  });

  it('merges a scoped pin into a parent that already has overrides', async () => {
    const dir = await project({ 'package.json': pkg({ overrides: { 'pkg-a': { other: '2.0.0' } } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': { scoped: [{ parentName: 'pkg-a', version: '1.3.0' }] },
    });

    assert.deepEqual((await readJson(dir)).overrides, {
      'pkg-a': { other: '2.0.0', 'dependency-a': '1.3.0' },
    });
  });

  it('preserves an existing parent-self pin under "." when nesting a child pin', async () => {
    const dir = await project({ 'package.json': pkg({ overrides: { 'pkg-a': '1.5.0' } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': { scoped: [{ parentName: 'pkg-a', version: '1.3.0' }] },
    });

    assert.deepEqual((await readJson(dir)).overrides, {
      'pkg-a': { '.': '1.5.0', 'dependency-a': '1.3.0' },
    });
  });

  it('writes a scoped pin with a null parent as a top-level override', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': { scoped: [{ parentName: null, version: '1.3.0' }] },
    });

    assert.deepEqual((await readJson(dir)).overrides, { 'dependency-a': '1.3.0' });
  });

  it('does not re-add an override that is already at the requested version', async () => {
    const original = pkg({ overrides: { minimist: '1.2.6' } });
    const dir = await project({ 'package.json': original });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), { minimist: '1.2.6' });

    assert.equal(res.overrides.length, 0);
    assert.equal(await readRaw(dir), original, 'file should be left untouched');
  });

  it('removes a named override and drops the block when it becomes empty', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' }, overrides: { leftpad: '1.3.0' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), {}, ['leftpad']);

    assert.deepEqual(res.removed, [{ name: 'leftpad' }]);
    assert.equal('overrides' in (await readJson(dir)), false);
  });

  it('keeps sibling overrides when removing one', async () => {
    const dir = await project({ 'package.json': pkg({ overrides: { leftpad: '1.3.0', minimist: '1.2.6' } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {}, ['leftpad']);

    assert.deepEqual((await readJson(dir)).overrides, { minimist: '1.2.6' });
  });

  it('treats a removal as a no-op when the manifest has no overrides block at all', async () => {
    const original = pkg({ dependencies: { a: '1.0.0' } });
    const dir = await project({ 'package.json': original });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), {}, ['leftpad']);

    assert.equal(res.removed.length, 0);
    assert.equal(await readRaw(dir), original, 'file should be left untouched');
  });

  it('ignores a malformed override spec (neither a version string nor {scoped})', async () => {
    const original = pkg({ dependencies: { a: '1.0.0' } });
    const dir = await project({ 'package.json': original });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), { 'dependency-a': { bogus: true } });

    assert.equal(res.overrides.length, 0);
    assert.equal(await readRaw(dir), original, 'file should be left untouched');
  });

  it('ignores (and does not write for) a removal of an override that is not present', async () => {
    const original = pkg({ overrides: { minimist: '1.2.6' } });
    const dir = await project({ 'package.json': original });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), {}, ['ghost']);

    assert.equal(res.removed.length, 0);
    assert.equal(await readRaw(dir), original, 'file should be left untouched');
  });

  it('preserves the original indentation and trailing-newline style when writing', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }, '\t', false) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map([['a', '2.0.0']]));

    const raw = await readRaw(dir);
    assert.ok(raw.includes('\n\t"dependencies"'), 'should keep tab indentation');
    assert.equal(raw.endsWith('\n'), false, 'should not add a trailing newline');
  });
});
