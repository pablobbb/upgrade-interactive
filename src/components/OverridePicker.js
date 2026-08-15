import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { isPinnableInstance, defaultScopedChoiceIndex } from '../override-select.js';
import { windowSlice } from './rows.js';
import { CURSOR, CHILD, BECOMES, SEPARATOR, UP, DOWN, LEFT, RIGHT } from '../icons.js';

const e = React.createElement;

// How many candidate lines an overlay shows at once. `safeVersions` is every
// published version at or above the current one, so a long-lived package can
// easily produce dozens — without a window they render past the bottom of the
// terminal, unreachable.
export const PICKER_MAX_ROWS = 8;
// The read-only tail of the scoped picker (already-safe / no-fix dependents) is
// context, not something to navigate, so it gets a hard cap and a count.
const OTHERS_MAX_ROWS = 3;
// Worst-case total lines an open overlay occupies: its rows, both scroll hints,
// the read-only tail, the border, title and key footer. App subtracts this from
// the main list's budget so the overlay isn't pushed off the bottom.
export const PICKER_MAX_HEIGHT = PICKER_MAX_ROWS + OTHERS_MAX_ROWS + 7;

// The "↑ N more above" / "↓ N more below" hints, matching the main list's.
function ScrollHint({ count, direction }) {
  if (count <= 0) return null;
  return e(Text, { dimColor: true }, `  ${direction === 'up' ? UP : DOWN} ${count} more ${direction === 'up' ? 'above' : 'below'}`);
}

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

  const { visible, above, below } = windowSlice(versions, index, PICKER_MAX_ROWS);

  return e(
    Box,
    { flexDirection: 'column', marginTop: 1, borderStyle: 'round', paddingX: 1 },
    e(Text, { bold: true }, 'Override ', e(Text, { color: 'cyanBright' }, name), ' to a safe version:'),
    e(ScrollHint, { count: above, direction: 'up' }),
    ...visible.map((v, offset) => {
      const i = above + offset;
      return e(
        Box,
        { key: v },
        e(Text, { color: i === index ? 'greenBright' : undefined }, i === index ? `${CURSOR} ` : '  ', v)
      );
    }),
    e(ScrollHint, { count: below, direction: 'down' }),
    e(
      Box,
      { marginTop: 1 },
      e(Text, { dimColor: true }, `${UP}/${DOWN} choose ${SEPARATOR} <enter> apply ${SEPARATOR} <esc> cancel`)
    )
  );
}

/**
 * A picker for the case where a package is installed at several versions across
 * the tree and a single global pin would be wrong. Lists each vulnerable
 * dependent with a per-parent safe version (←/→ to change it), and shows the
 * already-safe / no-in-range-fix instances read-only so it's clear what's being
 * left alone. Enter stages a { scoped: [...] } spec; Esc cancels.
 */
export function ScopedOverridePicker({ name, instances, onSelect, onCancel }) {
  const pinnable = instances.filter(isPinnableInstance);
  const others = instances.filter((i) => !isPinnableInstance(i));
  // Default each row to its newest in-range safe version (bestSafeInRange),
  // shared with the harness so the default can't drift.
  const [choices, setChoices] = useState(() => pinnable.map((i) => defaultScopedChoiceIndex(i)));
  const [row, setRow] = useState(0);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setRow((r) => Math.max(0, r - 1));
    if (key.downArrow) return setRow((r) => Math.min(pinnable.length - 1, r + 1));
    if (key.leftArrow) {
      return setChoices((c) => {
        const n = [...c];
        n[row] = Math.max(0, n[row] - 1);
        return n;
      });
    }
    if (key.rightArrow) {
      return setChoices((c) => {
        const n = [...c];
        n[row] = Math.min(pinnable[row].safeCandidates.length - 1, n[row] + 1);
        return n;
      });
    }
    if (key.return) {
      const scoped = pinnable.map((i, idx) => ({
        parentName: i.parentName,
        parentVersion: i.parentVersion,
        version: i.safeCandidates[choices[idx]],
      }));
      onSelect({ scoped });
    }
  });

  // Show "pkg@version" when the same parent name appears more than once (its
  // copies are being pinned separately), so rows aren't ambiguous.
  const parentCounts = new Map();
  for (const i of instances) {
    if (i.parentName == null) continue;
    parentCounts.set(i.parentName, (parentCounts.get(i.parentName) || 0) + 1);
  }
  const parentLabel = (i) => {
    if (i.parentName == null) return '(direct)';
    if ((parentCounts.get(i.parentName) || 0) > 1 && i.parentVersion) return `${i.parentName}@${i.parentVersion}`;
    return i.parentName;
  };

  const { visible, above, below } = windowSlice(pinnable, row, PICKER_MAX_ROWS);
  const shownOthers = others.slice(0, OTHERS_MAX_ROWS);
  const hiddenOthers = others.length - shownOthers.length;

  return e(
    Box,
    { flexDirection: 'column', marginTop: 1, borderStyle: 'round', paddingX: 1 },
    e(Text, { bold: true }, 'Pin ', e(Text, { color: 'cyanBright' }, name), ' per dependent:'),
    e(ScrollHint, { count: above, direction: 'up' }),
    ...visible.map((i, offset) => {
      const idx = above + offset;
      return e(
        Box,
        { key: `${i.parentPath}` },
        e(
          Text,
          { color: idx === row ? 'greenBright' : undefined },
          idx === row ? `${CURSOR} ` : '  ',
          `${parentLabel(i)} ${CHILD} ${i.installedVersion} ${BECOMES} `,
          e(Text, { bold: true }, i.safeCandidates[choices[idx]]),
          i.safeCandidates.length > 1 ? e(Text, { dimColor: true }, ` (${LEFT}/${RIGHT})`) : null
        )
      );
    }),
    e(ScrollHint, { count: below, direction: 'down' }),
    ...shownOthers.map((i) =>
      e(
        Box,
        { key: `${i.parentPath}` },
        e(
          Text,
          { dimColor: true },
          `  ${parentLabel(i)} ${CHILD} ${i.installedVersion} `,
          i.vulnerable ? '— no in-range fix, left as is' : '— already safe, left as is'
        )
      )
    ),
    hiddenOthers > 0
      ? e(Box, null, e(Text, { dimColor: true }, `  … and ${hiddenOthers} more left as is`))
      : null,
    e(
      Box,
      { marginTop: 1 },
      e(
        Text,
        { dimColor: true },
        `${UP}/${DOWN} dependent ${SEPARATOR} ${LEFT}/${RIGHT} version ${SEPARATOR} <enter> apply ${SEPARATOR} <esc> cancel`
      )
    )
  );
}
