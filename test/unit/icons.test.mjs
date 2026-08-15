// Unit tests for the icon set — guarding the invariant that keeps rows from
// looking stretched.
//
// Ink measures width in two places that do not agree. `measure-text.js` sizes a
// text node with `widest-line` (so, `string-width`), but `output.js` *positions*
// each character by its own rule — `character.fullWidth || value.length > 1`,
// where `fullWidth` is `isFullwidthCodePoint`, which knows about East Asian
// width and nothing about emoji. A Basic-Multilingual-Plane emoji is one UTF-16
// unit and not East-Asian-wide, so Ink advances one column for a glyph a
// terminal may well draw in two, and the row after it shifts.
//
// So the guard is not "is this an emoji" — that question is a proxy. It is: does
// Ink lay this glyph out in the same number of columns a terminal will draw it
// in, and is that number one? `stringWidth` stands in for the terminal, and
// `inkColumns` measures Ink directly by rendering.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import * as icons from '../../src/icons.js';

const e = React.createElement;
const entries = Object.entries(icons);

// Columns Ink believes `glyph` occupies: render it alone in a fixed-width box
// followed by a sentinel, and count the padding Ink emitted to reach the box's
// far edge. No icon contains a space, so every space in the frame is padding.
const CELL = 6;
function inkColumns(glyph) {
  const { lastFrame } = render(
    e(
      Box,
      { flexDirection: 'row' },
      e(Box, { width: CELL, flexShrink: 0 }, e(Text, null, glyph)),
      e(Text, null, '|')
    )
  );
  return CELL - (lastFrame().match(/ /g) || []).length;
}

describe('icons', () => {
  it('exports a non-empty set', () => {
    assert.ok(entries.length > 0, 'icons.js exports nothing');
  });

  for (const [name, glyph] of entries) {
    describe(name, () => {
      it('is a non-empty string', () => {
        assert.equal(typeof glyph, 'string', `${name} is not a string`);
        assert.ok(glyph.length > 0, `${name} is empty`);
      });

      it('is a single code point, with no variation selector', () => {
        const points = [...glyph];
        assert.equal(
          points.length,
          1,
          `${name} is a ${points.length}-code-point sequence — Ink counts a variation ` +
            'selector or ZWJ joiner as a character of its own and advances an extra column ' +
            'for it'
        );
      });

      it('occupies exactly one terminal column', () => {
        assert.equal(
          stringWidth(glyph),
          1,
          `${name} (${glyph}) is ${stringWidth(glyph)} columns wide on a terminal — icons ` +
            'must be one, so that a cell holding one is the width it looks'
        );
      });

      it('is laid out by Ink in the width a terminal draws it', () => {
        const ink = inkColumns(glyph);
        const terminal = stringWidth(glyph);
        assert.equal(
          ink,
          terminal,
          `${name} (${glyph}) is laid out by Ink in ${ink} column(s) but drawn by a terminal ` +
            `in ${terminal} — the mismatch shifts everything after it on the row`
        );
      });
    });
  }
});
