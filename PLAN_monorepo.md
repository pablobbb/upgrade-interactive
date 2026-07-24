# Plan: monorepo / npm-workspaces support

Status: **draft — not started**
Scope: make `upgrade-interactive` work in npm-workspace monorepos (root
`package.json` with a `workspaces` field), while keeping single-package
behavior byte-for-byte identical.

## Background / current constraints

The pipeline today: `cli.js` → `loadManifest(cwd)` (`src/package-file.js`)
reads **one** `package.json` into flat `descriptors` (`{name, range, field}`)
→ `App.js` fetches suggestions per descriptor and runs the audit → on Enter,
`applyUpgrades` writes one file and the CLI runs one `npm install`.

What monorepo support touches:

1. **Everything is keyed by bare package name.** `selections`
   (`Map<name, range>`), `selectedColumns`, row keys (`dep:${name}`), and
   `applyUpgrades`'s descriptor matching all assume a name appears once.
   In a workspace repo the same package can appear in several workspaces
   with different ranges — this re-keying is the core refactor.
2. **The lockfile story is favorable.** npm workspaces share a single root
   `package-lock.json`; `src/lockfile.js` and the instance-resolution walk
   in `src/vulnerabilities.js` (`resolveInstalledPath`) read the `packages`
   map generically. Workspace entries (`packages/foo` paths, `link: true`
   nodes) are already skipped by `nameFromPath`; the `direct` set needs to
   also union each workspace's deps.
3. **Overrides are root-only in npm workspaces** — npm honors `overrides`
   only in the root manifest. Override add/remove must always target the
   root manifest, even when upgrading a child workspace's deps.
4. `isProtocolRange` already skips `workspace:` ranges, but npm-style
   monorepos reference siblings with plain semver ranges (`^1.0.0`) — those
   would get bogus registry suggestions (or match an unrelated public
   package with the same name) unless names that are local workspace
   packages are excluded.
5. The README documents "No monorepo/workspace support" as a known
   divergence — that line and the yarn-comparison section must be updated
   (CLAUDE.md requires README sync on every change).

## Design decisions

- **Full per-workspace sections, no dedupe (decided).** Root section
  first, then one section per workspace (each following the existing
  Dependencies / Dev dependencies grouping when `--section` is on). Every
  descriptor is its own row, even when identical to another workspace's —
  one row maps 1:1 to exactly one `(workspace, field, name)` and writes to
  exactly one manifest; no group-id / fan-out logic. Rejected the
  flat-dedupe alternative (one row per unique `(name, range, field)`
  across the repo) because it collapses a workspace's dependency set into
  a repo-wide list that isn't independently reviewable as "this
  workspace's deps" — the whole point of the ask. Accepted trade-off:
  shared tooling deps (eslint, typescript, prettier, ...) repeat once per
  workspace; `c`/`r`/`l` bulk-select still applies across every visible
  row in one keystroke, and rows only diverge in practice where ranges
  actually diverge.
  - **Exception: overrides.** `overrides` is root-only and global by npm
    semantics — unaffected by which workspace a vulnerable package is a
    dependency of. Once a package's override is staged from one row (a
    workspace's dep/vuln row, or the shared vulnerability section), every
    *other* row referencing that same package name becomes
    non-interactive for staging: instead of `press o to override` it
    shows `ⓘ override staged under {workspace} — press o there to
    change` (or `ⓘ override already staged above — press o there to
    change` when the origin is the shared vulnerability section, which
    has no single workspace). The green `→ override X.Y.Z` badge still
    renders on every matching row (already keyed by name); only the
    *action* is restricted to the origin row.
- **Default scope: root + all workspaces**, with `-w/--workspace <name>` to
  filter and `--no-workspaces` for exact current behavior. (npm's CLI is
  opt-in via `--workspaces`; an interactive picker is better opt-out.)
- **Minimal in-house glob** for `workspaces` patterns (literal paths, `*`
  segment, trailing `/**`), matching the repo's no-new-deps style and
  Node 18 support (no `fs.glob`). Divergence from npm's full minimatch gets
  documented in the README.
