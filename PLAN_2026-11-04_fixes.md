# Plan: fixes from the 2026-11-04 field report

Status: **Phase A in progress** (A7, A1, A2, A3 done). Phase 0 is done.
Source: `docs/2026-11-04-field-report.md` (2.2.0 on npm 11.13.0). F1–F7 are that report's findings.
Line references are to `main` @ `360a0e6`.
Scope: what the run showed the tool getting wrong. Fixes are designed from how the CLI works and
checked against what the run did. The capture's own suggested fixes are not the starting point; "Not
taken" says which were dropped and why. Every item follows CLAUDE.md's README-sync rule, and README
edits describe behaviour in plain words without linking `docs/`.

## Decisions

Each is a recommendation; flip any you disagree with.

1. **Warn on the `minimatch` shape, don't refuse.** The first draft refused. The run reverses that: the
   pin took vulnerable copies from 12 to 2, nothing the project runs broke, and refusing leaves the target
   of zero further away with nothing in its place.
2. **Tell, don't act.** `o` still writes pins, and the tool runs no `npm update`. Acting is v3, as decided
   on 2026-10-20. The exception is A3, on purpose.
3. **Verify after the install, don't predict before it.** Root reachability could be computed up front, but
   Phase 0 found npm releases disagreeing on new edges and on `npm update`. Reading the lockfile afterwards
   holds on all of them.
4. **Stale pins get "bump or delete", not "delete".** Deleting them brings an `esbuild` advisory back.

## Phase 0: results

These ran before this plan was written, and they changed it.

| Question | Result | What changed |
|---|---|---|
| 0a. Does root reachability hold on 10.9.9, 11.9.0, 12.2.0? | For locked copies, on all four. New edges under a workspace ignore the pin only on npm 11 | F1 narrowed. On 10.9.9 and 12.2.0 the report's "already locked" framing is right; on npm 11, new edges ignore the pin too |
| 0a, unplanned. Is `npm update` the same across releases? | No. 10.9.9 and 12.2.0 honour the pin, even across a major. npm 11 goes to the newest in range | A1's routes rewritten. "Only a reinstall lands a cross-major pin" is true on npm 11 only |
| 0b. Delete in-range pins, then `npm update`? | npm 11: exactly 3 packages move, direct 5, stable. 10.9.9 and 12.2.0: also pull in stale `vue` and `devalue` pins | A1's stale-pin warning covers both routes |
| 0c. Reinstall without the stale pins? | Clean of the downgrades, but `esbuild` returns. Bumped instead of deleted: 4 direct, no downgrades | Decision 4 |
| 0d. Selector key on the existing lockfile? | Same vulnerable copies as the run's bare pin on npm 11 (2), fewer on 12.2.0 (1), and `eslint` keeps 3.1.5 | B1 moves up. A2's README line gets an exact form |
| F5 check. Does a global `zod` pin lower 4.6.7 copies? | No, scoped pins protect them | F5 corrected. A3's tree-wide floor lost its evidence, and was later dropped |

## Phase A: this branch, ships with the Unreleased 2.3.0

### A1. After every install, say what didn't land and what's still flagged (F1, F2, F7)

No network. Reads the lockfile the install just wrote.

- **`src/vulnerabilities.js`.** Export `pinsNotLanded(packages, overrides, pins)`, built on
  `unappliedOverrides` (`:393`) and `installedCopies` (`:224`). This run's pins only, written or already
  present. Copies *below* the pin only, so `npm update` landing above it isn't called a failure. Skip
  `inBundle` copies. Each gap carries dependents and declared ranges, and `inRange` when all admit the pin.
  `installedCopies` gains the dependents' names.
- **`stillFlagged(vulns, packages)`** re-tests the pre-install advisories (`matchesAny`, `:59`) against the
  new lockfile.
- **`src/components/App.js`** passes the audit's `vulns` through `onSubmit`, and `TuiResult` in `src/cli.js`
  carries it.
- **`src/cli.js`.** `runNpmInstall` (`:215`) resolves with its exit code. On 0, re-read with
  `loadInstalledVersions` and print last. The hard-coded `rm -rf` (`:187-188`) goes through the same
  formatter. The standalone "Run npm install" line stays, since a standalone project applies pins on its
  next install. With `--no-install` nothing changes.
- **`src/summary.js`.** `formatInstallCheck`. On the real run, it prints:

