import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const e = React.createElement;

/**
 * A small overlay for choosing which safe version to pin a vulnerable package
 * to via npm `overrides`. ↑/↓ move, Enter selects, Esc cancels.
 */
export function OverridePicker({ name, versions, onSelect, onCancel }) {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(versions.length - 1, i + 1));
      return;
    }
    if (key.return) {
      onSelect(versions[index]);
    }
  });

  return e(
    Box,
    { flexDirection: 'column', marginTop: 1, borderStyle: 'round', paddingX: 1 },
    e(Text, { bold: true }, 'Override ', e(Text, { color: 'cyanBright' }, name), ' to a safe version:'),
    ...versions.map((v, i) =>
      e(
        Box,
        { key: v },
        e(Text, { color: i === index ? 'greenBright' : undefined }, i === index ? '❯ ' : '  ', v)
      )
    ),
    e(Box, { marginTop: 1 }, e(Text, { dimColor: true }, '↑/↓ choose · <enter> apply · <esc> cancel'))
  );
}
