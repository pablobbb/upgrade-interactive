// The demo screen shown in assets/screenshot.png.
//
// Edit this to change what the screenshot shows. Keep the package set stable
// unless there's a reason not to — the image is the first thing on the README,
// and swapping the example packages every time makes the docs look churny.
//
// Nothing here is drawn by hand: rows go through the real components and the
// version-diff colouring comes from colorizeVersionDiff, so the image cannot
// drift from what the tool actually renders.

import React from 'react';
import { Box } from 'ink';
import { repoPath } from './repo.mjs';

const { Prompt } = await import(repoPath('src/components/Prompt.js'));
const { Header } = await import(repoPath('src/components/Header.js'));
const { Row, VulnRow, OverrideRow, SectionHeader } = await import(
  repoPath('src/components/Row.js')
);
const { colorizeVersionDiff } = await import(repoPath('src/semver-suggest.js'));

const e = React.createElement;

const asIs = (v) => ({ spans: [{ text: v, color: null }] });
const diff = (from, to) => ({ spans: colorizeVersionDiff(from, to) });
const EMPTY = { spans: [] };

// [name, current, range, latest, selectedColumn] — null column = not offered.
const DEPENDENCIES = [
  ['chalk', '^4.1.0', '^4.1.2', '^5.3.0', 0],
  ['react', '^18.2.0', '^18.3.1', null, 1],
  ['axios', '^0.21.1', '^0.21.4', '^1.7.2', 2],
];

const DEV_DEPENDENCIES = [
  ['eslint', '^8.57.0', null, '^9.9.0', 0],
  ['vitest', '~1.6.0', '~1.6.1', '~2.0.5', 0],
];

// Which row the cursor sits on.
const FOCUSED = 'react';

const vuln = (o) => ({ url: null, instances: [], pinConflict: false, ...o });

const AXIOS_VULN = vuln({
  severity: 'high',
  cve: 'GHSA-wf5p-g6vw-rhxx',
  affectedRange: '<0.28.0',
  firstPatched: '0.28.0',
});

const MINIMIST_VULN = vuln({
  severity: 'critical',
  cve: 'GHSA-xvch-5gv4-984h',
  affectedRange: '<1.2.6',
  firstPatched: '1.2.6',
  current: '1.2.5',
});

const toRow = ([name, current, range, latest, selectedColumn], rowVuln) =>
  e(Row, {
    key: name,
    name,
    active: name === FOCUSED,
    selectedColumn,
    suggestions: [
      asIs(current),
      range ? diff(current, range) : EMPTY,
      latest ? diff(current, latest) : EMPTY,
    ],
    vuln: rowVuln,
  });

export const screen = e(
  Box,
  { flexDirection: 'column' },
  e(Prompt, { audit: true }),
  e(Header, null),
  e(SectionHeader, { title: 'Dependencies' }),
  ...DEPENDENCIES.map((d) => toRow(d, d[0] === 'axios' ? AXIOS_VULN : undefined)),
  e(SectionHeader, { title: 'Dev dependencies' }),
  ...DEV_DEPENDENCIES.map((d) => toRow(d)),
  e(SectionHeader, { title: 'Override to a safe version' }),
  e(VulnRow, { name: 'minimist', active: false, vuln: MINIMIST_VULN }),
  e(SectionHeader, { title: 'Unused overrides' }),
  e(OverrideRow, { name: 'glob-parent', active: false, pin: '5.1.2', reason: 'dead', staged: false })
);
