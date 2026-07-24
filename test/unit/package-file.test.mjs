// Unit tests for manifest loading and the upgrade/override write-back logic.
//
// These use real temp files (no network, no shared state): each test gets a
// fresh throwaway project directory, cleaned up afterwards.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadManifest, applyUpgrades, loadProject, applyProject } from '../../src/package-file.js';

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

  it('writes a null-parent pin as a top-level override when the package is not a direct dep', async () => {
    // Fallback path: a null parent normally means the root project (a direct
    // dependency), but if the name isn't actually in dependencies there is no
    // range to bump, so it degrades to a top-level pin.
    const dir = await project({ 'package.json': pkg({ dependencies: { a: '1.0.0' } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': { scoped: [{ parentName: null, version: '1.3.0' }] },
    });

    assert.deepEqual((await readJson(dir)).overrides, { 'dependency-a': '1.3.0' });
  });

  it('bumps a direct dependency range instead of writing a conflicting top-level override', async () => {
    // npm rejects a top-level override for a package you directly depend on
    // (EOVERRIDE), so the pin must land as a dependency-range bump instead.
    const dir = await project({ 'package.json': pkg({ dependencies: { 'brace-expansion': '^1.1.0' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), { 'brace-expansion': '1.1.16' });

    const json = await readJson(dir);
    assert.equal(json.dependencies['brace-expansion'], '1.1.16', 'the direct dependency range is bumped');
    assert.equal(json.overrides, undefined, 'no overrides block is created');
    assert.deepEqual(res.applied, [
      { name: 'brace-expansion', field: 'dependencies', from: '^1.1.0', to: '1.1.16' },
    ]);
    assert.deepEqual(res.overrides, [], 'the change is reported as an upgrade, not an override');
  });

  it('routes a null-parent scoped pin to a range bump while keeping nested pins as overrides', async () => {
    const dir = await project({ 'package.json': pkg({ devDependencies: { 'dependency-a': '^1.0.0' } }) });
    const m = await loadManifest(dir);

    await applyUpgrades(m, new Map(), {
      'dependency-a': {
        scoped: [
          { parentName: null, version: '1.3.0' },
          { parentName: 'pkg-b', parentVersion: '2.0.0', version: '2.5.0' },
        ],
      },
    });

    const json = await readJson(dir);
    assert.equal(json.devDependencies['dependency-a'], '1.3.0', 'the direct (null-parent) instance bumps the devDependency');
    assert.deepEqual(json.overrides, { 'pkg-b': { 'dependency-a': '2.5.0' } }, 'the nested instance is still written as an override');
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

  it('lets an added override win over a removal targeting the same name', async () => {
    // The user accepted both "override dep1 to 5.0.8" and "drop the unused dep1
    // override (5.0.7)". The addition must survive — not be clobbered by the
    // removal that runs in the same pass.
    const dir = await project({ 'package.json': pkg({ overrides: { dep1: '5.0.7' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), { dep1: '5.0.8' }, ['dep1']);

    assert.deepEqual((await readJson(dir)).overrides, { dep1: '5.0.8' });
    assert.deepEqual(res.overrides, [{ name: 'dep1', to: '5.0.8' }]);
    assert.equal(res.removed.length, 0);
  });

  it('still removes a top-level override when the same-name addition is scoped under a parent', async () => {
    // The scoped addition writes `pkg-a › dep1`, a different key than the
    // top-level `dep1` pin the removal targets — so the removal must still run,
    // dropping the stale top-level pin rather than being shielded by name.
    const dir = await project({ 'package.json': pkg({ overrides: { dep1: '5.0.7' } }) });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(
      m,
      new Map(),
      { dep1: { scoped: [{ parentName: 'pkg-a', version: '5.0.8' }] } },
      ['dep1'],
    );

    assert.deepEqual((await readJson(dir)).overrides, { 'pkg-a': { dep1: '5.0.8' } });
    assert.deepEqual(res.removed, [{ name: 'dep1' }]);
  });

  it('shields only the colliding name, still removing the other staged removals', async () => {
    const dir = await project({
      'package.json': pkg({ overrides: { dep1: '5.0.7', leftpad: '1.3.0' } }),
    });
    const m = await loadManifest(dir);

    const res = await applyUpgrades(m, new Map(), { dep1: '5.0.8' }, ['dep1', 'leftpad']);

    assert.deepEqual((await readJson(dir)).overrides, { dep1: '5.0.8' });
    assert.deepEqual(res.removed, [{ name: 'leftpad' }]);
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

// --- loadProject / applyProject (workspaces) --------------------------------

// Write a package.json into `dir/rel`, creating directories as needed.
async function writePkg(dir, rel, obj) {
  const target = path.join(dir, rel);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'package.json'), pkg(obj), 'utf8');
}
async function readJsonAt(dir, rel) {
  return JSON.parse(await readFile(path.join(dir, rel, 'package.json'), 'utf8'));
}
async function readRawAt(dir, rel) {
  return readFile(path.join(dir, rel, 'package.json'), 'utf8');
}

// A minimal monorepo: root with two workspaces under packages/.
async function monorepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'nui-proj-'));
  tmpDirs.push(dir);
  await writePkg(dir, '.', {
    name: 'root',
    workspaces: ['packages/*'],
    dependencies: { chalk: '^4.0.0' },
  });
  await writePkg(dir, 'packages/a', { name: '@acme/a', dependencies: { chalk: '^4.0.0', lodash: '^4.17.0' } });
  await writePkg(dir, 'packages/b', { name: '@acme/b', devDependencies: { chalk: '^4.0.0' } });
  return dir;
}

describe('loadProject', () => {
  it('presents a standalone package as a one-manifest project (workspace: null)', async () => {
    const dir = await project({ 'package.json': pkg({ dependencies: { chalk: '^4.0.0' } }) });

    const proj = await loadProject(dir);

    assert.equal(proj.manifests.length, 1);
    assert.equal(proj.workspaces, null);
    assert.deepEqual(
      proj.descriptors.map((d) => ({ name: d.name, workspace: d.workspace, id: d.id })),
      [{ name: 'chalk', workspace: null, id: '. dependencies chalk' }]
    );
  });

  it('loads the root first, then each workspace, keeping duplicate names as distinct rows', async () => {
    const dir = await monorepo();

    const proj = await loadProject(dir);

    assert.deepEqual(proj.manifests.map((m) => m.workspace), [null, '@acme/a', '@acme/b']);
    // chalk appears in all three manifests — three distinct descriptors, not one.
    const chalk = proj.descriptors.filter((d) => d.name === 'chalk');
    assert.equal(chalk.length, 3);
    assert.deepEqual(chalk.map((d) => d.id).sort(), [
      '. dependencies chalk',
      `${path.join('packages', 'a')} dependencies chalk`,
      `${path.join('packages', 'b')} devDependencies chalk`,
    ]);
    assert.deepEqual(new Set(proj.descriptors.map((d) => d.id)).size, proj.descriptors.length, 'ids are unique');
  });

  it('skips internal cross-workspace dependencies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-proj-'));
    tmpDirs.push(dir);
    await writePkg(dir, '.', { name: 'root', workspaces: ['packages/*'] });
    await writePkg(dir, 'packages/a', { name: '@acme/a', dependencies: { lodash: '^4.0.0' } });
    // b depends on its sibling @acme/a — should not appear as an upgradable row.
    await writePkg(dir, 'packages/b', { name: '@acme/b', dependencies: { '@acme/a': '^1.0.0', chalk: '^4.0.0' } });

    const proj = await loadProject(dir);

    assert.ok(!proj.descriptors.some((d) => d.name === '@acme/a'), 'sibling dep is excluded');
    assert.deepEqual(proj.descriptors.map((d) => d.name).sort(), ['chalk', 'lodash']);
  });
});

describe('applyProject', () => {
  it('reproduces standalone applyUpgrades behavior byte-for-byte', async () => {
    const original = pkg({ dependencies: { chalk: '^4.0.0', lodash: '^4.17.0' } });
    // Two identical projects: one driven through applyUpgrades, one through applyProject.
    const a = await project({ 'package.json': original });
    const b = await project({ 'package.json': original });

    await applyUpgrades(await loadManifest(a), new Map([['chalk', '^5.0.0']]));
    const proj = await loadProject(b);
    await applyProject(proj, new Map([['. dependencies chalk', '^5.0.0']]));

    assert.equal(await readRaw(a), await readRaw(b), 'same bytes on disk');
  });

  it('writes each selection to only its own workspace manifest', async () => {
    const dir = await monorepo();
    const proj = await loadProject(dir);

    // Upgrade chalk only in workspace a.
    const res = await applyProject(proj, new Map([[`${path.join('packages', 'a')} dependencies chalk`, '^5.0.0']]));

    assert.equal((await readJsonAt(dir, 'packages/a')).dependencies.chalk, '^5.0.0');
    assert.equal((await readJsonAt(dir, '.')).dependencies.chalk, '^4.0.0', 'root untouched');
    assert.equal((await readJsonAt(dir, 'packages/b')).devDependencies.chalk, '^4.0.0', 'workspace b untouched');
    assert.deepEqual(res.applied, [
      { name: 'chalk', field: 'dependencies', from: '^4.0.0', to: '^5.0.0', workspace: '@acme/a' },
    ]);
  });

  it('does not rewrite manifests that have no selected changes', async () => {
    const dir = await monorepo();
    const proj = await loadProject(dir);
    const before = await readRawAt(dir, 'packages/b');

    await applyProject(proj, new Map([[`${path.join('packages', 'a')} dependencies lodash`, '^4.18.0']]));

    assert.equal(await readRawAt(dir, 'packages/b'), before, 'unchanged manifest is left byte-identical');
  });

  it('routes overrides to the root manifest only, even for a child-workspace dependency', async () => {
    const dir = await monorepo();
    const proj = await loadProject(dir);

    // lodash is a direct dep of workspace a, not the root — the override still
    // lands as a top-level pin on the ROOT manifest (npm honors overrides there).
    const res = await applyProject(proj, new Map(), { lodash: '4.17.21' });

    assert.deepEqual((await readJsonAt(dir, '.')).overrides, { lodash: '4.17.21' });
    assert.equal('overrides' in (await readJsonAt(dir, 'packages/a')), false, 'no overrides in the child');
    assert.deepEqual(res.overrides, [{ name: 'lodash', to: '4.17.21' }]);
  });

  it('preserves each manifest\'s own formatting when several change', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nui-proj-'));
    tmpDirs.push(dir);
    await mkdir(path.join(dir, 'packages/a'), { recursive: true });
    // Root uses tabs + no trailing newline; workspace uses 2 spaces + newline.
    await writeFile(path.join(dir, 'package.json'), pkg({ name: 'root', workspaces: ['packages/*'], dependencies: { chalk: '^4.0.0' } }, '\t', false), 'utf8');
    await writeFile(path.join(dir, 'packages/a/package.json'), pkg({ name: 'a', dependencies: { lodash: '^4.0.0' } }, 2, true), 'utf8');

    const proj = await loadProject(dir);
    await applyProject(proj, new Map([
      ['. dependencies chalk', '^5.0.0'],
      [`${path.join('packages', 'a')} dependencies lodash`, '^4.18.0'],
    ]));

    const rootRaw = await readRawAt(dir, '.');
    const wsRaw = await readRawAt(dir, 'packages/a');
    assert.ok(rootRaw.includes('\n\t"'), 'root keeps tabs');
    assert.equal(rootRaw.endsWith('\n'), false, 'root keeps no trailing newline');
    assert.ok(wsRaw.includes('\n  "'), 'workspace keeps 2-space indent');
    assert.equal(wsRaw.endsWith('\n'), true, 'workspace keeps trailing newline');
  });
});