```
Not applied: these pins are in package.json, but the lockfile has older versions.
  qs  pins 6.17.1, lockfile has 6.16.0 (co-body declares ^6.5.2)
  node-forge  pins 1.4.3, lockfile has 1.4.0 (listhen declares ^1.4.0)
  jsdom › undici  pins 7.30.1, lockfile has 7.30.0 (jsdom declares ^7.25.0)
  glob  pins 14.0.3, lockfile has 13.0.6 (@vercel/nft declares ^13.0.0, js-beautify ^13.0.6)
  minimatch  pins 11.0.4, lockfile has 10.2.5 (editorconfig declares ~10.2.4), 10.2.6 (readdir-glob ^10.2.2)

Older overrides also not in effect, which the steps below can apply:
  devalue 6.0.3 → 5.9.4 (major), vue 3.5.44 → 3.5.43, esbuild 0.28.2 → 0.28.1, ...
Bump or delete those first.

Inside their declared ranges: delete those pins from package.json, then run
  npm update qs node-forge undici
This also moves other copies within their ranges.

Outside their declared ranges: try
  npm update glob minimatch
Some npm releases apply the pin this way. If the lockfile still has the older versions, only a full
reinstall does:
  rm -rf node_modules package-lock.json && npm install
That re-resolves every dependency and can add new advisories.

Still flagged, no pin written this run:
  zod (chromium-bidi declares ^3.24.1, safe from 4.6.6)
  deepmerge, extract-zip (no patched version)
```

- A package with both in-range and out-of-range copies goes in the second group.
- Each section prints only when it has something to say.
- Tests: `pinsNotLanded` on the `unapplied-override-*` locks; `formatInstallCheck` byte-exact in
  `test/unit/summary.test.mjs`; an integration test on real npm, a workspace with `co-body` (in range) and
  `editorconfig` (out of range). It asserts the tool's report from the resulting lockfile on every release, and
  npm's own behaviour only where all four measured releases agree.

### A2. Warn when a pin leaves a dependent's major, in every global picker (F3)

What `o` writes doesn't change.

- **`src/override-select.js`.** `crossedDependents(vuln, version)`: outside the declared range and outside
  `^minVersion(declared)`, so an exact `1.16.0` taking 1.16.2 stays quiet and `^0.8.8` taking 0.9.0 doesn't.
  Invalid ranges are skipped. It also returns which of them are already safe and would move off their line
  (`!satisfies(v, ^installed)`).
- **`src/components/OverridePicker.js`.** Shows it for the cursor's version, naming a few and counting the rest.
  `App.js` (`:341`) passes `vuln`. `PICKER_MAX_HEIGHT` grows to fit.
- **`src/components/Row.js`.** `overrideLabel` carries the count on the staged badge.
- **README Notes.** One plain line on the hand route: `"minimatch@>=7": "11.0.4"` leaves older copies alone.
- Tests: `test/unit/override-select.test.mjs`, including prereleases, 0.x and null `installedVersion`, which the
  run has no rows for. A new npm-built fixture for this shape (`eslint-plugin-react@7.37.5` + `glob@13.0.6`), per
  CONTRIBUTING's rule that a fixture's lockfile is npm's own output.

### A3. Don't offer versions below the user's own pin (F5)

In `computeVulnerabilities` (`:973`), floor `safeVersions` at an existing top-level pin that is verified safe.
`firstPatched` stays as computed, so row columns don't change.

- **The pin floor has the run behind it.** Second run, `qs`: the picker offers 6.17.1 only, accepting it reaches
  "already present", and A1 gives the route.
- **The tree floor was dropped during implementation.** For a direct dependency, `o` bumps the root's own range
  rather than writing a global pin, so flooring at a safe nested copy on a higher major would take the in-major fix
  off the list. The run shows no harm from leaving it out, because scoped pins protected the `zod` copies. The comment
  that claimed "anywhere in the tree" now says what the code does.
- This changes what `o` writes on a second run, on purpose.

### A4. Say when no pin is needed (F4)

`inRangeFix` and no `heldBy`: the row hint adds `or run npm update <name>, no pin needed`. Information only. On the
run: `fast-uri`, `node-forge`, `qs`, `undici`. `serialize-javascript` is held by its own older pin, so it's correctly
left out. Tests in `test/unit/rows.test.mjs`.

