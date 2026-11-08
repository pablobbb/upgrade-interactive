# Field report: v2.2.0 on an npm workspaces monorepo (2026-11-04)

**Tool:** `upgrade-interactive` 2.2.0. Verdicts were also read on `main` @ `360a0e6`, which
carries the Unreleased fixes. · **npm** 11.13.0 for the run; 10.9.9, 11.9.0 and 12.2.0 also
measured · **Node** v24.16.0 · macOS (Darwin 25.6.0 arm64 for the run, 24.6.0 for the analysis)

**Target project:** an npm workspaces monorepo (`packages/*`, `apps/*`; 11 workspaces,
orchestrated with lerna) with vanilla, React and Vue packages, Next.js and Nuxt adapters and demo
apps, and Storybook. One root lockfile (about 2,000 entries, 1,794 packages installed), with
`overrides` in the root manifest. `packageManager` declares npm 11.9.0.

**What the user reported:**

1. New overrides are written but never installed in a workspaces project, and nothing warns. They
   found out from a separate `npm audit`.
2. A global pin was written across several declared majors, with no warning.

The run happened on 2026-11-04. The capture and every measurement here are from 2026-11-05.

> **Read "How this capture was made" first.** The capture was reconstructed after the run. The
> report's facts are checked below, and several are corrected. Its suggested fixes are not used
> here: `PLAN_2026-11-04_fixes.md` plans the fixes.

---

## How this capture was made

- `pre/` is the project's last commit before the run. `post/` is the exact `package.json` and
  `package-lock.json` the run left, backed up before any manual fix.
- **Both `audit.json` files date from 2026-11-05**, a day after the run.
- **There is no `session.txt`**, because the tool's output wasn't kept. The picker text below comes
  from rendering the real `App` against the captured state, so it shows what the user would have
  seen, not their terminal.
- Workspace package names were anonymized to `@acme/*`, and an internal registry URL was removed
  from `config/.npmrc`. Every `resolved` URL in the lockfile is the public registry.
- `build.log` is `npm ci && npm run build`, exit 0. The user reports lint and tests also passed;
  neither is in the capture.

**The run can be replayed.** The capture has no workspace manifests, but the lockfile's `packages`
map records each one. A project rebuilt that way reports `up to date` with no semantic lockfile
change. Replaying the run (the `pre` lockfile, the `post` manifests,
`npm install --package-lock-only --before=2026-11-05T00:00:00Z`) reproduces `post/` except for 12
entries in `@babel/*`, `electron-to-chromium` and `rollup-plugin-visualizer`. No pinned package is
among them, so every unapplied copy reproduces.

## 1. Outcome

Counted in direct advisories, per F5 of `docs/2026-10-17-field-report.md`.

| | pre | post |
|---|---|---|
| Packages with a direct advisory | 14 | 8 |
| `npm audit` total | 61 | 29 |
| Lockfile entries | 2,026 | 1,994 |
| Build | — | exit 0 |

Direct advisories left: `deepmerge`, `extract-zip`, `glob`, `minimatch`, `node-forge`, `qs`,
`undici`, `zod`. None was introduced by the run.

The run bumped minors and pressed `o` on the vulnerable packages. It wrote 12 overrides:

| Override written | What happened | Why |
|---|---|---|
| `follow-redirects` 1.16.2 (bump) | Applied | Root reaches it (`nx` declares exact 1.16.0) |
| `fast-uri` 3.1.9 | Applied | Root reaches it |
| `eslint-plugin-react-hooks > zod` 4.6.7 | Applied | Root reaches it |
| `zod-validation-error > zod` 4.6.7 | Applied | Root reaches it |
| `minimatch` 11.0.4 | Partly | `editorconfig` keeps 10.2.5, `readdir-glob` has 10.2.6 |
| `glob` 14.0.3 | Partly | Hoisted `glob@13.0.6` stays, for `@vercel/nft` and `js-beautify` |
| `qs` 6.17.1 | Not applied | Locked 6.16.0, reached through a workspace |
| `node-forge` 1.4.3 | Not applied | Locked 1.4.0, reached through a workspace |
| `jsdom > undici` 7.30.1 | Not applied | Locked 7.30.0, reached through a workspace |
| `serialize-javascript` 7.1.4 (bump) | Coincidence | Its parent changed, so it re-resolved to the newest |
| `@nuxt/nitro-server` 4.6.4 | Coincidence | `nuxt` 4.6.4 declares that exact version |
| `@nuxt/vite-builder` 4.6.4 | Coincidence | Same |

