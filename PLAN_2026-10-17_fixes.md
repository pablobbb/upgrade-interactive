# Plan: fixes from the 2026-10-17 field report

Status: **Phase A implemented** (A1–A5 and the F1 fixture; A6 undecided).
Phase B is v3.
Source: `docs/2026-10-17-field-report.md` (2.2.0 on npm 11.13.0). F1–F5 are that
report's findings. Line references are to `main` @ `04b53f3`.
Scope: everything the report found wrong in the tool, split into what ships on
this branch (Phase A) and what changes what `o` writes (Phase B, v3). Every item
follows CLAUDE.md's README-sync rule. README edits describe the behaviour in
plain words and never link to `docs/`.

## Decisions (2026-10-20)

1. **Phase A on this branch; Phase B is part of v3.**
2. **A prerelease range hides a lower Latest too.** This was suggested and is
   implemented; flip it if you disagree. `^27.0.0-alpha.10` with `latest` on 26.x
   offers no Latest. Latest never means "older", and bulk `l` would otherwise move
   every prerelease dependency back a major.
3. **Update-only vs. update-or-pin is postponed to Phase B.**
4. **A6 is open.**

## Background

Two root causes, plus two independent findings:

- **The tool writes an override when none is needed.** F2: the global path pins
  the oldest safe version (`defaultOverrideSelection` → `safeVersions[0]`). It never
  asks whether the newest version in every dependent's declared range is already
  safe. That is exactly the test `collectRemovableOverrides` applies on the next
  run (`src/vulnerabilities.js:527-530`), so the next run calls the tool's own pins
  unneeded. In F1, the one fix that works for brace-expansion's 2.x copies is also
  in range: drop the old pins, then run `npm update brace-expansion` (experiment E).
  The tool has no way to offer it.
- **What the tool says about scoped pins is wrong or missing.** An existing scoped
  pin holding a vulnerable version is never named as the cause (F1 b). The refusal
  note names a key that may not exist (F1 c). Pins covering 2 of 4 dependents read
  as a whole fix (F1 d).
- **Independent:** F4 (the Latest column offers a downgrade when the `latest`
  dist-tag lags) and F5 (`npm audit` totals drift on an unchanged lockfile, which
  skews the capture tooling).
- **F3 was not reproduced.** Its likeliest cause is F1 d: a partial fix shown as a
  whole one that then "came back". No item targets F3 directly.

Fixing the first root cause changes what `o` writes and adds an `npm update` step
after the install. That is v3 work (decision 1): v3 fixes in-range issues by
refreshing the lock or running `npm update`, and keeps overrides for out-of-range
fixes. Phase A leaves what `o` and `x` write unchanged.

Checked beyond the report:

- **F4 matches yarn.** yarn's `fetchSuggestions`
  (`plugin-interactive-tools/sources/commands/upgrade-interactive.tsx`, berry
  `master`) compares Latest only for equality, so the guard is a divergence and
  sits in README **Notes**.
- **F4 is in both branches of `fetchSuggestions`.** The report cites the simple
  branch (`src/semver-suggest.js:120-139`); the compound branch has it too
  (`:111-112`).
- **The CLI only ever runs `npm install`** (`src/cli.js:199-206`). Experiment D
  shows that alone keeps a locked in-range copy where it is.
- **What `npm update` does with an override depends on the state.** On the F1
  fixture (standalone, pins applied; npm 10.9.9 and 11.13.0), `npm update
  brace-expansion` *honours* the held pins and moves nothing, and removing the
  pins and running `npm install` keeps 2.1.4. Only removal plus `npm update`
  reaches 2.1.7. The 2026-08-26 spike instead saw `npm update` *ignore* an
  unapplied pin in a workspace. Either way, the pins that hold the package must
  go before `npm update`.

## Phase A — this branch

### A1. Never offer a Latest lower than what the range already allows (F4) — done

