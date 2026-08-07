// Unit tests for the CLI's post-submit output and project-shape helpers.
//
// The point of these is regression protection for the *single-package* path:
// workspace support re-keyed the pipeline from bare name to a composite id, and
// nothing else asserts that a standalone project still prints what it always
// printed. Byte-exact assertions, deliberately — that is the whole claim.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { formatSummary, isMonorepoProject, manifestPathsOf } from '../../src/summary.js';

const up = (name, field, from, to, workspace = null) => ({ name, field, from, to, workspace });

describe('formatSummary — standalone output', () => {
  it('prints field headers flush-left with no workspace heading', () => {
    const out = formatSummary({
      applied: [up('chalk', 'dependencies', '^4.0.0', '^5.0.0'), up('eslint', 'devDependencies', '^7.0.0', '^8.0.0')],
      isMonorepo: false,
    });

    assert.equal(out, 'dependencies\n  chalk  ^4.0.0 → ^5.0.0\ndevDependencies\n  eslint  ^7.0.0 → ^8.0.0\n');
  });

  it('keeps dependencies before devDependencies regardless of applied order', () => {
    const out = formatSummary({
      applied: [up('eslint', 'devDependencies', '^7.0.0', '^8.0.0'), up('chalk', 'dependencies', '^4.0.0', '^5.0.0')],
      isMonorepo: false,
    });

    assert.equal(out.indexOf('dependencies\n'), 0, 'dependencies heading comes first');
    assert.ok(out.indexOf('  chalk') < out.indexOf('devDependencies'), 'its rows come before the dev section');
  });

  it('omits a field with no changes', () => {
    const out = formatSummary({ applied: [up('chalk', 'dependencies', '^4.0.0', '^5.0.0')], isMonorepo: false });

    assert.equal(out, 'dependencies\n  chalk  ^4.0.0 → ^5.0.0\n');
    assert.ok(!out.includes('devDependencies'));
  });

  it('renders overrides and removals under one flush-left heading', () => {
    const out = formatSummary({
      overrides: [{ name: 'lodash', to: '4.17.21' }, { name: 'minimist', to: '1.2.6', parent: 'pkg-a' }],
      removed: [{ name: 'left-pad' }],
      isMonorepo: false,
    });

    assert.equal(
      out,
      'overrides\n  lodash  → 4.17.21\n  pkg-a › minimist  → 1.2.6\n  left-pad  removed\n'
    );
  });

  it('returns an empty string when nothing changed', () => {
    assert.equal(formatSummary({}), '');
    assert.equal(formatSummary(), '');
  });
});

describe('formatSummary — monorepo output', () => {
  it('adds a per-workspace heading and indents everything beneath it', () => {
    const out = formatSummary({
      applied: [
        up('chalk', 'dependencies', '^4.0.0', '^5.0.0'),
        up('lodash', 'dependencies', '^4.17.0', '^4.17.21', '@acme/a'),
      ],
      isMonorepo: true,
    });

    assert.equal(
      out,
      'root\n  dependencies\n    chalk  ^4.0.0 → ^5.0.0\n' +
        '@acme/a\n  dependencies\n    lodash  ^4.17.0 → ^4.17.21\n'
    );
  });

  it('leaves the overrides block flush-left — overrides are always root-level', () => {
    const out = formatSummary({ overrides: [{ name: 'lodash', to: '4.17.21' }], isMonorepo: true });

    assert.equal(out, 'overrides\n  lodash  → 4.17.21\n');
  });

  // npm allows a workspace with no `name` (it infers one from the directory) and
  // writes it into the lockfile like any other. Labelling it 'root' would file
  // its upgrades under a manifest they were not written to, and would contradict
  // the TUI, whose WorkspaceHeader shows the path in exactly this case.
  it('labels a nameless workspace by its path, not as root', () => {
    const out = formatSummary({
      applied: [
        { name: 'chalk', field: 'dependencies', from: '^4.0.0', to: '^5.0.0', workspace: null, relPath: '.' },
        {
          name: 'lodash',
          field: 'dependencies',
          from: '^4.17.0',
          to: '^4.17.21',
          workspace: null,
          relPath: 'packages/api',
        },
      ],
      isMonorepo: true,
    });

    assert.equal(
      out,
      'root\n  dependencies\n    chalk  ^4.0.0 → ^5.0.0\n' +
        'packages/api\n  dependencies\n    lodash  ^4.17.0 → ^4.17.21\n'
    );
  });
});

describe('isMonorepoProject', () => {
  const d = (relPath, workspace) => ({ name: 'chalk', field: 'dependencies', relPath, workspace });

  it('is false for a standalone project', () => {
    assert.equal(isMonorepoProject({ descriptors: [d('.', null)] }), false);
  });

  it('is false when a workspaces field expands to no workspaces', () => {
    // `project.workspaces` is non-null here (discovery ran and found the root),
    // which is exactly the case the old `project.workspaces != null` check got
    // wrong: it printed a "root" heading for a TUI that showed no header.
    const project = { descriptors: [d('.', null)], workspaces: [{ dir: '/x', name: 'root', relPath: '.' }] };

    assert.equal(isMonorepoProject(project), false);
  });

  it('is true once a descriptor comes from a workspace', () => {
    assert.equal(isMonorepoProject({ descriptors: [d('.', null), d('packages/a', '@acme/a')] }), true);
  });
});

describe('manifestPathsOf', () => {
  const ROOT = path.join(path.sep, 'repo');
  const tree = [
    { dir: ROOT, relPath: '.', name: 'root' },
    { dir: path.join(ROOT, 'packages', 'a'), relPath: path.join('packages', 'a'), name: '@acme/a' },
    { dir: path.join(ROOT, 'packages', 'b'), relPath: path.join('packages', 'b'), name: '@acme/b' },
  ];

  it('is the lockfile root alone for a standalone project', () => {
    assert.deepEqual(manifestPathsOf({ discovered: null }, ROOT), ['']);
  });

  it('lists the root plus each workspace, dropping the root entry', () => {
    assert.deepEqual(manifestPathsOf({ discovered: tree }, ROOT), ['', 'packages/a', 'packages/b']);
  });

  it('normalizes to POSIX separators — lockfile keys never use backslashes', () => {
    const project = { discovered: [{ dir: ROOT, relPath: '.' }, { dir: ROOT, relPath: ['packages', 'a'].join(path.sep) }] };

    assert.deepEqual(manifestPathsOf(project, ROOT), ['', 'packages/a']);
  });

  // --no-workspaces nulls `workspaces` (what is displayed and written) but not
  // `discovered` (what is installed). Reading the former would tell the audit
  // there is one manifest and silently switch off the cross-manifest override
  // conflict check for the very repo that needs it.
  it('reads the real tree even when the display scope is narrowed', () => {
    const project = { workspaces: null, discovered: tree };

    assert.deepEqual(manifestPathsOf(project, ROOT), ['', 'packages/a', 'packages/b']);
  });

  // Under --no-workspaces from inside a workspace, the lockfile being read is
  // that workspace's own directory; paths relative to the monorepo root would
  // describe a different tree.
  it('ignores a tree rooted somewhere other than the lockfile directory', () => {
    const project = { workspaces: null, discovered: tree };

    assert.deepEqual(manifestPathsOf(project, path.join(ROOT, 'packages', 'a')), ['']);
  });
});