The report counts the last three as applied. Replaying with lower pins (7.1.3, 4.6.3) still lands
7.1.4 and 4.6.4, so those pins did nothing.

---

## 2. Findings

### F1: pins don't land under a workspace, and the run says nothing — verified

The report's table is right: 5 pins, 6 copies. `repro.sh` reproduces it. The cause is narrower in
one way and wider in another than "npm ignores a new override for a locked package".

Small fixtures on public packages (`co-body@6.2.0` declares `qs ^6.5.2`), real installs:

| Workspace project, `npm install` | 10.9.9 | 11.9.0 | 11.13.0 | 12.2.0 |
|---|---|---|---|---|
| New pin, copy already locked | Ignored | Ignored | Ignored | Ignored |
| Bump of an applied pin | Ignored | Ignored | Ignored | Ignored |
| Same, but the root also depends on the parent | Applied | Applied | Applied | Applied |
| Parent added with the pin, nothing locked | **Applied** | **Ignored** | **Ignored** | **Applied** |
| `--workspaces`, `-w`, `--force`, `--prefer-dedupe`, `npm dedupe` | Ignored | Ignored | Ignored | Ignored |
| `rm -rf node_modules package-lock.json`, then install | Applied | Applied | Applied | Applied |

So on every release measured, an already-locked copy reached only through a workspace doesn't move,
and one the root also reaches does. That fits every row of the table in section 1. It's inferred
from behaviour, not from npm's source.

On npm 11, which the run used, a copy *newly resolved* under a workspace ignores the pin too. The
capture shows this: `readdir-glob` was upgraded by the same run's `nuxt` bump, and its `minimatch`
went from a safe 5.1.9 to a vulnerable 10.2.6 with the pin in place. The report lists this copy as
having "stayed on the old, vulnerable version". On 10.9.9 and 12.2.0, a new edge honours the pin.

One edge is worth knowing. `glob@13.0.6`'s `minimatch` took the pin even though only workspaces
reach that copy after the run. The root reached it before the run (through `lerna`, `pacote` and
`cacache`), and its root-reached dependents then moved to a nested `glob@14`.

**What the tool does today.** `src/cli.js` runs `npm install` and stops. The warning for this state
prints only when nothing was written. The TUI's "Overrides not in effect" section appears on the
next run (F6).

### F2: what fixes it, and what each route costs — verified

**`npm update` depends on the npm release:**

| Fixture, pin unapplied, `npm update qs` | 10.9.9 | 11.9.0 | 11.13.0 | 12.2.0 |
|---|---|---|---|---|
| In-range pin 6.16.1, newest 6.17.1 | 6.16.1 | 6.17.1 | 6.17.1 | 6.16.1 |
| Cross-major pin 5.2.1 | Nested 5.2.1 | 6.17.1 | 6.17.1 | Nested 5.2.1 |

The report's result holds on the npm it used, and the 2026-08-26 spike's Finding 2 holds on npm 11.
The report's pins matched because the run chose the newest version each time. On today's registry
(no cutoff, 11.13.0), `undici` 7.30.2 passes the 7.30.1 pin and the root's copy moves from 8.12.3 to
8.12.4. The report's "no other lockfile changes" holds only at its registry date.

**On the rebuilt `post` tree:**

| Route | 10.9.9 | 11.9.0 | 11.13.0 | 12.2.0 |
|---|---|---|---|---|
| Delete `qs`, `node-forge`, `jsdom`, `fast-uri` pins, then `npm update` those names: direct left | 4 | 5 | 5 | 4 |
| Keep pins, `npm update glob minimatch`: direct left | 6 | 8 | 8 | 6 |

- **npm 11 is clean and limited.** The first route moves exactly 3 packages. The second lands
  nothing: `glob` stays on 13.0.6 and `editorconfig`'s `minimatch` only reaches 10.2.6.
- **10.9.9 and 12.2.0 land more, and pull in stale pins.** They clear `glob` or `minimatch` too. With
  the first route, both also add `vue` 3.5.43 copies next to the root's 3.5.44 and a nested `devalue`
  5.9.4. 12.2.0 does the same with `vue` on the second route. A comment in the project's manifest
  records that two Vue runtimes crash its tests.