- **Run `npm install` once, at the project root.**
- Internal cross-workspace deps (a workspace depending on a sibling
  workspace's name) are skipped from the upgrade list.

## Phase 1 — Workspace discovery (`src/workspaces.js`, new)

- [ ] `findProjectRoot(cwd)`: walk up from `cwd` looking for a
      `package.json` with a `workspaces` field whose expansion contains
      `cwd`, so running from inside `packages/foo` sees the whole monorepo
      (matches npm). If none, `cwd` is standalone — degrade to current
      behavior.
- [ ] `expandWorkspaces(rootDir, workspacesField)`: accept both the array
      form and `{ packages: [...] }`. Minimal glob as above; keep only
      directories containing a `package.json`; never descend into
      `node_modules`.
- [ ] Returns `[{ dir, name, relPath }]` including the root itself.

## Phase 2 — Multi-manifest model (`src/package-file.js`)

- [ ] New `loadProject(cwd)` replacing `loadManifest` at the top level
      (keep `loadManifest` as the per-file reader — reused per workspace
      and by existing tests):
  - Loads root + each workspace manifest, each keeping its own
    `raw`/`indent`/`trailingNewline` so writes preserve per-file
    formatting.
  - Each descriptor gains `workspace` (display name; `null`/`"root"` for
    the root) and a unique `id` (`${relPath} ${field} ${name}`) —
    descriptors are **not** grouped or deduped across workspaces; a
    package declared identically in five workspaces yields five
    independent descriptors/rows.
  - Skip descriptors whose `name` is a local workspace package.
- [ ] `applyUpgrades(project, selections, ...)`: selections keyed by
      descriptor `id`; one selection writes to exactly one
      `(manifest, field, name)` — no fan-out. Only write manifests that
      actually changed. Override adds/removals always mutate the **root**
      manifest, as today. `applied` records gain `workspace` for the
      summary.

## Phase 3 — CLI (`src/cli.js`)

- [ ] Use `loadProject`; read the `upgrade-interactive` config block from
      the root manifest; run the single `npm install` at the root.
- [ ] New flags (npm conventions):
  - `-w, --workspace <name>` (repeatable) — limit to matching
    workspace(s) by package name or path.
  - `--no-workspaces` — root manifest only (current behavior).
- [ ] Post-submit summary grouped by workspace, then field.
- [ ] Update `--help` text (must stay in sync with README).

## Phase 4 — UI (`src/components/App.js`, `src/components/Row.js`)

- [ ] Sections: root section first, then one section per workspace, in
      project order (or `-w` filter order). Each section internally keeps
      today's Dependencies / Dev dependencies grouping when `--section` is
      on — i.e. workspace sectioning is a new outer level, field
      sectioning is unchanged as the inner level. `--no-section` collapses
      only the inner (field) grouping; the workspace sections themselves
      always exist (root first) so a workspace's deps stay reviewable as
      its own group.
  - [ ] New heading style for a workspace section distinct from the
        existing `Dependencies`/`Dev dependencies` sub-headers so the two
        levels read as different levels, e.g. `packages/api (@acme/api)`.
- [ ] Re-key from `descriptor.name` to the descriptor `id`:
      `selectedColumns`, row keys (`dep:${id}`), the `selections` map
      built on Enter.
- [ ] `stagedOverrides` gains provenance instead of being a bare
      `{ [name]: spec }` map: `{ [name]: { spec, originKey, originLabel } }`,
      captured from whichever row's `o` press created it (`originKey` =
      that row's key; `originLabel` = the workspace display name, or a
      fixed label like `"the vulnerability list"` when staged from the
      shared vuln section). `Row.js`'s `overrideLabel`/`VulnInfo` unwrap
      `.spec` for the existing green badge (unchanged, still keyed by
      name so it renders on every row referencing that package). Add a
      new branch: a row whose key isn't `originKey` renders
      `ⓘ override staged under {originLabel} — press o there to change`
      in place of the existing `press o to override` hint.
      `openOverride()` becomes a no-op when the focused row isn't the
      origin and an override is already staged for that name — editing
      only happens from the origin row.
- [ ] `stagedRemovals` is untouched (root-only, name-keyed, no
      per-workspace concept).