`src/semver-suggest.js`, both branches. Latest is dropped when `distTags.latest`
is lower than `maxSatisfying(versions, referenceRange)`. A dist-tag range
(`beta`) follows its tag, so it isn't compared (an existing test pins that).

- Tests (`test/unit/semver-suggest.test.mjs`): the electron-builder dist-tags →
  `null`; Range kept with Latest empty; the compound branch; a prerelease range
  (decision 2). All four failed before the fix.
- README **Notes**: one line. CHANGELOG: **Changed**.

### A2. Name the real conflict in a refused-pin note (F1 c) — done

`markPinRefusals` keeps `kind: 'shadowed'`, and adds `proposed: true` with `key`,
`name` and `version` when the other side is a pin the tool is proposing.
`pinRefusalText` then reads `npm keeps only one of the identical pins "a" and "b"
(name version)`. An existing key reads `npm would ignore a pin beside your
override "<key>"`.

- Tests (`test/unit/override-safety.test.mjs`): the record for both proposed
  pins; the note for proposed and for existing keys.
- README: no change.

### A3. Show a partial fix as partial (F1 d) — done

`overrideLabel(spec, vuln)` appends `, N dependents still vulnerable` when the
staged scoped pins cover fewer dependents than are vulnerable. `FixColumn` is
unchanged; the label carries the count.

- Tests (`test/unit/rows.test.mjs`): partial, full, a single pin, a global pin.
- README: no change.

### A4. Name the overrides that hold a vulnerable version, and the way out (F1 a, b) — done

This differs from the draft in one place: there is no per-edge `heldBy`. npm
matches keys by declared range (spike Finding 4), so matching pins to edges
would guess.

- **`vuln.heldBy`.** Every existing entry pinning the package (top-level, `"."`,
  or one level under a parent key) whose pin doesn't resolve to a verified-safe
  version, as `[{ key, pin }]`. It is `null` when an entry can't be judged: a
  `$` reference, deeper nesting, or unverified candidates.
- **`vuln.inRangeFix`.** True when every dependent's newest in-range version is
  verified safe and no downgrade. It shares `newestInRange` with the
  removability pass. Phase B1 builds on it.
- **Blocked-row note.** It leads with the held pins when there are any, then
  gives the way out:
  - `remove those pins, then run npm update <pkg>`;
  - with nothing to remove, `run npm update <pkg> instead`;
  - with no in-range fix, `edit overrides by hand`, as before.
- Tests:
  - `test/unit/vulnerabilities.test.mjs`: `inRangeFix` and `heldBy` cases;
  - `test/unit/override-safety.test.mjs`: notes, plus the fixture below;
  - `test/integration/override-safety.test.mjs`: replays the way out on real
    npm, removing the pins the tool names.
- README **What it does**: one line. CHANGELOG: **Fixed**.

**Fixture `held-by-scoped-pins`.** This is spike fixture B with both
`minimatch@…` keys pinning `brace-expansion` 2.1.4. On npm 11.13.0 a single
resolve put both 2.x copies on one hoisted 2.1.4, so no staging trick was needed.
The snapshot was captured on 2026-10-20 and holds `brace-expansion` advisories
only. NOTES.md records the npm 10.9.9 and 11.13.0 measurements.

### A5. Make the capture tooling compare direct advisories (F5) — done

- `scripts/capture-run.sh` prints packages with a direct advisory per side,
  then `direct advisories: pre -> post`, the remaining and introduced packages,
  and npm's totals as a context line.
- CONTRIBUTING, "Analyzing one", step 2 now says to compare direct advisories.
- Verified on the capture's saved audits: 11 → 2, unchanged across the 21- and
  34-total readings of `pre`. An end-to-end `pre`/`post` run in a scratch project
  printed the same.

### A6 (optional, undecided). Keep the analysis scripts

