import React from 'react';
import { Box, Text } from 'ink';
import { hyperlink } from '../links.js';
import { SEVERITY } from '../vulnerabilities.js';

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
    { width: 17, flexShrink: 0 },
    hasContent
      ? e(Text, null, selected ? '● ' : '○ ', e(Spans, { spans: suggestion.spans, inverse: selected }))
      : e(Text, { dimColor: true }, selected ? '●' : '')
  );
}

// The ⚠ + severity + CVE link + affected/fixed-in summary shown on a flagged row.
function VulnInfo({ vuln, override }) {
  const sev = SEVERITY[vuln.severity] || SEVERITY.low;
  let text = `⚠ ${sev.label} ${hyperlink(vuln.cve, vuln.url)} — affects ${vuln.affectedRange}`;
  if (vuln.firstPatched) text += ` · fixed in ${vuln.firstPatched}`;
  return e(
    Box,
    { marginLeft: 1 },
    e(Text, { color: sev.color }, text),
    override ? e(Text, { color: 'greenBright', bold: true }, `  → override ${override}`) : null
  );
}

function NameCell({ name }) {
  const padLength = Math.max(1, 45 - name.length);
  return e(
    Box,
    { width: 45, flexShrink: 0 },
    e(Text, { bold: true }, name),
    e(Text, null, ' '.repeat(padLength))
  );
}

export function SectionHeader({ title }) {
  return e(Box, { marginTop: 1 }, e(Text, { bold: true, underline: true, color: 'gray' }, title));
}

export function Row({ name, active, suggestions, selectedColumn, vuln, override }) {
  const main = e(
    Box,
    { flexDirection: 'row' },
    e(Box, { width: 2, flexShrink: 0 }, e(Text, { color: 'cyanBright', bold: true }, active ? '❯ ' : '  ')),
    e(NameCell, { name }),
    e(Column, { suggestion: suggestions[0], selected: selectedColumn === 0 }),
    e(Column, { suggestion: suggestions[1], selected: selectedColumn === 1 }),
    e(Column, { suggestion: suggestions[2], selected: selectedColumn === 2 })
  );
  if (!vuln) return main;
  // Put the (potentially long) advisory detail on its own indented line so it
  // stays readable instead of wrapping past the version columns.
  return e(
    Box,
    { flexDirection: 'column' },
    main,
    e(Box, { marginLeft: 4 }, e(VulnInfo, { vuln, override }))
  );
}

// A transitive (indirect) vulnerable package: no upgrade columns, just the
// warning and an override affordance.
export function VulnRow({ name, active, vuln, override }) {
  return e(
    Box,
    { flexDirection: 'row' },
    e(Box, { width: 2, flexShrink: 0 }, e(Text, { color: 'cyanBright', bold: true }, active ? '❯ ' : '  ')),
    e(NameCell, { name }),
    e(VulnInfo, { vuln, override }),
    override ? null : e(Text, { dimColor: true }, '  press o to override')
  );
}

// An existing `overrides` entry that no longer appears to be needed.
export function OverrideRow({ name, active, pin, reason, staged }) {
  const why =
    reason === 'dead' ? 'nothing depends on it anymore' : 'no longer prevents a known vulnerability';
  return e(
    Box,
    { flexDirection: 'row' },
    e(Box, { width: 2, flexShrink: 0 }, e(Text, { color: 'cyanBright', bold: true }, active ? '❯ ' : '  ')),
    e(NameCell, { name }),
    e(
      Box,
      { marginLeft: 1 },
      staged
        ? e(Text, { color: 'greenBright', bold: true }, `✔ removing override ${pin}`)
        : e(
            Text,
            { color: 'gray' },
            `ⓘ override ${pin} not needed (${why}) `,
            e(Text, { dimColor: true }, '— press x to remove')
          )
    )
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
