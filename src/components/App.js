import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Prompt } from './Prompt.js';
import { Header } from './Header.js';
import { Row, LoadingRow } from './Row.js';
import { fetchSuggestions } from '../semver-suggest.js';
import { mapWithConcurrency } from '../registry.js';

const e = React.createElement;
const CONCURRENCY = 8;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function findNavigable(entries, from, direction) {
  let i = from;
  for (let step = 0; step < entries.length; step++) {
    i += direction;
    if (i < 0 || i >= entries.length) return from;
    if (entries[i] && typeof entries[i] === 'object') return i;
  }
  return from;
}

function firstNavigable(entries) {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] && typeof entries[i] === 'object') return i;
  }
  return -1;
}

export function App({ descriptors, onSubmit, onAbort }) {
  const { exit } = useApp();
  const [entries, setEntries] = useState(() => descriptors.map(() => null));
  const [allLoaded, setAllLoaded] = useState(descriptors.length === 0);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [selectedColumns, setSelectedColumns] = useState({});
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (descriptors.length === 0) return;
    let cancelled = false;

    mapWithConcurrency(
      descriptors,
      CONCURRENCY,
      async (descriptor) => {
        const suggestions = await fetchSuggestions(descriptor);
        return suggestions ? { descriptor, suggestions } : null;
      },
      (result, _descriptor, index) => {
        if (cancelled || !mountedRef.current) return;
        setEntries((prev) => {
          const next = [...prev];
          next[index] = result;
          return next;
        });
      }
    ).then(() => {
      if (cancelled || !mountedRef.current) return;
      setAllLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [descriptors]);

  // Keep focus pinned to a navigable (loaded, upgradeable) row as things load in.
  useEffect(() => {
    if (focusedIndex !== -1 && entries[focusedIndex] && typeof entries[focusedIndex] === 'object') return;
    const next = firstNavigable(entries);
    if (next !== focusedIndex) setFocusedIndex(next);
  }, [entries, focusedIndex]);

  const cycleColumn = useCallback(
    (direction) => {
      if (focusedIndex === -1) return;
      const entry = entries[focusedIndex];
      if (!entry) return;
      const name = entry.descriptor.name;
      const current = selectedColumns[name] ?? 0;
      let next = current;
      for (let step = 0; step < entry.suggestions.length; step++) {
        next = clamp(next + direction, 0, entry.suggestions.length - 1);
        if (entry.suggestions[next].spans.length > 0 || next === 0) break;
        if (next === current) break;
      }
      setSelectedColumns((prev) => ({ ...prev, [name]: next }));
    },
    [focusedIndex, entries, selectedColumns]
  );

  const bulkSelect = useCallback(
    (which) => {
      setSelectedColumns((prev) => {
        const next = { ...prev };
        for (const entry of entries) {
          if (!entry) continue;
          const { name } = entry.descriptor;
          if (which === 'c') {
            next[name] = 0;
          } else if (which === 'r') {
            next[name] = 1;
          } else if (which === 'l') {
            next[name] = entry.suggestions[2].value != null ? 2 : 1;
          }
        }
        return next;
      });
    },
    [entries]
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onAbort();
      exit();
      return;
    }
    if (key.escape) {
      onAbort();
      exit();
      return;
    }
    if (key.upArrow) {
      setFocusedIndex((idx) => findNavigable(entries, idx, -1));
      return;
    }
    if (key.downArrow) {
      setFocusedIndex((idx) => findNavigable(entries, idx, 1));
      return;
    }
    if (key.leftArrow) {
      cycleColumn(-1);
      return;
    }
    if (key.rightArrow) {
      cycleColumn(1);
      return;
    }
    if (input === 'c' || input === 'r' || input === 'l') {
      bulkSelect(input);
      return;
    }
    if (key.return) {
      const selections = new Map();
      for (const entry of entries) {
        if (!entry) continue;
        const col = selectedColumns[entry.descriptor.name] ?? 0;
        const value = entry.suggestions[col]?.value ?? null;
        if (value) selections.set(entry.descriptor.name, value);
      }
      onSubmit(selections);
      exit();
    }
  });

  const displayIndices = allLoaded
    ? entries.map((_, i) => i).filter((i) => entries[i] !== null)
    : entries.map((_, i) => i);

  if (allLoaded && displayIndices.length === 0) {
    return e(
      Box,
      { flexDirection: 'column' },
      e(Prompt, null),
      e(Header, null),
      e(Text, { dimColor: true }, 'No upgrades found.')
    );
  }

  const termRows = (process.stdout && process.stdout.rows) || 24;
  const maxRows = Math.max(5, termRows - 11);
  const posInDisplay = Math.max(0, displayIndices.indexOf(focusedIndex));
  let windowStart = clamp(posInDisplay - Math.floor(maxRows / 2), 0, Math.max(0, displayIndices.length - maxRows));
  const windowEnd = Math.min(displayIndices.length, windowStart + maxRows);
  const visible = displayIndices.slice(windowStart, windowEnd);

  return e(
    Box,
    { flexDirection: 'column' },
    e(Prompt, null),
    e(Header, null),
    windowStart > 0 ? e(Text, { dimColor: true }, `  \u2191 ${windowStart} more above`) : null,
    ...visible.map((i) => {
      const entry = entries[i];
      if (!entry) return e(LoadingRow, { key: i });
      const col = selectedColumns[entry.descriptor.name] ?? 0;
      return e(Row, {
        key: i,
        name: entry.descriptor.name,
        active: i === focusedIndex,
        suggestions: entry.suggestions,
        selectedColumn: col,
      });
    }),
    windowEnd < displayIndices.length ? e(Text, { dimColor: true }, `  \u2193 ${displayIndices.length - windowEnd} more below`) : null
  );
}
