// End-to-end monorepo round-trip on a real filesystem: scaffold an npm
// workspaces repo, discover it, apply a selection scoped to one workspace, and
// assert only that manifest changed. Unlike the unit tests (which call the
// loaders in isolation), this drives the whole chain — findProjectRoot walk-up,
// the glob, the multi-manifest model, and the writer — together. Deterministic
// and offline: no registry, no npm install.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProject, applyProject } from '../../src/package-file.js';
import { loadInstalledVersions } from '../../src/lockfile.js';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';
import { manifestPathsOf } from '../../src/summary.js';
import { defaultOverrideSelection } from '../../src/override-select.js';

const tmpDirs = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scaffoldMonorepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'nui-ws-int-'));
  tmpDirs.push(root);
  const write = async (rel, obj) => {
    await mkdir(path.join(root, rel), { recursive: true });
    await writeFile(path.join(root, rel, 'package.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  };
  await write('.', { name: 'root', workspaces: ['packages/*'], dependencies: { chalk: '^4.0.0' } });
  await write('packages/a', { name: '@acme/a', dependencies: { lodash: '^4.17.0' } });
  await write('packages/b', { name: '@acme/b', devDependencies: { chalk: '^4.0.0' } });
  await mkdir(path.join(root, 'packages/a/src'), { recursive: true }); // a nested working dir
  return root;
}

const readManifest = (dir, rel) => readFile(path.join(dir, rel, 'package.json'), 'utf8');

describe('workspaces — end-to-end round-trip', () => {
  it('discovers the whole tree when run from inside a workspace subdirectory', async () => {
    const root = await scaffoldMonorepo();

    // cwd is packages/a/src — no package.json here; findProjectRoot must walk up.
    const project = await loadProject(path.join(root, 'packages', 'a', 'src'));

    assert.equal(path.dirname(project.root.filePath), root, 'resolves the monorepo root');
    assert.deepEqual(project.manifests.map((m) => m.workspace), [null, '@acme/a', '@acme/b']);
  });

  it('applies a selection to one workspace and leaves the others byte-identical', async () => {
    const root = await scaffoldMonorepo();
    const before = {
      root: await readManifest(root, '.'),
      b: await readManifest(root, 'packages/b'),
    };

    const project = await loadProject(root);
    // Pick the upgrade for lodash in workspace a only, addressed by its id.
    const id = `${path.join('packages', 'a')} dependencies lodash`;
    const res = await applyProject(project, new Map([[id, '^4.18.0']]));

    assert.deepEqual(res.applied, [
      { name: 'lodash', field: 'dependencies', from: '^4.17.0', to: '^4.18.0', workspace: '@acme/a' },
    ]);
    assert.equal(JSON.parse(await readManifest(root, 'packages/a')).dependencies.lodash, '^4.18.0');
    assert.equal(await readManifest(root, '.'), before.root, 'root manifest untouched');
    assert.equal(await readManifest(root, 'packages/b'), before.b, 'workspace b untouched');
  });

  it('routes a root override to the root manifest while upgrading a workspace dep', async () => {
    const root = await scaffoldMonorepo();
    const project = await loadProject(root);

    const id = `${path.join('packages', 'a')} dependencies lodash`;
    await applyProject(project, new Map([[id, '^4.18.0']]), { minimist: '1.2.6' });

    assert.equal(JSON.parse(await readManifest(root, 'packages/a')).dependencies.lodash, '^4.18.0');
    assert.deepEqual(JSON.parse(await readManifest(root, '.')).overrides, { minimist: '1.2.6' });
    assert.equal('overrides' in JSON.parse(await readManifest(root, 'packages/a')), false);
  });

  it('--no-workspaces loads only the root manifest', async () => {
    const root = await scaffoldMonorepo();

    const project = await loadProject(root, { workspaces: false });

    assert.equal(project.manifests.length, 1);
    assert.deepEqual(project.descriptors.map((d) => d.name), ['chalk']); // the root's own dep only
  });

  it('-w scopes the editable rows to a single workspace', async () => {
    const root = await scaffoldMonorepo();

    const project = await loadProject(root, { filter: ['@acme/b'] });

    assert.deepEqual([...new Set(project.descriptors.map((d) => d.workspace))], ['@acme/b']);
    assert.equal(project.manifests.length, 3, 'all manifests stay loaded for root-only overrides');
  });

  // --no-workspaces narrows what the user edits; the installed tree is the same
  // either way. If the audit took its manifest set from the narrowed view it
  // would see one manifest, stop recognising the root/workspace disagreement,
  // and offer a pin that silently rewrites the root to a version only the
  // workspace can accept. Drives the whole chain the CLI does, with a stubbed
  // registry so it stays offline.
  it('still refuses an unpinnable override under --no-workspaces', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nui-ws-int-'));
    tmpDirs.push(root);
    const write = async (rel, obj) => {
      await mkdir(path.join(root, rel), { recursive: true });
      await writeFile(path.join(root, rel, 'package.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
    };
    // The root and the workspace declare ranges no single version satisfies.
    await write('.', { name: 'root', workspaces: ['packages/*'], dependencies: { lodash: '^3.0.0' } });
    await write('packages/a', { name: '@acme/a', dependencies: { lodash: '^4.17.0' } });
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', dependencies: { lodash: '^3.0.0' } },
          'packages/a': { name: '@acme/a', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
          'node_modules/@acme/a': { link: true, resolved: 'packages/a' },
          'node_modules/lodash': { version: '3.10.1' },
          'packages/a/node_modules/lodash': { version: '4.17.11' },
        },
      }),
      'utf8'
    );

    const registry = {
      fetchPackageMeta: async () => ({ versions: ['3.10.1', '4.17.11', '4.17.21'], distTags: {} }),
      fetchBulkAdvisories: async () => ({
        ok: true,
        advisories: new Map([['lodash', [{ vulnerable_versions: '<4.17.19', severity: 'high', url: 'u' }]]]),
      }),
    };

    for (const options of [{}, { workspaces: false }]) {
      const label = options.workspaces === false ? '--no-workspaces' : 'default';
      const project = await loadProject(root, options);
      const rootDir = path.dirname(project.root.filePath);
      const installed = await loadInstalledVersions(rootDir);
      const { vulns } = await computeVulnerabilities(
        { descriptors: project.descriptors, installed, manifestPaths: manifestPathsOf(project, rootDir) },
        registry
      );

      const v = vulns.get('lodash');
      assert.ok(v, `${label}: lodash is flagged`);
      assert.equal(v.pinConflict, true, `${label}: the disagreement is still detected`);
      assert.equal(defaultOverrideSelection(v), null, `${label}: nothing is staged`);
    }
  });
});
