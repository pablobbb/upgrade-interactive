# upgrade-interactive

[![npm version](https://img.shields.io/npm/v/upgrade-interactive.svg)](https://www.npmjs.com/package/upgrade-interactive)
[![npm downloads](https://img.shields.io/npm/dm/upgrade-interactive.svg)](https://www.npmjs.com/package/upgrade-interactive)
[![node](https://img.shields.io/node/v/upgrade-interactive.svg)](https://www.npmjs.com/package/upgrade-interactive)
[![license](https://img.shields.io/npm/l/upgrade-interactive.svg)](./LICENSE)

An interactive dependency upgrader for npm projects, inspired by `yarn
upgrade-interactive`. A three-column Current/Range/Latest picker, plus built-in
**vulnerability warnings** and one-key npm **`overrides`**.

<p align="center">
  <img src="https://raw.githubusercontent.com/pablobbb/upgrade-interactive/main/assets/screenshot.png" alt="upgrade-interactive showing the three-column Current/Range/Latest picker, with version-diff coloring, a vulnerability warning, and override sections" width="100%">
</p>

## Install / run

```sh
npx upgrade-interactive
# or install globally:
npm install -g upgrade-interactive
nui
```

Requires Node 18+ and an interactive terminal. Inside a project, `npx
upgrade-interactive` (or `npx nui`) runs the locally-installed copy — no
`package.json` script needed.

## What it does

1. Reads `dependencies` and `devDependencies` from `package.json`.
2. For each package, offers two upgrades from the registry, re-using your range
   modifier (`^`, `~`, or exact):
   - **Range** — highest version still satisfying your current range (npm's
     "Wanted").
   - **Latest** — the `latest`-tagged version, even if it's a major bump.

   Packages with nothing new to offer are left out of the list.
3. Lets you pick, per package, **Current** / **Range** / **Latest**.
4. **Checks for known vulnerabilities** (on by default) across direct *and*
   transitive dependencies. Flagged rows show a ⚠ icon, severity, and a
   clickable CVE link, with the affected range and first fixed version inline.
5. Press `o` on a vulnerable package to **pin a safe version via npm
   `overrides`**. A single-version package gets one global pin; a package
   installed at several versions gets **per-dependent scoped pins**
   (`parent › package`) so already-safe copies are left alone. If the package is
   one of your **direct** dependencies, it bumps that dependency's range instead
   — npm rejects a top-level override that conflicts with a direct dependency
   (`EOVERRIDE`).
6. **Flags overrides that are no longer needed** (nothing depends on them, or
   your deps now resolve safely without them). Press `x` to remove one — it only
   ever removes the one you select.
7. Writes your choices back to `package.json` and runs `npm install`.

By default the list is grouped into **Dependencies**, **Dev dependencies**, and
override sections. Pass `--no-section` for a single flat list.

## Controls

| Key                | Action                                              |
| ------------------ | ---------------------------------------------------- |
| `↑` / `↓`          | Move between packages                                |
| `←` / `→`          | Move between Current / Range / Latest                |
| `c` / `r` / `l`     | Select current / range / latest for *every* package |
| `o`                | Pin the focused vulnerable package to a safe version (override, or a range bump if it's a direct dependency) |
| `x`                | Remove the focused unused override                   |
| `Enter`            | Apply upgrades and run `npm install`                 |
| `Esc`   | Abort — nothing is written                            |

Version numbers are colorized by bump size (minor vs. major), highlighting only
the part that changed.

## Flags

- `--install` / `--no-install` — run `npm install` after writing changes (default: on)
- `--audit` / `--no-audit` — vulnerability check (default: on)
- `--section` / `--no-section` — grouped sections vs. flat list (default: on)
- `-h, --help`, `-v, --version`

To change a default permanently, use an env var or a `package.json` config block:

```json
"upgrade-interactive": { "audit": false, "section": true }
```

```sh
NUI_AUDIT=0 npx upgrade-interactive
```

Precedence, highest first: CLI flag → `NUI_AUDIT` / `NUI_SECTION` → `package.json`
config → default (on).

> Auditing needs network access. Offline, the tool says so (`no network —
> couldn't check for vulnerable packages`) instead of pretending everything is
> clean, and upgrades still work.

## Notes

- **Compound ranges** (`>=1.0.0 <2.0.0`, `1.x || 2.x`, `1.0.0 - 2.0.0`) have no
  single modifier to re-apply, so they collapse to a caret. Protocol ranges
  (git/file/link/workspace, npm aliases) are skipped entirely.
- Only `dependencies` / `devDependencies` are scanned.
- The list stays alphabetically sorted the whole time it's loading.
- No monorepo/workspace support (single `package.json` only).
