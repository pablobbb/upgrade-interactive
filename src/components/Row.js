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

// Human-readable summary of a staged override for a row: a plain version for a
// global pin, or a per-parent / count summary for scoped pins.
export function overrideLabel(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') return `→ override ${spec}`;
  if (Array.isArray(spec.scoped) && spec.scoped.length > 0) {
    if (spec.scoped.length === 1) {
      const p = spec.scoped[0];
      return p.parentName ? `→ pin ${p.parentName} › ${p.version}` : `→ override ${p.version}`;
    }
    return `→ ${spec.scoped.length} scoped pins`;
  }
  return null;
}

// Why `o` is refused on a flagged row, or null when it isn't. Two manifests in
// the project declare different ranges for this package and npm honors
// `overrides` only at the root, so no single entry can fix both — upgrading each
// workspace's own row is the way out.
export function pinBlockedNote(vuln) {
  if (!vuln || !vuln.pinConflict) return null;
  const conflicted = (vuln.instances || []).find((i) => i.conflict);
  const ranges = conflicted && conflicted.conflictRanges ? conflicted.conflictRanges.join(' vs ') : null;
  const detail = ranges ? ` (${ranges})` : '';
  return `ⓘ workspaces declare different ranges${detail} — upgrade each row instead`;
}

// The ⚠ + severity + CVE link + affected/fixed-in summary shown on a flagged
// row. `hideFixed` drops the "fixed in" suffix when the row already shows the
// fixed version as a column (the override rows), to avoid saying it twice.
function VulnInfo({ vuln, override, hideFixed }) {
  const sev = SEVERITY[vuln.severity] || SEVERITY.low;
  let text = `⚠ ${sev.label} ${hyperlink(vuln.cve, vuln.url)} — affects ${vuln.affectedRange}`;
  if (!hideFixed && vuln.firstPatched) text += ` · fixed in ${vuln.firstPatched}`;
  const label = overrideLabel(override);
  return e(
    Box,
    { marginLeft: 1 },
    e(Text, { color: sev.color }, text),
    label ? e(Text, { color: 'greenBright', bold: true }, `  ${label}`) : null
  );
}

// The current → fixed version pair for a row that has no upgrade columns of its
// own (the override section). Echoes the deps table's columnar layout so the
// two sections scan the same way; a missing side renders as a dim "?".
function FixColumn({ current, fixed }) {
  return e(
    Box,
    { width: 20, flexShrink: 0 },
    current ? e(Text, { color: 'red' }, current) : e(Text, { dimColor: true }, '?'),
    e(Text, { dimColor: true }, ' → '),
    fixed ? e(Text, { color: 'green' }, fixed) : e(Text, { dimColor: true }, '?')
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

// The outer, per-workspace heading. Styled distinctly from SectionHeader (the
// inner field grouping) so the two levels read as different levels: bright and
// unadorned versus the dim underlined field titles nested beneath it. The root
// workspace is labelled "root"; others show "<relPath> (<package name>)".
export function WorkspaceHeader({ relPath, workspace }) {
  const label = relPath === '.' ? 'root' : workspace ? `${relPath} (${workspace})` : relPath;
  return e(Box, { marginTop: 1 }, e(Text, { bold: true, color: 'magentaBright' }, `▌ ${label}`));
}

export function Row({ name, active, suggestions, selectedColumn, vuln, override, overrideNote }) {
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
  // stays readable instead of wrapping past the version columns. `overrideNote`
  // (set only on non-origin rows) explains the staged override lives elsewhere;
  // the blocked note explains why `o` does nothing here.
  const note = overrideNote || pinBlockedNote(vuln);
  return e(
    Box,
    { flexDirection: 'column' },
    main,
    e(
      Box,
      { marginLeft: 4 },
      e(VulnInfo, { vuln, override }),
      note ? e(Text, { dimColor: true }, `  ${note}`) : null
    )
  );
}

// A vulnerable package fixed by an override (transitive, or direct with no
// upgrade available): a current → fixed column pair on top, with the advisory
// detail on its own indented line below — the same two-line shape as Row.
export function VulnRow({ name, active, vuln, override, overrideNote }) {
  const main = e(
    Box,
    { flexDirection: 'row' },
    e(Box, { width: 2, flexShrink: 0 }, e(Text, { color: 'cyanBright', bold: true }, active ? '❯ ' : '  ')),
    e(NameCell, { name }),
    e(FixColumn, { current: vuln.current, fixed: vuln.firstPatched })
  );
  // Hint precedence: nothing to override yet → "press o", or why we can't;
  // staged here → the green badge alone; staged from another row → the
  // read-only "elsewhere" note.
  const blocked = pinBlockedNote(vuln);
  const hint = override
    ? overrideNote
      ? e(Text, { dimColor: true }, `  ${overrideNote}`)
      : null
    : e(Text, { dimColor: true }, blocked ? `  ${blocked}` : '  press o to override');
  return e(
    Box,
    { flexDirection: 'column' },
    main,
    e(Box, { marginLeft: 4 }, e(VulnInfo, { vuln, override, hideFixed: true }), hint)
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
