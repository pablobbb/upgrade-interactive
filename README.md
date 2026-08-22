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
   transitive dependencies. Flagged rows show a ▲ icon, severity, and a
   clickable CVE link, with the affected range and first fixed version inline.
5. Press `o` on a vulnerable package to **pin a safe version via npm
   `overrides`**. A single-version package gets one global pin; a package
   installed at several versions gets **per-dependent scoped pins**
   (`parent › package`) so already-safe copies are left alone. If the package is
   one of your **direct** dependencies, it bumps that dependency's range instead
   — npm rejects a top-level override that conflicts with a direct dependency
   (`EOVERRIDE`). The picker scrolls, so a package with a long list of safe
   versions (or a long list of dependents) stays reachable in any terminal.
6. **Flags overrides that are no longer needed** (nothing depends on them, or
   your deps now resolve safely without them). Press `x` to remove one — it only
   ever removes the one you select.
7. Writes your choices back to `package.json` and runs `npm install`.

By default the list is grouped into **Dependencies**, **Dev dependencies**, and
override sections. Pass `--no-section` for a single flat list. In an npm
workspace repo, each workspace additionally gets its own outer section (root
first); `--no-section` collapses only the inner field grouping.

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

Not every package offers all three columns — a package already at the top of its
range has no Range, one whose range already reaches the newest version has no
Latest. `←` / `→` skip the columns a package doesn't offer and stop at the last
one it does, so the marker never sits on an empty cell. `c` / `r` / `l` fall back
the same way, always *downwards*: `l` takes Range when there's no Latest, and `r`
leaves a package on Current rather than staging a major it never offered.

Version numbers are colorized by bump size (minor vs. major), highlighting only
the part that changed.

## Flags

- `--install` / `--no-install` — run `npm install` after writing changes (default: on)
- `--audit` / `--no-audit` — vulnerability check (default: on)
- `--section` / `--no-section` — grouped sections vs. flat list (default: on)
- `-w, --workspace <name>` — in a workspaces repo, limit to matching workspace(s);
  repeatable, matches by package name or path (e.g. `-w packages/api -w @acme/web`)
- `--no-workspaces` — only the root `package.json`, ignoring any `workspaces` field
- `-h, --help`, `-v, --version`

`--install`, `--audit` and `--section` are on by default. To change a default
permanently, use an env var or a `package.json` config block:

```json
"upgrade-interactive": { "install": false, "audit": false, "section": true }
```

```sh
NUI_AUDIT=0 npx upgrade-interactive
```

Precedence, highest first: CLI flag → `NUI_INSTALL` / `NUI_AUDIT` / `NUI_SECTION`
→ `package.json` config → default (on). In a workspaces repo the config block is
read from the root `package.json` only — see [Workspaces](#workspaces).

> Auditing needs network access. Offline, the tool says so (`no network —
> couldn't check for vulnerable packages`) instead of pretending everything is
> clean, and upgrades still work.

## Workspaces

Run it in an npm workspaces repo (a root `package.json` with a `workspaces`
field) from anywhere in the tree. Each workspace gets its own section (root
first), and edits are written to that workspace's own manifest. `overrides` and
`npm install` always go to the root, which npm shares across workspaces — so a
vulnerable package used by several workspaces is staged as an override once,
from one row.

"From anywhere in the tree" includes running inside a workspace: from
`packages/api` the tool still operates on the whole repo and reads its
`upgrade-interactive` config from the **root** `package.json`. Use
`--no-workspaces` for the old one-manifest behavior.

A workspace's own block is ignored — those settings describe the run, not a
package. You get a note naming the file and keys whenever an ignored block would
have changed the run.

A repository with no `workspaces` field is unaffected by any of this — it loads
exactly one `package.json` and renders no workspace headings.

Because npm honors `overrides` only in the root manifest, a vulnerable package
whose workspaces declare *different* ranges can't be fixed by any single
override entry. Those rows say so and offer no pin — upgrade each workspace's
own row instead. This holds under `--no-workspaces` too: narrowing what you edit
doesn't change what's installed, so the pin would still be wrong.

Scope with `-w <name>` (repeatable) or `--no-workspaces`:

```console
$ nui -w packages/api                 # by path
$ nui -w @acme/web                    # by package name
$ nui -w packages/api -w @acme/web    # repeatable
```

A `-w` value that matches no workspace is an error naming what didn't match,
rather than an empty list — as is combining `-w` with `--no-workspaces`. Paths
match regardless of separator or a trailing slash, so the form your shell
completes is always accepted.

The `workspaces` glob supports literal paths, `*` anywhere within a path segment
(`packages/*`, `packages/*-api`), a trailing `**`, and `!` exclusions. That is a
subset of npm's patterns: `?`, character classes (`[a-z]`), brace expansion
(`{a,b}`) and a non-trailing `**` are not supported, and unlike npm a `*` here
also matches directories whose name starts with a dot.

## Notes

- **Compound ranges** (`>=1.0.0 <2.0.0`, `1.x || 2.x`, `1.0.0 - 2.0.0`) have no
  single modifier to re-apply, so they collapse to a caret. Protocol ranges
  (git/file/link/workspace, npm aliases) are skipped entirely.
- A package you've already pinned through `overrides` isn't flagged again. The
  audit judges the versions you actually have; the version your dependents
  *would* fall back to without the pin is computed too, but only to decide
  whether the pin is still needed (step 6 above) — never to call the package
  vulnerable.
- Only `dependencies` / `devDependencies` are scanned.
- The list stays alphabetically sorted the whole time it's loading.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the test conventions, and how
to capture a run against a real project with `scripts/capture-run.sh`.