- Deleting the pins and running `npm install` alone moves no version, on 11.13.0 and 10.9.9.

**Pruning lockfile entries breaks the tree.** npm drops `qs` and `node-forge` and resolves `jsdom`'s
`undici` to 8.12.3, outside `^7.25.0`. This reproduces the report and the 2026-08-26 spike.

**A full reinstall lands every pin, at a cost** (lockfile-only on 11.13.0):

| Fresh resolve | Entries changed | Direct left | Edges outside range | Side effects |
|---|---|---|---|---|
| As the run left it | 576 | 4 | 44 (33 in `post`) | `devalue` 6.0.3 to 5.9.4 under `nuxt`'s `^6.0.3`; `vue` 3.5.44 to 3.5.43; `nitropack`'s `esbuild` 0.28.2 to 0.28.1 |
| Seven stale pins deleted | 669 | 5 | 29 | An `esbuild` advisory returns, with copies on 0.25.12 and 0.27.7: that pin still does real work |
| Stale pins bumped (`vue` 3.5.44, `esbuild` 0.28.2), `devalue` deleted | 588 | 4 | 32 | None of the above |

Every fresh resolve moves `nx` from 23.2.1 to 23.3.1, which declares exact `undici` 7.29.0, a new
high advisory. After a real reinstall, `npm ls --all` prints 71 invalid lines, up from 20.

The stale pins are the seven existing overrides that weren't in effect before the run: `vue` and four
`@vue/*`, `esbuild` and `devalue`. A reinstall applies them along with the run's own.

**Hand-rewriting the lockfile gave the best result measured.** Rewriting `version`, `resolved`,
`integrity` and `dependencies` for `glob` and both `minimatch` copies, on top of `npm update`, leaves 3
direct advisories and no downgrades, and survives `npm ci` and `npm install`. This confirms the report.
It bypasses npm's resolver, so a new version's own dependencies aren't resolved.

### F3: a global pin moved copies the advisory doesn't affect — verified

The report says all four installed majors fall under `GHSA-g3hv-75wg-m249`. The advisory is
`>=7.0.0 <11.0.1`, so `minimatch` 3.1.5 and 5.1.9 are not affected. The tool's audit agrees: of 18
dependents, 13 are vulnerable and 5 are already safe (`eslint`, `@eslint/config-array`,
`@eslint/eslintrc`, `eslint-plugin-react`, `readdir-glob`).

The path, confirmed on v2.2.0 and `main`:

1. `decidePinStrategy` returns `scoped`, since some copies are safe.
2. No vulnerable copy has a safe version in range, so `pinnableInstances` is empty and `shouldScope`
   is false.
3. `isPinBlocked` is false, since no copy has a `pinRefusal`.
4. `App.openOverride` opens the global picker. `defaultOverrideSelection` falls through to
   `safeVersions[0]`.

The picker shows nothing about any of this:

```
│ Override minimatch to a safe version:
│ ❯ 11.0.1
│   11.0.2
│   11.0.3
│   11.0.4
│ ↑/↓ choose · <enter> apply · <esc> cancel
```

`glob` takes the same path, with `glob@10.5.0` (`^10.0.0`) and `glob@13.0.6`. All 9 of its dependents
are vulnerable, so it has no safe copies to disturb.

**What the pin broke, and what it fixed.** Run against the `post` tree:

- All five `eslint-plugin-react` rules throw `minimatch is not a function` when configured with
  patterns: `no-danger`, `jsx-pascal-case`, `jsx-handler-names`, `forbid-component-props`,
  `no-unstable-nested-components`. None is in the plugin's recommended set, which is all the project
  enables, so its lint passes. This confirms the report.
- Importing `@eslint/config-array` or `@eslint/eslintrc` as ESM fails: `minimatch` 11 has no default
  export. `eslint` itself loads their CommonJS builds, which work.
- The pin also took vulnerable `minimatch` copies from 12 to 2, and lint, build and tests passed. On
  this run, it was a net gain the user wasn't told the price of.

**A version-selector key does the same without moving the safe copies.** Replaying the run from `pre`:

