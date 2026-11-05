// Unit tests for the CLI's post-submit output and project-shape helpers.
//
// The point of these is regression protection for the *single-package* path:
// workspace support re-keyed the pipeline from bare name to a composite id, and
// nothing else asserts that a standalone project still prints what it always
// printed. Byte-exact assertions, deliberately — that is the whole claim.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  formatSummary,
  formatIgnoredConfigNote,
  formatInstallCheck,
  isMonorepoProject,
  manifestPathsOf,
} from '../../src/summary.js';

/** @import { DependencyField, InstalledCopy } from '../../src/types.js' */

/**
 * @param {string} name
 * @param {DependencyField} field
 * @param {string} from
 * @param {string} to
 * @param {string | null} [workspace]
 */
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

describe('formatIgnoredConfigNote', () => {
  // A project as loadProject returns it: manifests[0] is the root, and `root` is
  // that same object (identity is what separates root from workspace here).
  /** @param {...ReturnType<typeof ws>} workspaces */
  const project = (...workspaces) => {
    const root = { relPath: '.', json: {} };
    return { root, manifests: [root, ...workspaces] };
  };
  /**
   * @param {string} relPath
   * @param {Record<string, unknown>} [config]
   */
  const ws = (relPath, config) => ({
    relPath,
    json: config ? { 'upgrade-interactive': config } : {},
  });
  const ON = { install: true, audit: true, section: true };

  it('says nothing when no workspace carries a config block', () => {
    assert.equal(formatIgnoredConfigNote(project(ws('packages/api')), ON), '');
  });

  it('says nothing for a standalone project, which has only a root manifest', () => {
    assert.equal(formatIgnoredConfigNote(project(), ON), '');
  });

  it('names the file and the key when one workspace overrides a setting', () => {
    const p = project(ws('packages/api', { install: false }));

    assert.equal(
      formatIgnoredConfigNote(p, ON),
      'ⓘ ignoring "upgrade-interactive" in packages/api/package.json (install) — settings come from the root package.json\n'
    );
  });

  // The whole point of naming keys: "config is ignored" sends you to open the
  // file to learn what you lost.
  it('lists every differing key in flag order, not object order', () => {
    const p = project(ws('packages/api', { section: false, install: false }));

    assert.match(formatIgnoredConfigNote(p, ON), /\(install, section\)/);
  });

  it('drops the "/package.json" suffix once several manifests are listed', () => {
    const p = project(ws('packages/api', { install: false }), ws('packages/web', { audit: false }));

    assert.equal(
      formatIgnoredConfigNote(p, ON),
      'ⓘ ignoring "upgrade-interactive" in packages/api (install), packages/web (audit) — ' +
        'settings come from the root package.json\n'
    );
  });

  // Suppression: the note claims something was lost, so it must not fire when
  // the run already resolved to the value the workspace asked for — whether that
  // came from the root block, an env var or a flag.
  it('stays silent when the workspace value matches what the run resolved to', () => {
    const p = project(ws('packages/api', { install: false }));

    assert.equal(formatIgnoredConfigNote(p, { ...ON, install: false }), '');
  });

  it('reports only the keys that differ, not the whole block', () => {
    const p = project(ws('packages/api', { install: false, audit: false }));

    assert.match(formatIgnoredConfigNote(p, { ...ON, audit: false }), /packages\/api\/package\.json \(install\)/);
  });

  it('ignores non-boolean values, which resolveToggle would not honor either', () => {
    const p = project(ws('packages/api', { install: 'false', extra: 1 }));

    assert.equal(formatIgnoredConfigNote(p, ON), '');
  });

  it('normalizes the path to POSIX separators', () => {
    const p = project(ws(['packages', 'api'].join(path.sep), { install: false }));

    assert.match(formatIgnoredConfigNote(p, ON), /packages\/api\/package\.json/);
  });

  // The root's own block is the one being honored — reporting it as ignored
  // would be exactly backwards.
  it('never reports the root manifest', () => {
    const root = { relPath: '.', json: { 'upgrade-interactive': { install: false } } };

    assert.equal(formatIgnoredConfigNote({ root, manifests: [root] }, ON), '');
  });
});

