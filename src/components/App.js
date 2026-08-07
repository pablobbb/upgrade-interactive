import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Prompt } from './Prompt.js';
import { Header } from './Header.js';
import { Row, VulnRow, OverrideRow, LoadingRow, SectionHeader, WorkspaceHeader } from './Row.js';
import { buildDisplayRows, overrideView } from './rows.js';
import { OverridePicker, ScopedOverridePicker } from './OverridePicker.js';
import { fetchSuggestions } from '../semver-suggest.js';
import { mapWithConcurrency } from '../registry.js';
import { loadInstalledVersions } from '../lockfile.js';
import { computeVulnerabilities } from '../vulnerabilities.js';
import { shouldScope, isPinBlocked } from '../override-select.js';

const e = React.createElement;
const CONCURRENCY = 8;
// Stable reference so `overrides` defaulting doesn't allocate a fresh object
// each render — otherwise the audit effect's deps change every commit and it
// re-runs in an unbounded loop.
const EMPTY_OVERRIDES = Object.freeze({});
// A standalone project's only manifest is the lockfile root. Stable reference
// for the same reason EMPTY_OVERRIDES is one — it feeds the audit effect's deps.
const ROOT_ONLY_MANIFESTS = Object.freeze(['']);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isNavigable(row) {
  return row.kind === 'dep' || row.kind === 'vuln' || row.kind === 'override';
}

/** The package name a row stages an override for, or null if it stages none. */
function overrideNameOf(row) {
  if (row.kind === 'dep') return row.descriptor.name;
  if (row.kind === 'vuln') return row.name;
  return null;
}

// The workspace label shown for an override staged from `row`. A dep row is
// owned by its workspace (the root manifest has no display name, so label it
// "root"); a shared vuln-section row has no owning workspace, and a null label
// renders as "already staged above" instead.
function originLabelOf(row) {
  return row.kind === 'dep' ? (row.descriptor.workspace ?? 'root') : null;
}

async function defaultRunAudit({ cwd, descriptors, overrides, manifestPaths }) {
  const installed = await loadInstalledVersions(cwd);
  return computeVulnerabilities({ descriptors, installed, overrides, manifestPaths });
}

