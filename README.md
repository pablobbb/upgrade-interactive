# upgrade-interactive

[![npm version](https://img.shields.io/npm/v/upgrade-interactive.svg)](https://www.npmjs.com/package/upgrade-interactive)
[![npm downloads](https://img.shields.io/npm/dm/upgrade-interactive.svg)](https://www.npmjs.com/package/upgrade-interactive)
[![node](https://img.shields.io/node/v/upgrade-interactive.svg)](https://www.npmjs.com/package/upgrade-interactive)
[![license](https://img.shields.io/npm/l/upgrade-interactive.svg)](./LICENSE)

An interactive dependency upgrader for npm projects, **inspired by** `yarn
upgrade-interactive` (the Yarn Berry / Yarn 4 version, built into Yarn since v4).
The three-column layout, keybindings, and version-suggestion logic follow yarn's
closely, but this tool also adds things yarn
doesn't have, notably built-in **vulnerability warnings** and one-key npm
**`overrides`**, so it deliberately diverges where that improves the experience.

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

Requires Node 18+ and an interactive terminal.

### Using it inside a project

Because this package ships a `bin`, you don't need `npm run` — or any
`package.json` change — to use it in a project. Install it and call it with npx:

```sh
npm install -D upgrade-interactive
npx upgrade-interactive     # runs the locally-installed copy (npx prefers node_modules/.bin)
npx nui                      # same thing, short name
```

npm has no plugin/subcommand system the way Yarn Berry does, so the literal
`npm upgrade-interactive` isn't possible — but `npx upgrade-interactive` is the
native, no-`run` equivalent. If you'd still rather have a named script, add:

```json
"scripts": {
  "upgrade-interactive": "upgrade-interactive"
}
```

and run `npm run upgrade-interactive`.

## What it does

1. Reads `dependencies` and `devDependencies` from `package.json`.
2. For each package, looks up two candidate upgrades from the npm registry:
   - **Range** — the highest version that still satisfies your current
     semver range (what `npm outdated` calls "Wanted").
   - **Latest** — the version tagged `latest` on the registry, even if it's
     outside your current range (a major bump, for example).
   Both are re-formatted using your existing range modifier (`^`, `~`, or
   exact), and packages with nothing new to offer are left out of the list
   entirely — same as yarn.
3. Lets you pick, per package, whether to stay on **Current**, take the
   **Range** upgrade, or take the **Latest** upgrade.
4. **Checks for known vulnerabilities** (on by default) against npm's advisory
   database, covering both your **direct and transitive** dependencies. A
   flagged row shows a ⚠ icon, the severity (`low` / `moderate` / `high` /
   `critical`), and the CVE id as a clickable link to the advisory — with the
   plain URL printed alongside it when your terminal can't render clickable
   links. The affected range and first fixed version are shown inline.
5. Lets you press `o` on a vulnerable package to **pin it to a safe version via
   an npm `overrides` entry** — the main way to patch a *transitive* dependency
   you don't directly control. When the package resolves to a single version
   this is one global pin. When it's installed at **several versions** across the
   tree — where a global pin would drag an unrelated, already-safe copy along too
   — the picker instead offers **per-dependent scoped pins**: it pins each
   vulnerable copy under its parent (`parent › package`) and leaves already-safe
   copies alone. If one parent is itself present at multiple versions needing
   different fixes, those pins are keyed by `parent@version`.
6. **Flags existing `overrides` that are no longer needed** — either because
   nothing in the tree depends on that package anymore, or because your deps
   would now resolve to a non-vulnerable version without the pin. Press `x` to
   remove one. (It never removes an override that's still doing something, and
   only ever removes one you explicitly select.)
7. Writes your choices (overrides added and removed) back into `package.json`
   and runs `npm install`.

By default the list is grouped into **Dependencies**, **Dev dependencies**, and
two override sections: **Override to a safe version** (vulnerable packages with
no ordinary upgrade path, each shown as a `current → fixed` pair) and **Unused
overrides** (existing pins you can drop). Pass `--no-section` for a single flat
list.

## Controls

| Key                | Action                                              |
| ------------------ | ---------------------------------------------------- |
| `↑` / `↓`          | Move between packages                                |
| `←` / `→`          | Move between Current / Range / Latest for that package |
| `c` / `r` / `l`     | Select **c**urrent / **r**ange / **l**atest for *every* package at once |
| `o`                | Override the focused vulnerable package to a safe version (audit mode) |
| `x`                | Remove the focused override when it's no longer needed (audit mode) |
| `Enter`            | Apply the selected upgrades and run `npm install`     |
| `Ctrl+C` / `Esc`   | Abort — nothing is written                            |

Version numbers are colorized by the size of the bump (yellow-ish for
minor, red for major), with only the part of the version that actually
changed highlighted — same idea as yarn's diff highlighting.

## Flags

- `--no-install` — update `package.json` only, skip the `npm install` step
- `--audit` / `--no-audit` — enable/disable the vulnerability check (default: on)
- `--section` / `--no-section` — grouped sections vs a flat list (default: on)
- `-h, --help`, `-v, --version`

### Persisting audit / section preferences

Audit and sectioning are both on by default. To change the default permanently,
set an environment variable or a `package.json` config block:

```json
"upgrade-interactive": { "audit": false, "section": true }
```

```sh
NUI_AUDIT=0 npx upgrade-interactive     # disable auditing for this run
```

Precedence, highest first: command-line flag → `NUI_AUDIT` / `NUI_SECTION`
environment variable → `package.json` config → default (on).

> Vulnerability data comes from npm's advisory endpoint, so auditing needs
> network access. When it can't reach the network the tool says so
> (`no network — couldn't check for vulnerable packages`) rather than pretending
> everything is clean, and the upgrade flow works as normal.

## How closely does this match yarn?

Follows yarn closely:
- The three-column Current/Range/Latest layout and the help text wording
- The up/down/left/right navigation model (selection = which column is
  highlighted per row, not a separate checkbox)
- The `c`/`r`/`l` bulk-select shortcuts, including `l`'s fallback to the
  Range value when a package has no separate Latest suggestion
- Packages with no available upgrade never appear in the list
- The version-diff coloring algorithm (segment-by-segment: modifier → major
  → minor → patch)

Deliberate additions / differences (this is *inspired by* yarn, not a clone):
- **Vulnerability warnings + `overrides`** — flags vulnerable direct and
  transitive packages, lets you pin a safe version via npm `overrides` (a single
  global pin, or per-dependent **scoped** pins when a global pin would disturb an
  already-safe copy), and flags existing overrides that are no longer needed so
  you can remove them. Yarn's command has no equivalent.
- **Sectioned layout** — the list is grouped into Dependencies / Dev
  dependencies / override sections by default (yarn shows one flat list; use
  `--no-section` to match that).
- Compound ranges (`>=1.0.0 <2.0.0`, `1.x || 2.x`, `1.0.0 - 2.0.0`) have no
  single modifier to re-apply, so they're **collapsed to a caret**: Range =
  `^<highest version the range already allows>`, Latest = `^<newest published>`.
  Only protocol ranges (git/file/link/workspace, npm aliases) are skipped —
  those can't be resolved against the registry's version list at all.
- Only `dependencies`/`devDependencies` are scanned (matches yarn's own
  scope for this command — it skips `peerDependencies`/`optionalDependencies` too).
- The list stays alphabetically sorted the whole time it's loading. Yarn's
  actual implementation fills rows in whatever order each network request
  finishes, which can make rows jump around while loading — this clone
  avoids that instead of reproducing it.
- No monorepo/workspace support (single `package.json` only).
