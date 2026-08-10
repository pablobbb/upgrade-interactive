// Pure construction of the ordered display list (headers + rows) the App
// renders. Kept free of React/network so the nested-section layout — the risky
// part of workspace support — is unit-testable in isolation.
//
// Two nesting levels: an outer per-workspace level (root first, then each
// workspace in project order) and, inside each, the existing per-field grouping
// (Dependencies / Dev dependencies) when `section` is on. A standalone project
// (one workspace, the root) renders no workspace headers, so its layout is
// byte-identical to the pre-workspaces behavior.

/**
 * @param descriptors  normalized descriptors ({ name, field, id, workspace, relPath, ... })
 * @param entries      suggestion results aligned to `descriptors` by index (null = still loading)
 * @param allLoaded    once true, still-null entries are dropped instead of shown as loading rows
 * @param vulns        Map<name, vuln> | null
 * @param section      group each workspace's rows by field when true
 * @param overrideVulns  [name, vuln][] for the shared "Override to a safe version" section
 * @param removableList  [name, info][] for the shared "Unused overrides" section
 * @param auditPending  audit still in flight — show loading placeholders for the two audit sections
 */
export function buildDisplayRows({
  descriptors,
  entries,
  allLoaded,
  vulns,
  section,
  overrideVulns = [],
  removableList = [],
  auditPending = false,
}) {
  const depItems = descriptors.map((descriptor, i) => ({ descriptor, entry: entries[i], i }));
  const visibleDeps = allLoaded ? depItems.filter((x) => x.entry !== null) : depItems;

  const depRow = (x) =>
    x.entry === null
      ? { kind: 'loading', key: `loading:${x.i}` }
      : {
          kind: 'dep',
          key: `dep:${x.descriptor.id}`,
          descriptor: x.descriptor,
          entry: x.entry,
          vuln: vulns ? vulns.get(x.descriptor.name) || null : null,
        };

  // Group by workspace (relPath), preserving first-seen (project) order: root
  // first because loadProject emits the root's descriptors ahead of the rest.
  const groups = [];
  const byRel = new Map();
  for (const x of visibleDeps) {
    const rel = x.descriptor.relPath ?? '.';
    let group = byRel.get(rel);
    if (!group) {
      group = { relPath: rel, workspace: x.descriptor.workspace ?? null, items: [] };
      byRel.set(rel, group);
      groups.push(group);
    }
    group.items.push(x);
  }

  // Only a real monorepo gets workspace headers; a lone root group stays
  // header-free so single-package output is unchanged.
  const isMonorepo = groups.some((g) => g.relPath !== '.' || g.workspace != null);

  const rows = [];
  for (const group of groups) {
    if (isMonorepo) {
      rows.push({ kind: 'wsheader', key: `ws:${group.relPath}`, relPath: group.relPath, workspace: group.workspace });
    }
    if (section) {
      const deps = group.items.filter((x) => x.descriptor.field === 'dependencies');
      const dev = group.items.filter((x) => x.descriptor.field === 'devDependencies');
      if (deps.length > 0) {
        rows.push({ kind: 'header', key: `h:deps:${group.relPath}`, title: 'Dependencies' });
        for (const x of deps) rows.push(depRow(x));
      }
      if (dev.length > 0) {
        rows.push({ kind: 'header', key: `h:dev:${group.relPath}`, title: 'Dev dependencies' });
        for (const x of dev) rows.push(depRow(x));
      }
    } else {
      for (const x of group.items) rows.push(depRow(x));
    }
  }

  // Shared vulnerability / override sections come after every workspace section:
  // they cover transitive packages no single workspace's manifest owns, plus
  // root-only override bookkeeping — both inherently tree-wide. While the audit
  // is still running both lists are empty, so surface each section header with a
  // loading placeholder instead of leaving a gap that silently fills in later.
  if (auditPending) {
    rows.push({ kind: 'header', key: 'h:pin', title: 'Override to a safe version' });
    rows.push({ kind: 'loading', key: 'loading:pin' });
    rows.push({ kind: 'header', key: 'h:unused', title: 'Unused overrides' });
    rows.push({ kind: 'loading', key: 'loading:unused' });
  } else {
    if (overrideVulns.length > 0) {
      rows.push({ kind: 'header', key: 'h:pin', title: 'Override to a safe version' });
      for (const [name, vuln] of overrideVulns) rows.push({ kind: 'vuln', key: `vuln:${name}`, name, vuln });
    }
    if (removableList.length > 0) {
      rows.push({ kind: 'header', key: 'h:unused', title: 'Unused overrides' });
      for (const [name, info] of removableList) {
        rows.push({ kind: 'override', key: `ovr:${name}`, name, pin: info.pin, reason: info.reason });
      }
    }
  }

  return rows;
}