### A5. Make "Overrides not in effect" reachable (F6)

When focus is on the last navigable row, the window extends to the end of the list, so a read-only tail shows in full
on any terminal. A pure helper in `src/components/rows.js`, tested there, and one polled check in `test/app.test.mjs`.

### A6. Docs

- **README.** **What it does**: the post-install report, and the `npm update` hint. **Notes**: the "added after the
  lockfile" bullet is wrong in both directions, so rewrite it in plain words; add A2's line.
- **CHANGELOG.** Unreleased: A1, A2, A4, A5 under **Added** or **Fixed**; A3 under **Changed**, saying plainly what `o`
  now writes on a second run.
- **Comments** stating the old rule: `src/vulnerabilities.js:373-383`, `src/components/App.js:217-223`,
  `src/components/rows.js:127-130`, `src/components/Row.js:279-282`, `src/cli.js:174-179`.
- `--help` checked; no change expected. Published CHANGELOG entries and dated docs stay as written.

### A7. Keep the rebuild and probe scripts

`scripts/rebuild-capture.mjs` (a project from a capture's lockfile) and `scripts/probe-audit.mjs` (the tool's verdicts,
no TUI), plus a line in CONTRIBUTING. Not shipped. This settles the 2026-10-17 plan's open A6: two reports have needed
them, and the verification below does. TUI rendering stays out, because it uses fixed sleeps.

## Phase B: after this branch

- **B1. Spike the selector key, next.** `docs/YYYY-MM-DD-spike-selector-pin.md`. It beat the run's bare pin in F3, on every
  npm 11+ measured. Questions: spaced against unspaced (10.9.9 ignored the spaced form); an open upper bound (`>=7` would
  also catch a future 12.x); multi-advisory unions (`||`, unreliable in the 2026-10-11 spike); existing bare keys;
  `unappliedOverrides` learning qualified keys. If clean, `o` offers it for this shape, replacing A2's README route.
- **B2. Bisect the flips** between 10.9.9 and 11.9.0 and between 11.13.0 and 12.2.0, for `npm update` and for new edges.
- **v3 (`PLAN_2026-10-17_fixes.md`, Phase B) needs additions:**
  - Its flow recreates the lockfile first. In this run, that's what lowered `devalue` and `vue` and added `nx`'s `undici`. It
    must bump or clear stale pins first, and re-audit after.
  - B0.2 is answered: it depends on the release. B0.4 is answered: yes, on all four.
  - B2 there (`o` stages `npm update`) must account for 10.9.9 and 12.2.0 pulling in stale pins alongside it.
  - F4 is the case for upgrades first, overrides after. B4's full re-audit extends A1, which only knows packages flagged
    before the run.
  - F4 also has one user's evidence on the picker default (F8 of 2026-08-11): every global pin was the newest one short of a
    new major the run could avoid.

## Not taken from the capture's suggested fixes

- **Auto-running `npm update`, then checking the result equals the pin.** npm 11 lands above the pin, so the check would call
  a safe result a failure. Acting is v3.
- **Dropping the `rm -rf` hint.** On npm 11 nothing else non-manual lands a cross-major pin. It stays, with its costs stated.
- **Rewriting lockfile entries.** The best result measured, and recorded as such. But it bypasses npm's resolver, so a new
  version's own dependencies aren't resolved. Not something the tool should do.
- **Treating the shape as "no fix".** Decision 1.

## Devil's advocate review

An independent reviewer attacked the first draft using the capture, and its numbers were re-checked against the raw data. Every
objection was tested against what the run did. Phase 0 then added the last rows.

