import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

function Spans({ spans, inverse }) {
  if (!spans || spans.length === 0) return e(Text, null, '');
  return e(
    Text,
    { inverse },
    ...spans.map((span, i) => e(Text, { key: i, color: span.color || undefined }, span.text))
  );
}

function Column({ suggestion, selected }) {
  const hasContent = suggestion && suggestion.spans.length > 0;
  return e(
    Box,
    { width: 17 },
    hasContent
      ? e(Text, null, selected ? '\u25CF ' : '\u25CB ', e(Spans, { spans: suggestion.spans, inverse: selected }))
      : e(Text, { dimColor: true }, selected ? '\u25CF' : '')
  );
}

export function Row({ name, active, suggestions, selectedColumn }) {
  const padLength = Math.max(1, 45 - name.length);
  return e(
    Box,
    { flexDirection: 'row' },
    e(Box, { width: 2 }, e(Text, { color: 'cyanBright', bold: true }, active ? '\u276F ' : '  ')),
    e(
      Box,
      { width: 45 },
      e(Text, { bold: true }, name),
      e(Text, null, ' '.repeat(padLength))
    ),
    e(Column, { suggestion: suggestions[0], selected: selectedColumn === 0 }),
    e(Column, { suggestion: suggestions[1], selected: selectedColumn === 1 }),
    e(Column, { suggestion: suggestions[2], selected: selectedColumn === 2 })
  );
}

export function LoadingRow() {
  return e(
    Box,
    { flexDirection: 'row' },
    e(Box, { width: 2 }),
    e(Box, { width: 45 }, e(Text, { dimColor: true }, 'Loading...'))
  );
}