export function App({
  descriptors,
  onSubmit,
  onAbort,
  audit = false,
  section = false,
  cwd = process.cwd(),
  overrides = EMPTY_OVERRIDES,
  // Lockfile-style keys for this project's own manifests: [''] standalone, plus
  // one relative path per workspace. Lets the audit tell a workspace apart from
  // an ordinary `file:` dependency, which has the identical lockfile shape.
  manifestPaths = ROOT_ONLY_MANIFESTS,
  runAudit = defaultRunAudit,
  // Injectable for the same reason `runAudit` is: it's the other network call,
  // and a test that needs to control *when* a row finishes loading (relative to
  // the audit) can't do it with sleeps against the live registry.
  loadSuggestions = fetchSuggestions,
}) {
  const { exit } = useApp();
  // Normalize once so single-package callers (plain { name, range, field }
  // descriptors) and workspace callers share one code path. Memoized on the
  // descriptors prop so the audit/suggestion effects don't re-run every render.
  const normDescriptors = useMemo(
    () =>
      descriptors.map((d) => ({
        ...d,
        id: d.id ?? d.name,
        workspace: d.workspace ?? null,
        relPath: d.relPath ?? '.',
      })),
    [descriptors]
  );
  const [entries, setEntries] = useState(() => normDescriptors.map(() => null));
  const [allLoaded, setAllLoaded] = useState(normDescriptors.length === 0);
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
    if (normDescriptors.length === 0) return;
    let cancelled = false;

    mapWithConcurrency(
      normDescriptors,
      CONCURRENCY,
      async (descriptor) => {
        const suggestions = await loadSuggestions(descriptor);
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
  }, [normDescriptors, loadSuggestions]);

  // Check installed + range-resolved versions against npm's advisory database.
  useEffect(() => {
    if (!audit) return;
    let cancelled = false;

    Promise.resolve(runAudit({ cwd, descriptors: normDescriptors, overrides, manifestPaths }))
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
  }, [audit, cwd, normDescriptors, overrides, manifestPaths, runAudit]);

  // ---- Build the ordered display list (headers + rows) ----------------------
  const vulns = auditState ? auditState.vulns : null;

  // A vuln shows inline on its dep row when that package has an upgrade row in
  // *any* workspace; everything else (transitive deps, or direct deps with no
  // upgrade available) falls through to the shared Overrides section so it's
  // never silently dropped. Keyed by name, so it generalizes across workspaces.
  const loadedNames = normDescriptors
    .map((d, i) => (entries[i] !== null ? d.name : null))
    .filter((name) => name !== null);
  const shownDepNames = new Set(loadedNames);
  const overrideVulns = vulns
    ? [...vulns.entries()].filter(([name]) => !shownDepNames.has(name))
    : [];
  const removable = auditState && auditState.removableOverrides ? auditState.removableOverrides : null;
  const removableList = removable ? [...removable.entries()] : [];
  // Audit requested but not yet resolved — the override sections show loading
  // placeholders until `runAudit` returns.
  const auditPending = audit && auditState === null;

  const rows = buildDisplayRows({
    descriptors: normDescriptors,
    entries,
    allLoaded,
    vulns,
    section,
    overrideVulns,
    removableList,
    auditPending,
  });

  const navKeys = rows.filter(isNavigable).map((r) => r.key);
  const navKeyStr = navKeys.join('|');
  const focusedRow = rows.find((r) => r.key === focusedKey) || null;

  // Keep focus on a navigable row as things load in / vulns arrive.
  useEffect(() => {
    if (focusedKey && navKeys.includes(focusedKey)) return;
    setFocusedKey(navKeys[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKeyStr, focusedKey]);

  // Re-home a staged override whose origin row has disappeared. A `vuln:<name>`
  // row is dropped from the shared section as soon as that package's own
  // suggestions load, so an override staged from it during that window would
  // otherwise be locked forever: `o` would no-op on every remaining row while
  // the note pointed at a row that no longer renders.
  useEffect(() => {
    setStagedOverrides((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [name, record] of Object.entries(prev)) {
        if (navKeys.includes(record.originKey)) continue;
        const home = rows.find((r) => overrideNameOf(r) === name);
        if (!home) continue; // nothing owns it right now — leave the record alone
        next[name] = { ...record, originKey: home.key, originLabel: originLabelOf(home) };
        changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKeyStr]);

  const cycleColumn = useCallback(
    (direction) => {
      if (!focusedRow || focusedRow.kind !== 'dep') return;
      const { suggestions } = focusedRow.entry;
      const id = focusedRow.descriptor.id;
      const current = selectedColumns[id] ?? 0;
      let next = current;
      for (let step = 0; step < suggestions.length; step++) {
        next = clamp(next + direction, 0, suggestions.length - 1);
        if (suggestions[next].spans.length > 0 || next === 0) break;
        if (next === current) break;
      }
      setSelectedColumns((prev) => ({ ...prev, [id]: next }));
    },
    [focusedRow, selectedColumns]
  );

  const bulkSelect = useCallback(
    (which) => {
      setSelectedColumns((prev) => {
        const next = { ...prev };
        for (const entry of entries) {
          if (!entry) continue;
          const { id } = entry.descriptor;
          if (which === 'c') next[id] = 0;
          else if (which === 'r') next[id] = 1;
          else if (which === 'l') next[id] = entry.suggestions[2].value != null ? 2 : 1;
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
    // Nothing is expressible for this package — the row says why.
    if (isPinBlocked(vuln)) return;
    const name = overrideNameOf(focusedRow);
    // Provenance: an override for this package staged from a *different* row can
    // only be edited from that origin row. Editing from the origin (or a first
    // stage) is allowed; `o` on any other matching row is a no-op — but only
    // while the origin row is still on screen, so a vanished origin can never
    // leave the override uneditable.
    const existing = stagedOverrides[name];
    if (existing && existing.originKey !== focusedRow.key && navKeys.includes(existing.originKey)) return;
    const originKey = focusedRow.key;
    const originLabel = originLabelOf(focusedRow);
    // When the package is installed at several versions across the tree, a
    // single global pin would be wrong — offer per-parent scoped pins instead,
    // as long as at least one vulnerable instance has an in-range fix.
    if (shouldScope(vuln)) {
      setOverride({ name, mode: 'scoped', instances: vuln.instances, originKey, originLabel });
      return;
    }
    if (!vuln.safeVersions || vuln.safeVersions.length === 0) return;
    setOverride({ name, mode: 'global', versions: vuln.safeVersions, originKey, originLabel });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audit, focusedRow, stagedOverrides, navKeyStr]);

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
          const col = selectedColumns[entry.descriptor.id] ?? 0;
          const value = entry.suggestions[col]?.value ?? null;
          if (value) selections.set(entry.descriptor.id, value);
        }
        const removals = Object.keys(stagedRemovals).filter((name) => stagedRemovals[name]);
        // Unwrap the provenance records back to the plain { name: spec } map the
        // writer expects — origin bookkeeping is a UI-only concern.
        const overrideSpecs = {};
        for (const [name, record] of Object.entries(stagedOverrides)) overrideSpecs[name] = record.spec;
        onSubmit(selections, overrideSpecs, removals);
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
      if (row.kind === 'wsheader') {
        return e(WorkspaceHeader, { key: row.key, relPath: row.relPath, workspace: row.workspace });
      }
      if (row.kind === 'header') return e(SectionHeader, { key: row.key, title: row.title });
      if (row.kind === 'loading') return e(LoadingRow, { key: row.key });
      if (row.kind === 'vuln') {
        const ov = overrideView(stagedOverrides, row.name, row.key);
        return e(VulnRow, {
          key: row.key,
          name: row.name,
          active: row.key === focusedKey,
          vuln: row.vuln,
          override: ov.spec,
          overrideNote: ov.note,
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
      const col = selectedColumns[row.descriptor.id] ?? 0;
      const ov = overrideView(stagedOverrides, row.descriptor.name, row.key);
      return e(Row, {
        key: row.key,
        name: row.descriptor.name,
        active: row.key === focusedKey,
        suggestions: row.entry.suggestions,
        selectedColumn: col,
        vuln: row.vuln,
        override: ov.spec,
        overrideNote: ov.note,
      });
    }),
    windowEnd < rows.length ? e(Text, { dimColor: true }, `  ↓ ${rows.length - windowEnd} more below`) : null,
    override && override.mode === 'scoped'
      ? e(ScopedOverridePicker, {
          name: override.name,
          instances: override.instances,
          onSelect: (spec) => {
            setStagedOverrides((prev) => ({
              ...prev,
              [override.name]: { spec, originKey: override.originKey, originLabel: override.originLabel },
            }));
            setOverride(null);
          },
          onCancel: () => setOverride(null),
        })
      : override
        ? e(OverridePicker, {
            name: override.name,
            versions: override.versions,
            onSelect: (version) => {
              setStagedOverrides((prev) => ({
                ...prev,
                [override.name]: { spec: version, originKey: override.originKey, originLabel: override.originLabel },
              }));
              setOverride(null);
            },
            onCancel: () => setOverride(null),
          })
        : null
  );
}
