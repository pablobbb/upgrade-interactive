import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

function Key({ children }) {
  return e(Text, { bold: true, color: 'cyanBright' }, children);
}

export function Prompt() {
  return e(
    Box,
    { flexDirection: 'row' },
    e(
      Box,
      { flexDirection: 'column', width: 49 },
      e(
        Box,
        { marginLeft: 1 },
        e(Text, null, 'Press ', e(Key, null, '<up>'), '/', e(Key, null, '<down>'), ' to select packages.')
      ),
      e(
        Box,
        { marginLeft: 1 },
        e(Text, null, 'Press ', e(Key, null, '<left>'), '/', e(Key, null, '<right>'), ' to select versions.')
      ),
      e(
        Box,
        { marginLeft: 1 },
        e(
          Text,
          null,
          'Press ',
          e(Key, null, 'c'),
          '/',
          e(Key, null, 'r'),
          '/',
          e(Key, null, 'l'),
          ' to select all ',
          e(Key, null, 'current'),
          '/',
          e(Key, null, 'range'),
          '/',
          e(Key, null, 'latest'),
          '.'
        )
      )
    ),
    e(
      Box,
      { flexDirection: 'column' },
      e(Box, { marginLeft: 1 }, e(Text, null, 'Press ', e(Key, null, '<enter>'), ' to install.')),
      e(Box, { marginLeft: 1 }, e(Text, null, 'Press ', e(Key, null, '<ctrl+c>'), ' to abort.'))
    )
  );
}