| Objection | What the real run says | Verdict |
|---|---|---|
| Refusing `minimatch` leaves the user worse off | 12 vulnerable copies to 2; lint, build and tests passed; the report says it "may still be the right answer". Refusal keeps about 12 | **Changed:** warns |
| The reinstall route repeats the harm being warned about | Fresh tree: `devalue` under `nuxt`'s `^6.0.3`, `vue` down a patch, new high through `nx`, out-of-range edges 33 to 44 | **Changed:** route names each side effect |
| `^installed` hides the very dependent on a second run | `eslint-plugin-react` (`^3.1.2`, has 11.0.4) goes unnamed; the declared-range test finds 17, not 2 | **Changed:** A2 tests the declared range |
| Post-install is silent on the rest of the way to zero | The user would still need `npm audit` for `zod`, `deepmerge`, `extract-zip` | **Changed:** the re-check gives exactly the 8 in `post/audit.json` |
| "Only a reinstall lands a cross-major pin" | True on npm 11. `npm update glob minimatch` lands both on 10.9.9 and 12.2.0 | **Changed:** route says try it first |
| "Delete the stale pins first" | Fresh resolve without them: `esbuild` returns, 5 direct | **Changed:** "bump or delete" |
| "v3 unchanged" | A reinstall is v3's first step, and it caused the harm above | **Changed:** additions listed |
| "The TUI listed 7" oversells the warning | 24-row frames reach 4, never `devalue` | **Changed:** F6 and A5 |
| The `npm ls` argument against hand edits | A fresh resolve shows invalid entries too | **Changed:** reason replaced |
| "Below the pin" hides something | Reporter's pins and default pins both give the report's six copies; no above-pin copy is in the audit | Survives |
| Grouping sends a package down a dead route | `npm update` lands the 3 in-range on npm 11; `~10.2.4`, `^10.2.2`, `^13` don't move | Survives. "Delete those pins" stays, since `x` can't clear them |
| Warnings add noise | Pre tree: only `minimatch` (18) and `glob` (9), plus `fast-uri` at 4.2.3. `follow-redirects`, `@nuxt/*`: none | Survives |
| The floor empties a list or breaks fixtures | Emulated over probes and fixtures: no empty lists, fixtures unchanged | Survives |
| The `inRangeFix` hint gives bad advice | 4 rows. All four clear on 11.13.0 from the `pre` tree | Survives |
| The post-install message gets lost | Printed after npm's output, so it's last | Survives |
| Wait for v3 | Everything here tells, except A3, and 2.3.0 was already scoped that way on 2026-10-20 | Survives |

**No evidence in the run, so tests must cover them:** prereleases, 0.x ranges, null `installedVersion`, bundled pinned copies. **No
evidence and no test can settle them:** terminal size, and whether the project's own suite passes after any route.

## Verification

Tests fail first, then `npm test` and `npm run typecheck`. Then replay against the capture, using A7's scripts, which is the check
that counts:

| Real-run moment | v2.2.0 did | After Phase A, must |
|---|---|---|
| `o` on `minimatch` | Plain version list | Warns: 18 dependents, 5 already safe, named |
| `o` on `glob` | Plain version list | Warns: 9 dependents |
| `o` on `fast-uri` | Plain version list | Warns only with the cursor on 4.2.3 |
| `o` on `follow-redirects`, `@nuxt/*` | Plain version list | No warning |
| `qs`, `node-forge`, `undici`, `fast-uri` rows | "press o" | Also shows `npm update` |
| After install, the run's pins | Silent | The report's table: 5 pins, 6 copies |
| After install, default pins | Silent | Same 5, no alarm on `serialize-javascript` or `@nuxt/*` |
| After install, all names listed | Silent | Exactly the 8 direct packages in `post/audit.json` |
| Route text | `rm -rf` only, and only if nothing was written | Both routes; names `devalue` (major), `vue`, `esbuild` |
| Second run, `o` on `qs` | Rewrites to 6.16.1 | Offers 6.17.1 only; already present; gives the route |
| Second run, `o` on `zod` | Global 4.6.6, no warning | Still offers 4.6.6 (scoped pins keep the root's 4.6.7, per F5); warns on `chromium-bidi` |
| Second run, 24-row terminal | 4 of 12 rows visible | All 12 reachable |

The next real run is wrapped as `capture-run.sh pre` / `nui | tee` / `capture-run.sh post`, so a session exists at last. Both of the last
two captures lacked one.

## Sequencing

- **PR 1 (this branch):** the report, this plan, then Phase A. It changes what `o` writes on a second run, so the PR says so.
- **PR 2:** the B1 spike.
- **PR 3:** B1's writer, if the spike is clean.
- v3 picks up the additions above.

## Out of scope

- Detecting a package newly vulnerable through an upgrade, which A1 can't see because the pre-install audit never flagged it. npm's own
  `found N vulnerabilities` line still prints. That's B4 in the 2026-10-17 plan.
- Predicting at write time that a pin won't land (decision 3).
- The picker's default position (F8 of 2026-08-11). It stops mattering for in-range fixes once v3 stages `npm update`.