describe('isMonorepoProject', () => {
  /**
   * @param {string} relPath
   * @param {string | null} workspace
   */
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
  // `relPath` arrives already POSIX from expandWorkspaces (asserted there), so
  // these fixtures spell it the way discovery really produces it on every
  // platform, rather than rebuilding it with path.join.
  const tree = [
    { dir: ROOT, relPath: '.', name: 'root' },
    { dir: path.join(ROOT, 'packages', 'a'), relPath: 'packages/a', name: '@acme/a' },
    { dir: path.join(ROOT, 'packages', 'b'), relPath: 'packages/b', name: '@acme/b' },
  ];

  it('is the lockfile root alone for a standalone project', () => {
    assert.deepEqual(manifestPathsOf({ discovered: null }, ROOT), ['']);
  });

  it('lists the root plus each workspace, dropping the root entry', () => {
    assert.deepEqual(manifestPathsOf({ discovered: tree }, ROOT), ['', 'packages/a', 'packages/b']);
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

describe('formatInstallCheck', () => {
  /**
   * @param {string} version
   * @param {[string, string][]} dependents
   * @returns {InstalledCopy}
   */
  const copy = (version, dependents) => ({
    path: 'node_modules/x',
    version,
    dependents: dependents.map(([name, range]) => ({ name, range })),
  });

  it('says nothing when everything landed and nothing is left', () => {
    assert.equal(formatInstallCheck({ notLanded: [], stale: [], stillVulnerable: [] }), '');
  });

  // The 2026-11-04 field report's run, as the CLI would now end it.
  it('names what did not land, the older pins a fix would apply, both routes, and what is left', () => {
    const out = formatInstallCheck({
      notLanded: [
        { name: 'qs', parent: null, pin: '6.17.1', copies: [copy('6.16.0', [['co-body', '^6.5.2']])], inRange: true },
        { name: 'undici', parent: 'jsdom', pin: '7.30.1', copies: [copy('7.30.0', [['jsdom', '^7.25.0']])], inRange: true },
        {
          name: 'glob',
          parent: null,
          pin: '14.0.3',
          copies: [copy('13.0.6', [['@vercel/nft', '^13.0.0'], ['js-beautify', '^13.0.6']])],
          inRange: false,
        },
        {
          name: 'minimatch',
          parent: null,
          pin: '11.0.4',
          copies: [copy('10.2.5', [['editorconfig', '~10.2.4']]), copy('10.2.6', [['readdir-glob', '^10.2.2']])],
          inRange: false,
        },
      ],
      stale: [
        { name: 'vue', parent: null, pin: '3.5.43', installed: ['3.5.44'] },
        { name: 'devalue', parent: null, pin: '5.9.4', installed: ['6.0.3'] },
      ],
      stillVulnerable: [
        {
          name: 'zod',
          versions: ['3.25.76'],
          copies: [copy('3.25.76', [['chromium-bidi', '^3.24.1']])],
          reason: 'outside',
          firstPatched: '4.6.6',
        },
        { name: 'deepmerge', versions: ['4.3.1'], copies: [copy('4.3.1', [['@web/dev-server', '^4.2.2']])], reason: 'unpatched', firstPatched: null },
      ],
    });

    assert.equal(
      out,
      'Not applied: these pins are in package.json, but the lockfile has older versions.\n' +
        '  qs  pins 6.17.1, lockfile has 6.16.0 (co-body declares ^6.5.2)\n' +
        '  jsdom › undici  pins 7.30.1, lockfile has 7.30.0 (jsdom declares ^7.25.0)\n' +
        '  glob  pins 14.0.3, lockfile has 13.0.6 (@vercel/nft declares ^13.0.0, js-beautify ^13.0.6)\n' +
        '  minimatch  pins 11.0.4, lockfile has 10.2.5 (editorconfig declares ~10.2.4), 10.2.6 (readdir-glob declares ^10.2.2)\n' +
        '\n' +
        'Older overrides also not in effect, which the steps below can apply:\n' +
        '  vue  3.5.44 → 3.5.43\n' +
        '  devalue  6.0.3 → 5.9.4 (another major)\n' +
        'Bump or delete those first.\n' +
        '\n' +
        'Inside their declared ranges: delete those pins from package.json, then run\n' +
        '  npm update qs undici\n' +
        'This also moves other copies within their ranges.\n' +
        '\n' +
        'Outside their declared ranges: try\n' +
        '  npm update glob minimatch\n' +
        'Some npm releases apply the pins this way. If the lockfile still has the older versions,\n' +
        'only a full reinstall applies them:\n' +
        '  rm -rf node_modules package-lock.json && npm install\n' +
        'That re-resolves every dependency and can add new advisories.\n' +
        '\n' +
        'Also still vulnerable:\n' +
        '  zod 3.25.76 (chromium-bidi declares ^3.24.1; the first safe version is 4.6.6)\n' +
        '  deepmerge 4.3.1 (no patched version)\n'
    );
  });

  it('gives the in-range route alone, and the update for what is still vulnerable', () => {
    const out = formatInstallCheck({
      notLanded: [{ name: 'qs', parent: null, pin: '6.17.1', copies: [copy('6.16.0', [['co-body', '^6.5.2']])], inRange: true }],
      stale: [],
      stillVulnerable: [
        { name: 'fast-uri', versions: ['3.1.8'], copies: [copy('3.1.8', [['ajv', '^3.0.1']])], reason: 'in-range', firstPatched: '3.1.9' },
      ],
    });

    assert.equal(
      out,
      'Not applied: these pins are in package.json, but the lockfile has older versions.\n' +
        '  qs  pins 6.17.1, lockfile has 6.16.0 (co-body declares ^6.5.2)\n' +
        '\n' +
        'Inside their declared ranges: delete that pin from package.json, then run\n' +
        '  npm update qs\n' +
        'This also moves other copies within their ranges.\n' +
        '\n' +
        'Also still vulnerable:\n' +
        '  fast-uri 3.1.8 (a fix is in range: npm update fast-uri)\n'
    );
  });

  it('heads the list "Still vulnerable" when every pin landed', () => {
    const out = formatInstallCheck({
      notLanded: [],
      stale: [],
      stillVulnerable: [{ name: 'deepmerge', versions: ['4.3.1'], copies: [], reason: 'unpatched', firstPatched: null }],
    });

    assert.equal(out, 'Still vulnerable:\n  deepmerge 4.3.1 (no patched version)\n');
  });
});
