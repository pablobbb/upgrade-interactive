# Changelog

## Unreleased

### Fixed

- **A scoped pin and a top-level pin on the same package no longer overwrite
  each other.** Pinning `picomatch` under `vite` and pinning `vite` itself both
  write to `overrides.vite`, and the second pass replaced the first's work
  whenever the scoped pin was written first — which is the order the audit
  displays them in. The package's own pin now goes under npm's `"."` key beside
  its scoped children, so both survive. Removing an unused override that has
  since gained a scoped child drops only the override itself, for the same
  reason.
- **The post-run summary can no longer report an override the file does not
  have.** It was built from what the writer intended rather than from the
  result, so a lost write was reported as applied. The two are now reconciled
  before `package.json` is written, and a mismatch fails the run instead of
  being reported as a success.
- **Status icons no longer overlap the text next to them.** Ink advances one
  column for a Basic-Multilingual-Plane emoji, so on a terminal whose font
  substitutes emoji for `⚠`, `✔` and `ℹ` — drawing them two columns wide — each
  bled into the cell beside it and the row read as stretched. Terminals that
  honour those characters' default text presentation drew them narrow and showed
  no problem, which is why the fault appeared on some machines and not others.
- **The `Current` / `Range` / `Latest` headings line up with the versions under
  them.** The heading row reserved 50 columns before its first cell where a row
  spends 49 reaching its first version, so every label sat one column to the
  right of its data. The extra column also made the header 101 columns wide
  against a row's 98, so on a 100-column terminal the header alone was shrunk to
  fit and the gaps between headings went uneven as well.

### Changed

- **The status icons are now plain text symbols — `▲`, `✓` and `ⓘ`.** Emoji can
  be laid out correctly by pinning them with a `U+FE0F` variation selector, but
  the result is a fixed-colour glyph that ignores the row's colour and outweighs
  the text it annotates. The text symbols are one column, measured correctly, and
  take the `color` prop, so a warning is red or yellow with its severity instead
  of a constant yellow lozenge.
- **Every glyph the TUI draws is defined in `src/icons.js`** — the cursor,
  column markers, arrows and separators as well as the status icons, each named
  for its role rather than repeated as a literal across components.
  `test/unit/icons.test.mjs` asserts the whole set is single-code-point,
  one-column and non-emoji, so the class of bug above cannot come back unnoticed.

## 2.1.0 — 2026-08-09

### Added

- **The override pickers scroll.** Both overlays rendered every row
  unconditionally. The candidate list is every published version at or above the
  current one, so a long-lived package pushed its versions past the bottom of the
  screen with no way to reach them; the scoped picker had the same problem across
  its list of dependents. Both now window like the main list and report what is
  hidden above and below. An open overlay also gives its height back to the list
  behind it — on a 30-row terminal, opening a picker used to take the frame from
  28 lines to 64, scrolling its own title off the screen.

### Fixed

- **`←` / `→` no longer park the marker on a column the package doesn't offer.**
  From Range on a row with no Latest, `→` moved the marker into the empty cell;
  on `Enter` the row was then dropped, silently losing the Range pick. The arrows
  now stop at the last column that exists.
- **Bulk `r` no longer stages a major on a row that offers no Range.** It set the
  Range column unconditionally. The bulk keys now fall back *downwards* — `l`
  takes Range when there is no Latest, and `r` leaves a package on Current rather
  than staging a major it never offered.
- **A package an override already pins to a safe version is no longer flagged
  again.** The versions its dependents would fall back to if the pin were removed
  were being fed into the same set that decides which packages are vulnerable, so
  a correctly-pinned package reappeared under "Override to a safe version",
  labelled with a version installed nowhere in the tree. Those fallback versions
  are still computed, but only to decide whether the pin is still needed.

## 2.0.1 — 2026-08-08

### Fixed

- **`workspaces` patterns with a `*` inside a path segment now expand.**
  `packages/*-api` or `apps/web-*` were treated as literal directory names, so
  they matched nothing — and because a `workspaces` field that expands to no
  workspaces is indistinguishable from not having one, the tool silently ran as
  a single-manifest project instead of saying so. A bare `packages/*` was
  unaffected.
- **`-w <path>` now matches on Windows.** The filter was compared against
  `path.relative`'s output, which uses `\` there, so the documented
  `-w packages/api` exited with `No workspace matches`. Workspace paths are now
  POSIX-separated everywhere they are used as an identity or shown on screen,
  and a `-w` value is matched regardless of separator or a trailing slash.

### Notes

- The `--help` text now carries `-w` examples for both the path and the
  package-name form, matching the README.

## 2.0.0 — 2026-08-07

