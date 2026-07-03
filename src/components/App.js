import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Prompt } from './Prompt.js';
import { Header } from './Header.js';
import { Row, VulnRow, OverrideRow, LoadingRow, SectionHeader } from './Row.js';
import { OverridePicker, ScopedOverridePicker } from './OverridePicker.js';
import { fetchSuggestions } from '../semver-suggest.js';
import { mapWithConcurrency } from '../registry.js';
import { loadInstalledVersions } from '../lockfile.js';
import { computeVulnerabilities } from '../vulnerabilities.js';

const e = React.createElement;
const CONCURRENCY = 8;
// Stable reference so `overrides` defaulting doesn't allocate a fresh object
// each render — otherwise the audit effect's deps change every commit and it
// re-runs in an unbounded loop.
const EMPTY_OVERRIDES = Object.freeze({});

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isNavigable(row) {
  return row.kind === 'dep' || row.kind === 'vuln' || row.kind === 'override';
}

async function defaultRunAudit({ cwd, descriptors, overrides }) {
  const installed = await loadInstalledVersions(cwd);
  return computeVulnerabilities({ descriptors, installed, overrides });
}

export function App({
  descriptors,
  onSubmit,
  onAbort,
  audit = false,
  section = false,
  cwd = process.cwd(),
  overrides = EMPTY_OVERRIDES,
  runAudit = defaultRunAudit,
}) {
  const { exit } = useApp();
  const [entries, setEntries] = useState(() => descriptors.map(() => null));
  const [allLoaded, setAllLoaded] = useState(descriptors.length === 0);
  const [focusedKey, setFocusedKey] = useState(null);
  const [selectedColumns, setSelectedColumns] = useState({});
  const [stagedOverrides, setStagedOverrides] = useState({});
  const [stagedRemovals, setStagedRemovals] = useState({}); // { name: true }
  const [auditState, setAuditState] = useState(null); // { offline, vulns, removableOverrides } | null
  const [override, setOverride] = useState(null); // { name, versions } | null
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load upgrade suggestions for each descriptor.
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

  // Check installed + range-resolved versions against npm's advisory database.
  useEffect(() => {
    if (!audit) return;
    let cancelled = false;

    Promise.resolve(runAudit({ cwd, descriptors, overrides }))
      .then((res) => {
        if (cancelled || !mountedRef.current) return;
        setAuditState(res || { offline: false, vulns: new Map() });
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setAuditState({ offline: true, vulns: new Map() });
      });

    return () => {
      cancelled = true;
    };
  }, [audit, cwd, descriptors, overrides, runAudit]);

  // ---- Build the ordered display list (headers + rows) ----------------------
  const vulns = auditState ? auditState.vulns : null;

  const depItems = descriptors.map((descriptor, i) => ({ descriptor, entry: entries[i], i }));
  const visibleDeps = allLoaded ? depItems.filter((x) => x.entry !== null) : depItems;

  const depRow = (x) =>
    x.entry === null
      ? { kind: 'loading', key: `loading:${x.i}` }
      : {
          kind: 'dep',
          key: `dep:${x.descriptor.name}`,
          descriptor: x.descriptor,
          entry: x.entry,
          vuln: vulns ? vulns.get(x.descriptor.name) || null : null,
        };

  // A vuln shows inline on its dep row when that package has an upgrade row;
  // everything else (transitive deps, or direct deps with no upgrade available)
  // falls through to the Overrides section so it's never silently dropped.
  const shownDepNames = new Set(visibleDeps.filter((x) => x.entry !== null).map((x) => x.descriptor.name));
  const overrideVulns = vulns
    ? [...vulns.entries()].filter(([name]) => !shownDepNames.has(name))
    : [];
  const removable = auditState && auditState.removableOverrides ? auditState.removableOverrides : null;
  const removableList = removable ? [...removable.entries()] : [];

  const rows = [];
  // The old single "Overrides" section conflated two different actions, so it's
  // split into a group of vulnerable packages you'd *add* an override for and a
  // group of existing overrides you can *drop*. Each header is independent so an
  // empty group doesn't leave a dangling title.
  const pushOverrides = () => {
    if (overrideVulns.length > 0) {
      rows.push({ kind: 'header', key: 'h:pin', title: 'Override to a safe version' });
      for (const [name, vuln] of overrideVulns) {
        rows.push({ kind: 'vuln', key: `vuln:${name}`, name, vuln });
      }
    }
    if (removableList.length > 0) {
      rows.push({ kind: 'header', key: 'h:unused', title: 'Unused overrides' });
      for (const [name, info] of removableList) {
        rows.push({ kind: 'override', key: `ovr:${name}`, name, pin: info.pin, reason: info.reason });
      }
    }
  };

  if (section) {
    const deps = visibleDeps.filter((x) => x.descriptor.field === 'dependencies');
    const dev = visibleDeps.filter((x) => x.descriptor.field === 'devDependencies');
    if (deps.length > 0) {
      rows.push({ kind: 'header', key: 'h:deps', title: 'Dependencies' });
      for (const x of deps) rows.push(depRow(x));
    }
    if (dev.length > 0) {
      rows.push({ kind: 'header', key: 'h:dev', title: 'Dev dependencies' });
      for (const x of dev) rows.push(depRow(x));
    }
    pushOverrides();
  } else {
    for (const x of visibleDeps) rows.push(depRow(x));
    pushOverrides();
  }

  const navKeys = rows.filter(isNavigable).map((r) => r.key);
  const navKeyStr = navKeys.join('|');
  const focusedRow = rows.find((r) => r.key === focusedKey) || null;

  // Keep focus on a navigable row as things load in / vulns arrive.
  useEffect(() => {
    if (focusedKey && navKeys.includes(focusedKey)) return;
    setFocusedKey(navKeys[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKeyStr, focusedKey]);

  const cycleColumn = useCallback(
    (direction) => {
      if (!focusedRow || focusedRow.kind !== 'dep') return;
      const { suggestions } = focusedRow.entry;
      const name = focusedRow.descriptor.name;
      const current = selectedColumns[name] ?? 0;
      let next = current;
      for (let step = 0; step < suggestions.length; step++) {
        next = clamp(next + direction, 0, suggestions.length - 1);
        if (suggestions[next].spans.length > 0 || next === 0) break;
        if (next === current) break;
      }
      setSelectedColumns((prev) => ({ ...prev, [name]: next }));
    },
    [focusedRow, selectedColumns]
  );

  const bulkSelect = useCallback(
    (which) => {
      setSelectedColumns((prev) => {
        const next = { ...prev };
        for (const entry of entries) {
          if (!entry) continue;
          const { name } = entry.descriptor;
          if (which === 'c') next[name] = 0;
          else if (which === 'r') next[name] = 1;
          else if (which === 'l') next[name] = entry.suggestions[2].value != null ? 2 : 1;
        }
        return next;
      });
    },
    [entries]
  );

  const openOverride = useCallback(() => {
    if (!audit || !focusedRow) return;
    if (focusedRow.kind !== 'dep' && focusedRow.kind !== 'vuln') return;
    const vuln = focusedRow.vuln;
    if (!vuln) return;
    const name = focusedRow.kind === 'dep' ? focusedRow.descriptor.name : focusedRow.name;
    // When the package is installed at several versions across the tree, a
    // single global pin would be wrong — offer per-parent scoped pins instead,
    // as long as at least one vulnerable instance has an in-range fix.
    if (vuln.pinStrategy === 'scoped' && (vuln.instances || []).some((i) => i.vulnerable && i.safeCandidates?.length)) {
      setOverride({ name, mode: 'scoped', instances: vuln.instances });
      return;
    }
    if (!vuln.safeVersions || vuln.safeVersions.length === 0) return;
    setOverride({ name, mode: 'global', versions: vuln.safeVersions });
  }, [audit, focusedRow]);

  const toggleRemoval = useCallback(() => {
    if (!audit || !focusedRow || focusedRow.kind !== 'override') return;
    const { name } = focusedRow;
    setStagedRemovals((prev) => {
      const next = { ...prev };
      if (next[name]) delete next[name];
      else next[name] = true;
      return next;
    });
  }, [audit, focusedRow]);

  const moveFocus = useCallback(
    (direction) => {
      setFocusedKey((cur) => {
        const idx = navKeys.indexOf(cur);
        if (idx === -1) return navKeys[0] ?? null;
        const nextIdx = idx + direction;
        if (nextIdx < 0 || nextIdx >= navKeys.length) return cur;
        return navKeys[nextIdx];
      });
    },
    [navKeyStr] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useInput(
    (input, key) => {
      if ((key.ctrl && input === 'c') || key.escape) {
        onAbort();
        exit();
        return;
      }
      if (key.upArrow) return moveFocus(-1);
      if (key.downArrow) return moveFocus(1);
      if (key.leftArrow) return cycleColumn(-1);
      if (key.rightArrow) return cycleColumn(1);
      if (input === 'o') return openOverride();
      if (input === 'x') return toggleRemoval();
      if (input === 'c' || input === 'r' || input === 'l') return bulkSelect(input);
      if (key.return) {
        const selections = new Map();
        for (const entry of entries) {
          if (!entry) continue;
          const col = selectedColumns[entry.descriptor.name] ?? 0;
          const value = entry.suggestions[col]?.value ?? null;
          if (value) selections.set(entry.descriptor.name, value);
        }
        const removals = Object.keys(stagedRemovals).filter((name) => stagedRemovals[name]);
        onSubmit(selections, { ...stagedOverrides }, removals);
        exit();
      }
    },
    { isActive: override == null }
  );

  const auditDone = !audit || auditState !== null;

  if (allLoaded && auditDone && rows.length === 0) {
    return e(
      Box,
      { flexDirection: 'column' },
      e(Prompt, null),
      e(Header, null),
      e(Text, { dimColor: true }, 'No upgrades found.')
    );
  }

  const termRows = (process.stdout && process.stdout.rows) || 24;
  const maxRows = Math.max(5, termRows - 12);
  const focusedIndex = Math.max(0, rows.findIndex((r) => r.key === focusedKey));
  let windowStart = clamp(focusedIndex - Math.floor(maxRows / 2), 0, Math.max(0, rows.length - maxRows));
  const windowEnd = Math.min(rows.length, windowStart + maxRows);
  const visible = rows.slice(windowStart, windowEnd);

  return e(
    Box,
    { flexDirection: 'column' },
    e(Prompt, { audit }),
    e(Header, null),
    audit && auditState && auditState.offline
      ? e(Text, { color: 'yellow' }, "  ℹ no network — couldn't check for vulnerable packages")
      : null,
    windowStart > 0 ? e(Text, { dimColor: true }, `  ↑ ${windowStart} more above`) : null,
    ...visible.map((row) => {
      if (row.kind === 'header') return e(SectionHeader, { key: row.key, title: row.title });
      if (row.kind === 'loading') return e(LoadingRow, { key: row.key });
      if (row.kind === 'vuln') {
        return e(VulnRow, {
          key: row.key,
          name: row.name,
          active: row.key === focusedKey,
          vuln: row.vuln,
          override: stagedOverrides[row.name],
        });
      }
      if (row.kind === 'override') {
        return e(OverrideRow, {
          key: row.key,
          name: row.name,
          active: row.key === focusedKey,
          pin: row.pin,
          reason: row.reason,
          staged: !!stagedRemovals[row.name],
        });
      }
      const col = selectedColumns[row.descriptor.name] ?? 0;
      return e(Row, {
        key: row.key,
        name: row.descriptor.name,
        active: row.key === focusedKey,
        suggestions: row.entry.suggestions,
        selectedColumn: col,
        vuln: row.vuln,
        override: stagedOverrides[row.descriptor.name],
      });
    }),
    windowEnd < rows.length ? e(Text, { dimColor: true }, `  ↓ ${rows.length - windowEnd} more below`) : null,
    override && override.mode === 'scoped'
      ? e(ScopedOverridePicker, {
          name: override.name,
          instances: override.instances,
          onSelect: (spec) => {
            setStagedOverrides((prev) => ({ ...prev, [override.name]: spec }));
            setOverride(null);
          },
          onCancel: () => setOverride(null),
        })
      : override
        ? e(OverridePicker, {
            name: override.name,
            versions: override.versions,
            onSelect: (version) => {
              setStagedOverrides((prev) => ({ ...prev, [override.name]: version }));
              setOverride(null);
            },
            onCancel: () => setOverride(null),
          })
        : null
  );
}