- [ ] The existing "Override to a safe version" / "Unused overrides"
      sections stay **shared, not per-workspace** — they cover
      transitive vulnerable packages not owned by any single workspace's
      manifest, plus root-level override bookkeeping, both inherently
      tree-wide. Render this shared block after all workspace sections.
      The existing `shownDepNames` fallback (a vuln without a visible dep
      row falls through to this section) already generalizes with no
      logic change — it just needs to collect names from every workspace
      section's dep rows instead of one flat list.
- [ ] `-w/--workspace` filters which workspace sections render; the
      shared vulnerability/override section always reflects the whole
      tree regardless of `-w` (overrides are root-global, the lockfile is
      shared) — a vulnerable package hidden by `-w` still surfaces there
      via the fallback above.
- [ ] Vuln lookup by name still works per row; the same advisory
      legitimately appears on each row of that package, across sections.

## Phase 5 — Audit plumbing (`src/lockfile.js`, `src/vulnerabilities.js`)

- [ ] `loadInstalledVersions(rootDir)`: called with the project root, not
      `cwd`. Extend the `direct` set to include deps of every workspace
      entry in the `packages` map (paths without `node_modules/`,
      excluding the `""` root).
- [ ] Verify the instance walk against a real workspace lockfile fixture:
      workspace-local `node_modules` (`packages/foo/node_modules/dep`)
      hoisting should already be handled by `resolveInstalledPath`;
      `link: true` entries have no `version` and are naturally skipped.
      Expect little code change, but this is where subtle bugs would hide —
      needs a dedicated fixture test.
- [ ] `computeVulnerabilities` receives the full (non-deduped) descriptor
      list across all workspaces; the range-resolved check may fetch the
      same `(name, range)` pair more than once, but `fetchPackageMeta`
      already caches by name in-memory, so repeat descriptors cost no
      extra network calls.

## Phase 6 — Tests & README

- [ ] New `test/unit/workspaces.test.mjs`: glob expansion, root detection,
      array vs object `workspaces` form, `node_modules` exclusion.
- [ ] Extend `test/unit/package-file.test.mjs`: multi-manifest load,
      per-descriptor (non-deduped) ids, single-manifest writes, root-only
      overrides, per-file formatting preserved.
- [ ] Extend `test/unit/lockfile.test.mjs`: workspace lockfile fixture —
      `direct` set, `link` entries, workspace-local `node_modules`.
- [ ] App/UI tests: nested section rendering (root + N workspaces, field
      grouping inside each); override provenance (stage from workspace A's
      row, assert workspace B's row for the same package renders the
      read-only "staged under A" note and `o` no-ops there).
- [ ] Integration test: temp monorepo fixture, select-in-one-workspace +
      apply.
- [ ] README: remove the "No monorepo/workspace support" bullet; add a
      **Workspaces / monorepos** section explaining root-first
      per-workspace sections (deliberately no dedupe) and the override
      provenance behavior; document `-w` / `--no-workspaces`; update
      **What it does** and the yarn-comparison section (yarn has no
      workspace concept for this command at all, so this whole area is a
      divergence; minimal-glob subset and root-only overrides are the
      other documented ones).

## Order of work & risk

Dropping dedupe/fan-out removes what was the highest-risk item in an
earlier draft of this plan — Phase 2 is now a straightforward per-file
loader with no grouping logic, since every descriptor keeps a unique id
and writes to exactly one manifest. The risk moved to Phase 4: nested
section rendering (workspace → field) and override provenance (tracking
which row "owns" a staged override and restricting `o` to it) are both
new UI states with no precedent in the current code.

Land Phase 1, then a minimal Phase 2 (no provenance concerns — that's a
UI-only concept), and verify against the existing single-package test
suite (a project with no `workspaces` field must produce byte-identical
behavior to today, exercised through the same code path rather than a
separate branch). Then Phase 4's nested sections. Then override
provenance as its own sub-step — it's isolable and independently
testable. Then Phase 3, then 5, then 6.

Also worth flagging before implementation: **row volume**. Full
per-workspace sectioning means a monorepo with many workspaces and a lot
of shared tooling deps will show a long list (shared devDependencies
repeat once per workspace, by design — see Design decisions). No
section-jump navigation exists today (`↑`/`↓` move one row at a time);
this plan doesn't add one. Worth a v1 explicitly, revisit if it turns out
to matter in practice.

Rough size: ~400–500 new lines plus the README.
