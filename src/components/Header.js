import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

export function Header() {
  return e(
    Box,
    { flexDirection: 'row', paddingTop: 1, paddingBottom: 1 },
    // 49 = the cursor gutter (2) + the name cell (45) that precede a row's first
    // column, plus the 2 the ●/○ marker takes inside it, less the marker itself:
    // the labels line up with the version text, and the markers hang to the left
    // of them. It also makes the header exactly 100 columns rather than 101, so a
    // 100-column terminal stops shrinking the header while leaving rows alone.
    e(
      Box,
      { width: 49 },
      e(Text, { bold: true }, e(Text, { color: 'greenBright' }, '?'), ' Pick the packages you want to upgrade.')
    ),
    e(Box, { width: 17 }, e(Text, { bold: true, underline: true, color: 'gray' }, 'Current')),
    e(Box, { width: 17 }, e(Text, { bold: true, underline: true, color: 'gray' }, 'Range')),
    e(Box, { width: 17 }, e(Text, { bold: true, underline: true, color: 'gray' }, 'Latest'))
  );
}
