// Verifies the premise the manifest-set plumbing rests on, against real npm.
//
// npm implements workspaces as `file:` links, so the claim is that an ordinary
// local dependency ("lib": "file:./lib") produces a lockfile entry structurally
// identical to a workspace's — a top-level relative-path key with no
// `node_modules/` segment. If that is true, path shape can never decide which
// lockfile entries are the project's own manifests, and a single-package project
// with a local dependency would otherwise be mistaken for a monorepo.
//
// npm's docs state it ("the link target will also be included in the lockfile"),
// but the whole non-monorepo guarantee depends on it, so assert it rather than
// trust it. Runs npm, so it lives in test:integration.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadInstalledVersions } from '../../src/lockfile.js';
import { computeVulnerabilities } from '../../src/vulnerabilities.js';
import { loadProject } from '../../src/package-file.js';
import { manifestPathsOf } from '../../src/summary.js';

const tmpDirs = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function runNpm(cwd) {
  return new Promise((resolve) => {
    execFile(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund'],
      { cwd, env: { ...process.env, ASDF_NODEJS_VERSION: process.versions.node }, timeout: 120000 },
      (error, stdout, stderr) => {
        // A spawn failure (npm missing, timeout) has a non-numeric code — report
        // it as "never ran" so a missing npm can't pass as a green result.
        const ran = !error || typeof error.code === 'number';
        resolve({ ran, ok: !error, output: `${stdout}\n${stderr}` });
      }
    );
  });
}

// A single-package app depending on a local ./lib, which in turn depends on a
// package the app also depends on — at a different range.
async function scaffoldLocalPathProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'nui-filedep-'));
  tmpDirs.push(dir);
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'app', version: '1.0.0', dependencies: { lib: 'file:./lib', 'left-pad': '^1.2.0' } },
      null,
      2
    ) + '\n',
    'utf8'
  );
  await mkdir(path.join(dir, 'lib'), { recursive: true });
  await writeFile(
    path.join(dir, 'lib', 'package.json'),
    JSON.stringify({ name: 'lib', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }, null, 2) + '\n',
    'utf8'
  );
  return dir;
}

describe('local path (file:) dependencies — real npm lockfile shape', () => {
  it('writes the link target as a top-level relative-path entry, exactly like a workspace', async () => {
    const dir = await scaffoldLocalPathProject();

    const res = await runNpm(dir);
    assert.ok(res.ran, `npm did not run: ${res.output}`);
    assert.ok(res.ok, `npm install failed: ${res.output}`);

    const lock = JSON.parse(await readFile(path.join(dir, 'package-lock.json'), 'utf8'));
    const keys = Object.keys(lock.packages);

    assert.ok(keys.includes('lib'), `expected a top-level "lib" entry, got ${JSON.stringify(keys)}`);
    assert.equal(lock.packages['node_modules/lib'].link, true, 'the node_modules node is a link');
    // The claim in one assertion: the shape test used before this fix
    // ("no node_modules/ segment means it's one of our manifests") says yes for
    // a package that is plainly not one of ours.
    assert.ok(!'lib'.includes('node_modules/'), 'a shape test cannot reject it');
  });

  it('does not classify the local package as a project manifest', async () => {
    const dir = await scaffoldLocalPathProject();
    const res = await runNpm(dir);
    assert.ok(res.ran && res.ok, `npm install failed: ${res.output}`);

    // What the CLI would compute for this project: standalone, root only.
    const project = await loadProject(dir);
    const manifestPaths = manifestPathsOf(project);
    assert.deepEqual(manifestPaths, [''], 'discovery finds no workspaces');

    const installed = await loadInstalledVersions(dir, manifestPaths);
    assert.equal(installed.direct.has('left-pad'), true, "the app's own dep is direct");
    assert.deepEqual(
      [...installed.direct].sort(),
      ['left-pad', 'lib'],
      "only the app's declared deps count as direct — not the local package's"
    );

    // And with no advisories in play the audit stays quiet either way; the point
    // is that nothing here can be flagged as a cross-workspace conflict.
    const { vulns } = await computeVulnerabilities(
      { descriptors: project.descriptors, installed, manifestPaths },
      {
        fetchPackageMeta: async () => null,
        fetchBulkAdvisories: async () => ({ ok: true, advisories: new Map() }),
      }
    );
    assert.ok(![...vulns.values()].some((v) => v.pinConflict), 'no pin conflict in a single-package project');
  });
});
