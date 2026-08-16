// Unit tests for the table's column alignment.
//
// The header and the rows arrive at the same columns from different arithmetic:
// a row is a 2-wide cursor gutter, a 45-wide name cell, then 17-wide columns
// whose first two characters are the ●/○ marker, while the header is one wide
// box followed by 17-wide cells. Nothing ties the two together, so the labels
// drift the moment either side's widths are touched. These tests pin them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { Header } from '../../src/components/Header.js';
import { Row } from '../../src/components/Row.js';

const e = React.createElement;
const suggestion = (text) => ({ spans: [{ text }] });

// Deliberately distinct so indexOf can't match one column's text inside
// another's (`4.17.21` is a substring of `^4.17.21`).
const VERSIONS = ['1.1.1', '^2.2.2', '3.3.3'];
const LABELS = ['Current', 'Range', 'Latest'];

function frameLines() {
  const { lastFrame } = render(
    e(
      Box,
      { flexDirection: 'column' },
      e(Header, null),
      e(Row, {
        name: 'lodash',
        active: true,
        selectedColumn: 1,
        suggestions: VERSIONS.map(suggestion),
      })
    )
  );
  const lines = lastFrame().split('\n');
  return {
    header: lines.find((l) => l.includes('Current')),
    row: lines.find((l) => l.includes('lodash')),
  };
}

describe('table alignment', () => {
  it('puts each header label at the column its version text starts in', () => {
    const { header, row } = frameLines();
    assert.ok(header, 'no header line rendered');
    assert.ok(row, 'no row line rendered');

    for (const [i, label] of LABELS.entries()) {
      assert.equal(
        header.indexOf(label),
        row.indexOf(VERSIONS[i]),
        `"${label}" sits at column ${header.indexOf(label)} but its version text starts at ` +
          `${row.indexOf(VERSIONS[i])} — the header and the rows disagree about where the ` +
          'column begins'
      );
    }
  });

  it('leaves the marker hanging to the left of the label', () => {
    const { header, row } = frameLines();
    // The ●/○ belongs to the column but sits outside the label's span, so a
    // column starts two columns before its heading does.
    assert.equal(row.indexOf('○'), header.indexOf('Current') - 2);
  });

  it('fits the header in 100 columns, so it is not shrunk when rows are not', () => {
    // A row needs 2 + 45 + 17*3 = 98 columns and the header 49 + 17*3 = 100. On a
    // 100-column terminal — the width this harness reports — anything wider makes
    // Yoga shrink the header alone, which is its own source of drift.
    const { header } = frameLines();
    assert.ok(header.length <= 100, `header rendered ${header.length} columns wide`);
  });
});