`tools/probe.mjs` prints the tool's audit verdicts for a project without the TUI.
`tools/render-tui.mjs` renders the real `App` for a project and can press `o` on
a package. Both run against any checkout of `src/`. They replaced the missing
`session.txt` in this analysis. Moving them to `scripts/` would need
`render-tui.mjs`'s fixed sleeps replaced with polling, plus a line in
CONTRIBUTING.

## Phase B — fix in range without an override (F2, F1 a): v3

### B0. Measure first

Write up a spike, `docs/YYYY-MM-DD-spike-in-range-update.md`, on npm 10.9, 11.13
and 12.2, against the `held-by-scoped-pins` fixture and the F2 shape (one
transitive copy, one global pin). Questions:

1. Does `npm update <names>` alone also apply the run's other `package.json`
   edits, or does it need `npm install` first?
2. Which pins does `npm update` honour? It honoured applied pins on the F1
   fixture, but ignored an unapplied one in a workspace (2026-08-26 spike). That
   decides the mixed case (B5).
3. Dedupe (F3, hypothesis 2): can an edge settle on an existing copy that is in
   range but not the newest, and is still vulnerable?
4. At a workspace root, does it update transitive edges under the workspaces?
5. After removing a scoped pin whose version is safe, does `npm install` keep the
   locked version?

### B1. One predicate for "fixable in range"

`inRangeFix` (A4) answers for both the route and removability. Add an invariant
test across every fixture: feed the overrides the default selection writes back
into `computeVulnerabilities`, with the same tree. Nothing the tool writes may
come back as "not needed". That is F2, written as a test.

### B2. `o` stages an update, not a pin, when `inRangeFix` holds

- **Spec and badge.** The staged spec is `{ update: true, drop: <heldBy keys> }`,
  shown as the badge `→ npm update`. Whether a pin is also offered is decision 3.
- **Writer.** Remove the `drop` entries, scoped and top-level. This is a new
  writer path: test both insertion orders, and check that every dropped entry is
  gone.
- **Direct dependencies.** The root edge keeps its range bump.
- **CLI.** Run `npm update <names…>` after `npm install` (or instead of it, per
  B0.1). With `--no-install`, print the command instead. `src/summary.js` lists
  updates separately.
- **Trade-off.** `npm update` moves already-safe copies to the newest version in
  range too (spike Finding 5).
- **Docs, in the same commit as the code:** README **What it does**,
  **Controls** and **Flags**; `--help` in `src/cli.js`; and CHANGELOG, saying
  outright that what `o` writes has changed. Check the screenshot's "press o"
  hint as well.

### B3. Unused overrides for scoped entries (rest of F1 b)

- Extend the removability pass to object-valued entries, child by child.
- Parse `parent@sel` keys properly, keeping 6d7c98b's guard and never judging an
  unapplied pin.
- `x` alone is enough only for a pin holding a safe version (B0.5). A pin
  holding a vulnerable version goes through B2.

### B4. Verify after the update

Re-read the lockfile and re-audit the updated packages, and print each one as
fixed or still vulnerable. This catches B0.3 if it happens. A full post-install
delta (2026-08-11 F5b) stays out of scope.

### B5. Mixed packages

Some packages have edges fixable in range and edges that need an out-of-range
pin. Keep pins for every edge of those, unless B0.2 shows `npm update` leaves
the kept pins applied. Out-of-range fixes still need an override (2026-08-11 F6).

## Sequencing

- **PR 1 (this branch):** the report, Phase A, the CLAUDE.md rule on naming
  projects. It includes a yarn divergence (A1), so it ships as 2.3.0.
- **PR 2:** the B0 spike doc.
- **PR 3 (v3):** B1–B5.

## Out of scope

- F3: nothing to fix without a reproduction. The next run must be wrapped as
  `capture-run.sh pre` / `nui | tee` / `capture-run.sh post`.
- The `affects` text contradicting `→ 2.1.7` (2026-08-11 F7).
- The global picker defaulting to the oldest safe version (2026-08-11 F8). After
  B2 it no longer matters for in-range fixes; for out-of-range ones it stays
  blocked on F6.