npm workspaces support. **The version is a major because the default set of files
the tool reads and writes changed** — read [Breaking](#breaking) before upgrading
if you use it in a monorepo.

A repository with no `workspaces` field is unaffected by everything below. It
loads exactly one `package.json`, renders no workspace headings, and behaves
exactly as 1.4.1 did.

### Breaking

- **Workspace manifests are now in scope by default.** In a repo whose root
  `package.json` has a `workspaces` field, the tool reads and writes the root
  *and every workspace* manifest. 1.4.1 only ever touched the single
  `package.json` in the current directory. Pass `--no-workspaces` for the old
  behavior.
- **Running from inside a workspace now operates on the whole repo.** From
  `packages/api`, 1.4.1 read `packages/api/package.json` and nothing else; 2.0.0
  walks up to the project root and treats the run as covering the repo. This is
  the same change as above seen from a different directory.
- **The `upgrade-interactive` config block is read from the root manifest only.**
  A workspace's own block is ignored. Each setting it holds (`install`, `audit`,
  `section`) describes the run, and one run does one install, one audit and one
  rendering — a per-workspace value has nothing to apply to. When an ignored
  block would have changed the run, the tool now names it:

  ```
  ⓘ ignoring "upgrade-interactive" in packages/api/package.json (install) — settings come from the root package.json
  ```

- **`npm install` runs at the project root**, not the current directory. npm
  workspaces share the root lockfile, so a per-workspace install was wrong.

### Added

- `-w, --workspace <name>` — limit the run to matching workspaces; repeatable,
  matches package name or path. A value matching nothing is an error rather than
  an empty list, and it cannot be combined with `--no-workspaces`.
- `--no-workspaces` — load only the root `package.json`, ignoring any
  `workspaces` field.
- Each workspace gets its own section in the list (root first) and its own group
  in the post-run summary. `--no-section` still collapses the inner field
  grouping.
- Vulnerability rows carry provenance across workspaces: a package used by
  several workspaces is staged as an override once, from one row, and the other
  rows say where it lives.
- Audit-derived override sections show a loading state instead of appearing
  fully-formed once the audit resolves.

### Notes

- `overrides` are always written to the root manifest, because that is the only
  place npm honors them.
- A vulnerable package whose workspaces declare *different* ranges cannot be
  fixed by any single `overrides` entry — npm keys overrides by position in the
  dependency graph, and there is no key meaning "this workspace only". Those rows
  refuse the pin and explain why; upgrade each workspace's own row instead. This
  holds under `--no-workspaces` too, since narrowing what you edit doesn't change
  what's installed.
- The `workspaces` glob supports literal paths, `*`, trailing `**` and `!`
  exclusions — a subset of npm's patterns.
- No bug fixes are listed for this release: every fix on the way to it was to
  code that ships here for the first time, so nothing that worked in 1.4.1 was
  broken and repaired.

## 1.4.1 — 2026-07-24

### Added

- `--install` as an explicit on-switch, so every toggle can now be forced either
  way from the command line rather than only turned off.
- `NUI_INSTALL`, completing the environment-variable set, and `install` as a
  `package.json` config key.

### Changed

- All three toggles resolve through one shared implementation
  ([`src/flags.js`](src/flags.js)), so `--install`, `--audit` and `--section`
  follow identical precedence: flag → env var → `package.json` config → default.
  `--install` previously had no on-switch, no env var and no config key.

## 1.4.0 — 2026-07-23

### Fixed

- Pinning a *direct* dependency now bumps its declared range instead of writing
  an `overrides` entry npm rejects (`EOVERRIDE`, "conflicts with direct
  dependency"). The written manifest could fail to install.
- An override staged for addition is no longer clobbered by a removal staged for
  the same package name in the same run.

## 1.3.0 — 2026-07-04

### Added

- Compound ranges (`>=1.0.0 <2.0.0`, `1.x || 2.x`, `1.0.0 - 2.0.0`) are now
  offered upgrades, collapsed to a caret — they have no single modifier to
  re-apply. They were previously skipped.

## 1.2.1 — 2026-07-03

### Fixed

- `bin` paths normalized (`npm pkg fix`).

## 1.2.0 — 2026-07-03

### Added

- Per-parent scoped override pins: when copies of a vulnerable package need
  different safe versions, each is pinned under its own parent rather than
  forcing one global version on the whole tree.
- Override keys disambiguated by `parent@version` when one parent name needs
  different child versions for different installed copies of itself.
- Overrides split into their own list section, with a current → fixed column.

## 1.1.0 — 2026-07-02

### Added

- Vulnerability warnings from `npm audit`: affected rows show severity and a CVE
  link, and `o` pins the package to a safe version via npm `overrides`.
- `x` stages removal of an override no longer needed because the dependency
  tree moved past it.
- `--audit` / `--no-audit` and `--section` / `--no-section`, the `NUI_AUDIT` /
  `NUI_SECTION` environment variables, and the `upgrade-interactive`
  `package.json` config block.

### Fixed

- The audit effect no longer re-runs in an unbounded loop.

## 1.0.0 — 2026-07-01

Initial release: the interactive TUI over `dependencies` and `devDependencies`,
offering a **Range** and a **Latest** candidate per package (both re-formatted
with your existing `^` / `~` / exact modifier), per-package selection, `c` / `r` /
`l` to select a column for every package at once, version diffs colorized by bump
size, and `--no-install` to write `package.json` without installing.

---

Entries for 1.0.0 – 1.4.1 were reconstructed from the git history after the fact.
1.0.0 landed as a single squashed commit, so its entry describes the code at that
tag rather than a commit-by-commit record.
