// Unit tests for buildDisplayRows — the nested-section layout, decoupled from
// React and the network so the workspace sectioning logic is tested directly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDisplayRows, overrideView, nextColumn, bulkColumn, windowSlice } from '../../src/components/rows.js';

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

  it('shows loading placeholders for both audit sections while auditPending', () => {
    const descriptors = [d('chalk', 'dependencies')];
    const rows = buildDisplayRows({
      descriptors,
      entries: loaded(descriptors),
      allLoaded: true,
      vulns: null,
      section: false,
      // Pending wins even if lists somehow arrive — they're empty mid-audit anyway.
      overrideVulns: [['minimist', { severity: 'high' }]],
      removableList: [['leftpad', { pin: '1.3.0', reason: 'dead' }]],
      auditPending: true,
    });

    assert.deepEqual(rows.map((r) => [r.kind, r.key]), [
      ['dep', 'dep:. dependencies chalk'],
      ['header', 'h:pin'],
      ['loading', 'loading:pin'],
      ['header', 'h:unused'],
      ['loading', 'loading:unused'],
    ]);
  });

  it('keeps dep loading rows and audit placeholders distinct while both are pending', () => {
    // Suggestions and the audit can be in flight at the same time; their loading
    // rows must not collide (React needs unique keys to render them).
    const descriptors = [d('a', 'dependencies'), d('b', 'dependencies')];
    const rows = buildDisplayRows({
      descriptors,
      entries: [null, {}], // 'a' still loading, 'b' loaded
      allLoaded: false,
      vulns: null,
      section: false,
      auditPending: true,
    });

    assert.deepEqual(rows.map((r) => [r.kind, r.key]), [
      ['loading', 'loading:0'],
      ['dep', 'dep:. dependencies b'],
      ['header', 'h:pin'],
      ['loading', 'loading:pin'],
      ['header', 'h:unused'],
      ['loading', 'loading:unused'],
    ]);
    const keys = rows.map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, 'row keys are unique');
  });

  it('appends the audit loading placeholders after every workspace section while pending', () => {
    const descriptors = [
      d('chalk', 'dependencies', 'packages/a', '@acme/a'),
      d('zod', 'dependencies', 'packages/b', '@acme/b'),
    ];
    const rows = buildDisplayRows({
      descriptors,
      entries: loaded(descriptors),
      allLoaded: true,
      vulns: null,
      section: false,
      auditPending: true,
    });

    assert.deepEqual(rows.map((r) => r.kind), [
      'wsheader', 'dep', 'wsheader', 'dep', 'header', 'loading', 'header', 'loading',
    ]);
    // The shared audit sections are tree-wide, so they trail both workspaces.
    assert.deepEqual(
      rows.slice(-4).map((r) => r.key),
      ['h:pin', 'loading:pin', 'h:unused', 'loading:unused']
    );
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

// --- Column selection --------------------------------------------------------
// fetchSuggestions always returns three slots and encodes "this package doesn't
// offer that upgrade" as an empty `spans` array, never a missing slot. Because
// it drops any package with fewer than two usable slots, exactly three shapes
// reach the UI — all three are covered below.

const col = (text) => ({ spans: text ? [{ text, color: null }] : [] });
const ALL = [col('^1.0.0'), col('^1.4.0'), col('^2.0.0')]; // current / range / latest
const NO_LATEST = [col('^1.0.0'), col('^1.4.0'), col('')]; // already on the newest major
const NO_RANGE = [col('^1.0.0'), col(''), col('^2.0.0')]; // maxed inside its range

describe('nextColumn', () => {
  it('steps to the neighbouring column when the package offers it', () => {
    assert.equal(nextColumn(ALL, 0, 1), 1);
    assert.equal(nextColumn(ALL, 2, -1), 1);
  });

  it('skips over a column the package does not offer', () => {
    assert.equal(nextColumn(NO_RANGE, 0, 1), 2, 'Current jumps straight to Latest');
    assert.equal(nextColumn(NO_RANGE, 2, -1), 0, 'and back again');
  });

  it('stops at the last column that exists instead of selecting a blank one', () => {
    assert.equal(nextColumn(NO_LATEST, 1, 1), 1, 'Range is the end of the line here');
  });

  it('stays put at both ends of a full row', () => {
    assert.equal(nextColumn(ALL, 2, 1), 2);
    assert.equal(nextColumn(ALL, 0, -1), 0);
  });
});

describe('bulkColumn', () => {
  it('selects the requested column when the package offers it', () => {
    assert.equal(bulkColumn(ALL, 'c'), 0);
    assert.equal(bulkColumn(ALL, 'r'), 1);
    assert.equal(bulkColumn(ALL, 'l'), 2);
  });

  it('falls back to Range when there is no Latest', () => {
    assert.equal(bulkColumn(NO_LATEST, 'l'), 1, 'Range is the highest upgrade on offer');
  });

  it('falls back to Current — not Latest — when there is no Range', () => {
    assert.equal(
      bulkColumn(NO_RANGE, 'r'),
      0,
      '"select every Range" must never stage a major bump on a row that had no in-range option'
    );
  });

  it('always has Current to fall back to', () => {
    assert.equal(bulkColumn(NO_RANGE, 'c'), 0);
    assert.equal(bulkColumn(NO_LATEST, 'c'), 0);
  });
});

// --- Scroll window -----------------------------------------------------------
// Shared by the main list and both override overlays, so a bug here shows up as
// unreachable rows in whichever one is taller than the terminal.

describe('windowSlice', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('returns everything when the list is shorter than the window', () => {
    assert.deepEqual(windowSlice(['a', 'b'], 0, 5), { visible: ['a', 'b'], above: 0, below: 0 });
  });

  it('centers the focused item once the list is longer than the window', () => {
    assert.deepEqual(windowSlice(items, 3, 3), { visible: ['c', 'd', 'e'], above: 2, below: 2 });
  });

  it('anchors to the top rather than scrolling past the first item', () => {
    assert.deepEqual(windowSlice(items, 0, 3), { visible: ['a', 'b', 'c'], above: 0, below: 4 });
  });

  it('anchors to the bottom rather than scrolling past the last item', () => {
    assert.deepEqual(windowSlice(items, 6, 3), { visible: ['e', 'f', 'g'], above: 4, below: 0 });
  });

  it('keeps the focused item inside the slice at every position', () => {
    for (let i = 0; i < items.length; i++) {
      const { visible, above } = windowSlice(items, i, 3);
      assert.equal(visible[i - above], items[i], `focus ${i} must be visible`);
    }
  });

  it('reports no hidden items for an exact fit', () => {
    assert.deepEqual(windowSlice(items, 0, 7), { visible: items, above: 0, below: 0 });
  });
});
