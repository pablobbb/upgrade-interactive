import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

export function Header() {
  return e(
    Box,
    { flexDirection: 'row', paddingTop: 1, paddingBottom: 1 },
    e(
      Box,
      { width: 50 },
      e(Text, { bold: true }, e(Text, { color: 'greenBright' }, '?'), ' Pick the packages you want to upgrade.')
    ),
    e(Box, { width: 17 }, e(Text, { bold: true, underline: true, color: 'gray' }, 'Current')),
    e(Box, { width: 17 }, e(Text, { bold: true, underline: true, color: 'gray' }, 'Range')),
    e(Box, { width: 17 }, e(Text, { bold: true, underline: true, color: 'gray' }, 'Latest'))
  );
}