| Key, existing lockfile | npm | Vulnerable copies | `eslint` keeps 3.1.5 |
|---|---|---|---|
| `"minimatch": "11.0.4"` (the run) | 11.13.0 | 2 | No |
| `"minimatch@>=7": "11.0.4"` | 11.9.0, 11.13.0 | 2 | Yes |
| `"minimatch@>=7": "11.0.4"` | 12.2.0 | 1 | Yes |
| `"minimatch@>=7.0.0 <11.0.1": "11.0.4"` | 11.13.0 | 2 | Yes |
| `"minimatch@>=7.0.0 <11.0.1": "11.0.4"` | 12.2.0 | 1 | Yes |

- A fresh resolve with the spaced key leaves no vulnerable copy and 4 direct advisories, with `eslint`
  on 3.1.5.
- Swapping the bare key for the spaced one on the `post` lockfile restores nested 3.1.5 copies and moves
  nothing else.
- **npm 10.9.9 differs.** A small fixture ignored the spaced key, on real and lockfile-only installs, and
  honoured `>=7`. Its replay of this run also lands differently (11 direct advisories), so it isn't
  comparable here.

### F4: 7 of the 12 pins needed no override — verified

- **5 are in-range fixes:** `fast-uri`, `node-forge`, `qs`, `serialize-javascript` and `jsdom > undici`.
  `main` computes this as `inRangeFix`.
- **2 were fixed by the same run:** both `@nuxt/*` pins. `nuxt` declares those packages at its own exact
  version, and the run bumped `nuxt`. The audit reads the tree before the upgrades, so it can't see this.

On the `pre` tree with no new pins, `npm update qs node-forge undici fast-uri` clears those four rows on
11.13.0. It changes 5 entries, including the root's `undici`.

The next run calls 4 of the 12 unneeded: `fast-uri`, `serialize-javascript` and both `@nuxt/*`. This is
F2 of the 2026-10-17 report again.