// A column is selectable only when it actually shows a version. Column 0
// (Current) always does — fetchSuggestions fills it with the declared range —
// so it is the guaranteed floor when moving left.
function hasColumn(suggestions, index) {
  const suggestion = suggestions[index];
  return !!suggestion && suggestion.spans.length > 0;
}

/**
 * The column ←/→ should move to from `current`, skipping the ones this package
 * doesn't offer. Returns `current` unchanged when there is nothing further that
 * way: a marker parked on an empty column looks like a selection but carries no
 * version, so <enter> would silently drop the row and lose the real pick.
 */
export function nextColumn(suggestions, current, direction) {
  let next = current + direction;
  while (next >= 0 && next < suggestions.length && !hasColumn(suggestions, next)) next += direction;
  if (next < 0 || next >= suggestions.length) return current;
  return next;
}

/**
 * The column the bulk keys (`c` / `r` / `l`) select for one package. A package
 * that doesn't offer the requested column falls back to the nearest *lower*
 * one, never a higher: "select every Range" must not quietly stage a major bump
 * on the rows that had no in-range upgrade to give.
 */
export function bulkColumn(suggestions, which) {
  const wanted = which === 'l' ? 2 : which === 'r' ? 1 : 0;
  for (let i = wanted; i > 0; i--) {
    if (hasColumn(suggestions, i)) return i;
  }
  return 0;
}

/**
 * The slice of `items` to show around `focusedIndex` when only `maxRows` fit,
 * plus how many are hidden on each side so the caller can render the "↑ N more
 * above" / "↓ N more below" hints. The focused item stays centered until the
 * list runs out at either end. Shared by the main list and the override
 * overlays so both scroll — and describe their scrolling — identically.
 */
export function windowSlice(items, focusedIndex, maxRows) {
  const lastStart = Math.max(0, items.length - maxRows);
  const start = Math.max(0, Math.min(Math.max(0, focusedIndex) - Math.floor(maxRows / 2), lastStart));
  const end = Math.min(items.length, start + maxRows);
  return { visible: items.slice(start, end), above: start, below: items.length - end };
}

/**
 * Resolve what a single row should show for a staged override. `stagedOverrides`
 * is keyed by package name but carries provenance
 * ({ spec, originKey, originLabel }), so a package appearing in several
 * workspaces stages once, from one origin row: the green badge (`spec`) renders
 * on every matching row, but the editable action stays on the origin. A
 * non-origin row gets a read-only `note` (and no interactive hint).
 *
 * Returns { spec, note }: `spec` is the staged override spec (undefined when
 * nothing is staged) and `note` is the "staged elsewhere" text (null on the
 * origin row, or when nothing is staged). `originLabel` null means the origin is
 * the shared vulnerability section ("already staged above"); otherwise it's the
 * origin workspace's display name ("staged under <label>").
 */
export function overrideView(stagedOverrides, name, rowKey) {
  const record = stagedOverrides[name];
  if (!record) return { spec: undefined, note: null };
  if (record.originKey === rowKey) return { spec: record.spec, note: null };
  const note = record.originLabel
    ? `ⓘ override staged under ${record.originLabel} — press o there to change`
    : 'ⓘ override already staged above — press o there to change';
  return { spec: record.spec, note };
}
