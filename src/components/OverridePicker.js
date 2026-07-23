import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { isPinnableInstance, defaultScopedChoiceIndex } from '../override-select.js';

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

  return e(
    Box,
    { flexDirection: 'column', marginTop: 1, borderStyle: 'round', paddingX: 1 },
    e(Text, { bold: true }, 'Pin ', e(Text, { color: 'cyanBright' }, name), ' per dependent:'),
    ...pinnable.map((i, idx) =>
      e(
        Box,
        { key: `${i.parentPath}` },
        e(
          Text,
          { color: idx === row ? 'greenBright' : undefined },
          idx === row ? '❯ ' : '  ',
          `${parentLabel(i)} › ${i.installedVersion} → `,
          e(Text, { bold: true }, i.safeCandidates[choices[idx]]),
          i.safeCandidates.length > 1 ? e(Text, { dimColor: true }, ' (←/→)') : null
        )
      )
    ),
    ...others.map((i) =>
      e(
        Box,
        { key: `${i.parentPath}` },
        e(
          Text,
          { dimColor: true },
          `  ${parentLabel(i)} › ${i.installedVersion} `,
          i.vulnerable ? '— no in-range fix, left as is' : '— already safe, left as is'
        )
      )
    ),
    e(
      Box,
      { marginTop: 1 },
      e(Text, { dimColor: true }, '↑/↓ dependent · ←/→ version · <enter> apply · <esc> cancel')
    )
  );
}
