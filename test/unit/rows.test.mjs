// Unit tests for buildDisplayRows — the nested-section layout, decoupled from
// React and the network so the workspace sectioning logic is tested directly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDisplayRows, overrideView } from '../../src/components/rows.js';

// A normalized descriptor, as App produces before building rows.
const d = (name, field, relPath = '.', workspace = null) => ({
  name,
  field,
  relPath,
  workspace,
  id: `${relPath} ${field} ${name}`,
});
const loaded = (descriptors) => descriptors.map(() => ({})); // truthy = suggestion loaded

describe('buildDisplayRows', () => {
  it('renders a standalone project with field headers and no workspace header', () => {
    const descriptors = [d('axios', 'dependencies'), d('chalk', 'dependencies'), d('zod', 'devDependencies')];
    const rows = buildDisplayRows({ descriptors, entries: loaded(descriptors), allLoaded: true, vulns: null, section: true });

    assert.ok(!rows.some((r) => r.kind === 'wsheader'), 'no workspace headers for a lone root');
    assert.deepEqual(
      rows.map((r) => [r.kind, r.key]),
      [
        ['header', 'h:deps:.'],
        ['dep', 'dep:. dependencies axios'],
        ['dep', 'dep:. dependencies chalk'],
        ['header', 'h:dev:.'],
        ['dep', 'dep:. devDependencies zod'],
      ]
    );
  });

  it('renders a flat list (no headers) when section is off', () => {
    const descriptors = [d('axios', 'dependencies'), d('zod', 'devDependencies')];
    const rows = buildDisplayRows({ descriptors, entries: loaded(descriptors), allLoaded: true, vulns: null, section: false });

    assert.deepEqual(rows.map((r) => r.kind), ['dep', 'dep']);
  });

  it('nests field grouping inside a workspace header for each workspace, root first', () => {
    const descriptors = [
      d('chalk', 'dependencies'),
      d('chalk', 'dependencies', 'packages/a', '@acme/a'),
      d('lodash', 'devDependencies', 'packages/a', '@acme/a'),
    ];
    const rows = buildDisplayRows({ descriptors, entries: loaded(descriptors), allLoaded: true, vulns: null, section: true });

    assert.deepEqual(rows.map((r) => [r.kind, r.key]), [
      ['wsheader', 'ws:.'],
      ['header', 'h:deps:.'],
      ['dep', 'dep:. dependencies chalk'],
      ['wsheader', 'ws:packages/a'],
      ['header', 'h:deps:packages/a'],
      ['dep', 'dep:packages/a dependencies chalk'],
      ['header', 'h:dev:packages/a'],
      ['dep', 'dep:packages/a devDependencies lodash'],
    ]);
  });

  it('keeps a duplicated package name as distinct rows with distinct keys', () => {
    const descriptors = [
      d('chalk', 'dependencies', 'packages/a', '@acme/a'),
      d('chalk', 'dependencies', 'packages/b', '@acme/b'),
    ];
    const rows = buildDisplayRows({ descriptors, entries: loaded(descriptors), allLoaded: true, vulns: null, section: false });

    const depKeys = rows.filter((r) => r.kind === 'dep').map((r) => r.key);
    assert.deepEqual(depKeys, ['dep:packages/a dependencies chalk', 'dep:packages/b dependencies chalk']);
    assert.equal(new Set(depKeys).size, 2, 'keys are unique');
  });

  it('carries the workspace name onto the header label fields', () => {
    const descriptors = [d('chalk', 'dependencies'), d('lodash', 'dependencies', 'packages/api', '@acme/api')];
    const rows = buildDisplayRows({ descriptors, entries: loaded(descriptors), allLoaded: true, vulns: null, section: false });

    const wsHeaders = rows.filter((r) => r.kind === 'wsheader');
    assert.deepEqual(wsHeaders, [
      { kind: 'wsheader', key: 'ws:.', relPath: '.', workspace: null },
      { kind: 'wsheader', key: 'ws:packages/api', relPath: 'packages/api', workspace: '@acme/api' },
    ]);
  });

  it('appends the shared override / unused-override sections after all workspaces', () => {
    const descriptors = [d('chalk', 'dependencies', 'packages/a', '@acme/a')];
    const rows = buildDisplayRows({
      descriptors,
      entries: loaded(descriptors),
      allLoaded: true,
      vulns: null,
      section: false,
      overrideVulns: [['minimist', { severity: 'high' }]],
      removableList: [['leftpad', { pin: '1.3.0', reason: 'dead' }]],
    });

    assert.deepEqual(rows.map((r) => [r.kind, r.key]), [
      ['wsheader', 'ws:packages/a'],
      ['dep', 'dep:packages/a dependencies chalk'],
      ['header', 'h:pin'],
      ['vuln', 'vuln:minimist'],
      ['header', 'h:unused'],
      ['override', 'ovr:leftpad'],
    ]);
  });

  it('shows loading rows for not-yet-loaded descriptors before allLoaded', () => {
    const descriptors = [d('a', 'dependencies'), d('b', 'dependencies')];
    const rows = buildDisplayRows({ descriptors, entries: [null, {}], allLoaded: false, vulns: null, section: false });

    assert.deepEqual(rows.map((r) => r.kind), ['loading', 'dep']);
    assert.equal(rows[0].key, 'loading:0');
  });

  it('attaches a vuln to a dep row by package name', () => {
    const descriptors = [d('chalk', 'dependencies')];
    const vuln = { severity: 'high', cve: 'CVE-x' };
    const rows = buildDisplayRows({
      descriptors,
      entries: loaded(descriptors),
      allLoaded: true,
      vulns: new Map([['chalk', vuln]]),
      section: false,
    });

    assert.equal(rows[0].vuln, vuln);
  });
});

describe('overrideView (override provenance)', () => {
  const staged = {
    lodash: { spec: '4.17.21', originKey: 'dep:packages/a dependencies lodash', originLabel: '@acme/a' },
    minimist: { spec: '1.2.6', originKey: 'vuln:minimist', originLabel: null },
  };

  it('returns no spec and no note for a package with nothing staged', () => {
    assert.deepEqual(overrideView(staged, 'chalk', 'dep:. dependencies chalk'), { spec: undefined, note: null });
  });

  it('shows the badge (spec) but no note on the origin row', () => {
    const v = overrideView(staged, 'lodash', 'dep:packages/a dependencies lodash');
    assert.equal(v.spec, '4.17.21');
    assert.equal(v.note, null);
  });

  it('shows the badge and a "staged under <workspace>" note on a non-origin row', () => {
    const v = overrideView(staged, 'lodash', 'dep:packages/b dependencies lodash');
    assert.equal(v.spec, '4.17.21', 'badge still renders on every matching row');
    assert.equal(v.note, 'ⓘ override staged under @acme/a — press o there to change');
  });

  it('uses the "already staged above" phrasing when the origin is the shared vuln section', () => {
    // A different row referencing a shared-section override (originLabel null).
    const v = overrideView(staged, 'minimist', 'dep:packages/z dependencies minimist');
    assert.equal(v.note, 'ⓘ override already staged above — press o there to change');
  });
});