The picker starts on the oldest safe version, yet every global pin the run wrote is the newest one short of a
new major it could avoid (`fast-uri` 3.1.9, not 4.2.3, on today's registry). That is one user's evidence on the
default that the 2026-08-11 report's F8 questions.

### F5: pressing `o` again makes it worse — verified

Pressing `o` is the obvious next step on a row that's still flagged.

- **The picker starts below the existing pin.** `qs` offers 6.16.1 first, and accepting it rewrites the pin
  from 6.17.1 to 6.16.1. Because that counts as a write, the "already present" path never runs, and npm still
  leaves 6.16.0 in place.
- **`zod` falls through as well.** On the second run all safe copies have moved, nothing is pinnable, and the
  default writes a global `"zod": "4.6.6"`. On the existing lockfile nothing moves. On a fresh resolve,
  `chromium-bidi` crosses from `^3.24.1` to 4.6.6. The root's 4.6.7 stays, because the scoped pins keep it there.

### F6: the warning that exists can't be reached — verified

"Overrides not in effect" rows aren't navigable, and the list window follows the focused row, so it never
scrolls to them. At 24 rows, only `vue` and three `@vue/*` render, of 7 rows before the run and 12 after. This
run's own pins sort last and never appear. A taller terminal shows more. Its size is unknown, but the report's
"nothing warns" fits this. The rows also offer no way out.

### F7: zero isn't reachable by any route here — verified

`deepmerge` and `extract-zip` have no patched version. `chromium-bidi` declares `zod ^3.24.1`, and the first
safe version is 4.6.6.

| State | Direct left | Which |
|---|---|---|
| As the run left it | 8 | `deepmerge`, `extract-zip`, `zod`, `glob`, `minimatch`, `node-forge`, `qs`, `undici` |
| `npm update` on the in-range names (npm 11) | 5 | `deepmerge`, `extract-zip`, `zod`, `glob`, `minimatch` |
| Plus the hand rewrite | 3 | `deepmerge`, `extract-zip`, `zod` |
| Full reinstall | 4 | `deepmerge`, `extract-zip`, `zod`, and a new `undici` through `nx` |

**The post-install lockfile already knows this.** Testing `pre/audit.json`'s advisories against the `post`
lockfile, offline, gives exactly the 8 packages `post/audit.json` reports as direct. The tool holds those
advisories when the user presses Enter.

---

## 3. Corrections to the report

| The report says | The evidence shows |
|---|---|
| All installed `minimatch` majors fall under the advisory | 3.1.5 and 5.1.9 don't (F3) |
| No other fix exists | A selector key leaves the safe copies alone (F3) |
| `readdir-glob`'s copy stayed on the old version | It moved from a safe 5.1.9 to a vulnerable 10.2.6 (F1) |
| npm reported "up to date" | Unlikely for this run: 212 lockfile entries changed. That line matches `repro.sh`. No session was kept |
| `npm audit` reported 21 | Unreconciled. The capture, a day later, has 29 total and 8 direct |
| `npm update` works for in-range pins | On npm 11 it lands on the newest, which happened to be the pin. Other releases differ (F2) |
| `npm update` doesn't cross a declared major | True on npm 11. 10.9.9 and 12.2.0 do (F2) |
| A full re-resolve is lossy | Not reproduced. See below |

**The lossy reinstall.** The report and two comments in the project's manifest say a full re-resolve dropped
`expect-type` and `ts-dedent`. With those root declarations removed, a fresh resolve keeps both, with no missing
edges: a real install on 11.13.0 and lockfile-only on 11.9.0. The earlier drops may have had other causes, and
this is lockfile evidence only, since the project's source isn't in the capture. F2 records the reinstall's real
costs.

**What holds up.** The 12 pins, 5 unapplied and 6 copies; `repro.sh`; the pruning result; `npm update` on the
report's date and npm; the hand rewrite; the code path; the five rules; the project shape.

## 4. Method

1. **Recomputed the report's facts from the capture**: the override diff, each copy by node's lookup, audits by
   direct advisory.
2. **Rebuilt and replayed the project** (see "How this capture was made"). Replays are
   `--package-lock-only --ignore-scripts --before=2026-11-05T00:00:00Z`, unless a row says otherwise.
3. **Mapped reachability** of every overridden edge from the root and from each workspace, on both trees. This
   surfaced `serialize-javascript` and `glob@13.0.6` as apparent counterexamples, which the lower-pin replay and
   the `pre` tree explain.
4. **Ran the tool's own audit** (`computeVulnerabilities`, the call `App.js` makes) on `pre` and `post`, on
   v2.2.0 and `main`. Rendered the real `App` with `ink-testing-library`.
5. **Ran counterfactuals** on the full tree and on small fixtures, across four npm releases. The small fixtures
   are a workspace `a` with `co-body@6.2.0`, locked with `--before=2026-10-01`, then given the override; and
   `eslint-plugin-react@7.37.5` with `glob@13.0.6` for the selector key.
6. **Ran the break claims**: the five rules through ESLint's `Linter`, and the ESM imports, on a real `npm ci`
   of `post`.
7. **Argued against each finding.** An independent reviewer attacked the fix plan using this capture. Its review
   is in `PLAN_2026-11-04_fixes.md`.

## 5. Limits

- **n = 1**, and the project's source isn't in the capture, so no lint or test run backs any route.
- **The audits are a day late**, and the replays use a registry cutoff, not the run's exact moment.
- **No original terminal output.** The frames are re-renders, at 24 rows.
- **The root-reachability rule is inferred**, from 4 npm releases. The boundaries where `npm update` and new-edge
  behaviour flip weren't bisected.
- **Most full-tree replays are lockfile-only.** Earlier reports found real installs can re-resolve more.
- **10.9.9 and 12.2.0 full-tree routes were read from lockfiles only.** Whether a second Vue copy crashes anything
  here is the project's own statement, not measured.

## 6. What's in the capture directory

The capture isn't committed. It lives in the `<project>-nui-run-20261104/` directory, and relative paths in this
report (`pre/`, `post/`, `repro.sh`, …) are relative to it.

```
REPORT.md                   the user's report, as two issues
meta.txt                    capture metadata + a note on the reconstruction
pre/  post/                 package.json, package-lock.json, audit.json
build.log                   npm ci && npm run build on post (exit 0)
config/                     eslint, prettier, playwright configs, tsconfig.json
npm-ls-post.txt             npm ls paths for the unapplied packages
overrides-vs-lockfile.txt   each written pin against the lockfile; lists out-of-scope copies too
repro.sh                    self-contained repro of F1, public packages only
```
