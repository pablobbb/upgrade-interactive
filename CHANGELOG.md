# Changelog

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
