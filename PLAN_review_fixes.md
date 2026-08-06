# Plan: code-review fixes on `feature/monorepo-workspaces-support`

Status: **implemented** (Phases A–C landed; the follow-up below is not)
Scope: fix the defects a code review of the 11-commit workspaces branch found,
plus two pre-existing bugs the branch makes prominent. Single-package behavior
must stay byte-for-byte identical throughout.

## Background

A review of `main...HEAD` produced seven findings; a follow-up adversarial pass
re-derived each one from the code and reclassified them. What survived:

- **Two genuine regressions in new code** (A1 staged-override lock, A2 workspace
  glob negation) and **one gap in a new code path** (A3 unusable `-w`).
- **One pre-existing unsoundness** (B) that the branch does not cause but does
  newly *bless* in a comment, and which monorepo support makes far easier to hit.
  Two of the original findings turned out to be the same defect seen from the
  reader and writer sides.
- **Three cleanups** (C), one of which — the NUL bytes in `src/vulnerabilities.js`
  — is what caused the first review to misattribute B to this branch, because git
  classifies the file as binary and silently hides its diff.

Findings withdrawn or demoted by the adversarial pass are recorded at the bottom
so the reasoning isn't lost.

## Phase A — regressions and gaps in this branch's new code

### A1. Re-home orphaned staged overrides

`src/components/App.js:206-224`. `openOverride` locks editing to the row an
override was staged from (`existing.originKey !== focusedRow.key` → no-op). But
`vuln:<name>` rows are filtered out of `overrideVulns` the moment that package's
suggestion entry loads (`App.js:131-137`), and a loaded entry never un-loads. So
if the audit resolves before a package's suggestions do, the user can stage an
override from the `vuln:` row and then have that origin row disappear
permanently: `o` becomes a no-op on every remaining row, and `overrideView`
renders a note pointing at a row that no longer exists.

This is a real regression — `main`'s `openOverride` had no provenance guard.

- Add a `useEffect` keyed on the navigable-row set that reassigns `originKey` /
  `originLabel` for any staged override whose origin row is gone, pointing it at
  the first row matching that package name. This fixes the dead lock *and* the
  stale note in one place.
- Relax the guard itself so it only applies while the origin row still exists
  (belt and braces — the effect runs a commit later).
- Test in `test/app.test.mjs`: audit resolves while an entry is still `null` →
  stage from the vuln row → entry loads → `o` on the dep row opens the picker,
  and the "staged above" note is gone.

Not in scope (pre-existing): there is no way to *unstage* an override at all;
`setStagedOverrides` only ever sets.

### A2. Honor `!` negation in the `workspaces` glob

`src/workspaces.js:29-36, 95-111`. `normalizePatterns` passes `!`-prefixed
patterns through unchanged, and `matchSegments` then looks for a literal
directory named `!packages`, matches nothing, and returns `[]`. Net effect: the
negation is silently ignored and an explicitly excluded workspace is loaded and
written to.

- Partition patterns into positive and negated in `normalizePatterns`.
- Expand negatives through the existing `matchSegments` into a Set of
  directories and subtract them from the positive results. Applying negations
  after all positives regardless of order matches minimatch's semantics and
  needs no new glob code.
- Tests in `test/unit/workspaces.test.mjs`: `["packages/*", "!packages/legacy"]`
  excludes legacy; `!packages/*` excludes everything; a negation-only field
  yields `[]`.
- README: the Workspaces section documents the glob as "literal paths, `*`, and
  trailing `**` — a subset of npm's patterns". Add `!`.

### A3. Error on an unusable `-w`

`src/package-file.js:71-101`. Two ways to reach a silent empty screen instead of
an error:

- An unmatched `-w` value (a typo) filters every manifest out, producing zero
  descriptors and a clean "No upgrades found."
- `--no-workspaces` combined with `-w` sets `discovered = null`, so the only
  manifest is the root (`relPath: '.'`, `name: null`), which no `-w` value can
  match — same silent empty result.

Both checks belong in `loadProject`, which already receives `{ workspaces,
filter }`. `cli.js` prints its throws to stderr with exit 1, so no CLI change is
needed, and both become unit-testable:

- `workspaces === false && filter.length > 0` → throw.
- After the manifest loop, `filterSet` non-null and nothing matched → throw,
  naming the unmatched values.
- Tests in `test/unit/package-file.test.mjs`. `test/unit/flags.test.mjs` needs no
  change: `parseWorkspaceOptions` stays a pure, orthogonal parser.

## Phase B — cross-workspace pin unsoundness

`src/vulnerabilities.js`. A workspace manifest's lockfile path (`packages/a`)
has no `node_modules/` segment, so `nameFromLockPath` returns `null` and
`collectPinInstances` records it with `parentName: null` — indistinguishable
from a root direct dependency. `overrideKeyOf` therefore maps the root **and
every workspace manifest** to the same key, and `mergeInstancesByOverrideKey`
unions their `safeCandidates` across *different* declared ranges, keeping
`copies[0]`'s `declaredRange`.

Reproduced: root `^3.0.0` + `packages/a` `^4.17.0` yields a merged instance with
`declaredRange: '^3.0.0'` and `safeCandidates: ['4.17.21']`. Applying it rewrites
the root's `dependencies.lodash` to `4.17.21` — a silent major bump — and leaves
`packages/a` untouched. The same defect from the writer's side: `applyProject`
routes all overrides to the root, so `directField` never sees workspace-owned
direct deps.

This mechanism is **pre-existing on `main`** — the branch's only change to
`src/vulnerabilities.js` is a nine-line comment. But that comment asserts the
case is handled ("correct for the common case … upgrade those per row instead")
when the real behavior is a silent wrong write.

### B1. Detect the conflict and refuse to pin

Emptying the conflicted instance's `safeCandidates` is **not** sufficient:
`isPinnableInstance` gates on non-empty candidates, so `shouldScope` would go
false and `openOverride` would fall through to its *global* branch and reproduce
the same root rewrite. The flag has to live on the vuln.

- `mergeInstancesByOverrideKey`: when a group spans more than one distinct
  `declaredRange` **and** more than one distinct `parentPath`, mark the merged
  instance and clear `safeCandidates` / `bestSafeInRange`.
- Expose `pinConflict: true` on the vuln when any merged instance is marked.
- Guard **both** branches of `openOverride` (`App.js:218-223`) on
  `!vuln.pinConflict`. This is the part that actually prevents the bad write.
- `defaultOverrideSelection` returns `null` under `pinConflict` so the fixture
  harness can't drift from the app.
- `src/components/Row.js`: render a short reason so `o` isn't a silent no-op.
- Test in `test/unit/vulnerabilities.test.mjs`: divergent ranges across manifests
  offer no pin; identical ranges across manifests still merge and still offer one.

### B2. Truth up the comment and the README

- Rewrite the `collectPinInstances` comment to describe what the code now does.
- Document the divergence in the README's Workspaces section — the comment
  currently claims this and the README does not say it.
- `CLAUDE.md` requires deliberate yarn divergences to live in a "How closely does
  this match yarn?" README section that no longer exists.

  **Resolved as:** documented in the Workspaces section, `CLAUDE.md` left alone.
  That section was not lost by accident — it was deleted deliberately in 870d2e5
  ("docs: simplify README"), and 3ad1dd9 on this branch trimmed the Workspaces
  section in the same direction. Restoring it would undo that. `CLAUDE.md` still
  points at a section that does not exist and should be updated to name the
  section divergences actually live in; that is a one-line edit left for the
  repo owner, since it is an instruction file rather than code.

## Phase C — cleanup

### C1. Unify `isMonorepo`

`src/cli.js:143` computes `project.workspaces != null`; `buildDisplayRows`
(`src/components/rows.js:62`) computes it from the visible groups. A `workspaces`
field that expands to zero workspaces makes the CLI print a `root` heading and
indented output for a run whose TUI showed no workspace header. Use the
descriptor-based predicate in both.

### C2. Remove the NUL sentinel

`src/vulnerabilities.js:176-178` builds override keys with literal NUL bytes
(`'\0root'`, `` `${parentName}\0${parentVersion}` ``). These keys are
grouping-only — never persisted; written keys come from `writeOverrideSpec`'s
`${parentName}@${parentVersion}` — so swapping NUL for a character illegal in npm
package names (`#`) is unobservable. It stops git classifying the file as binary,
which today hides its diffs (`git diff` shows nothing without `--text`) and makes
`grep -r` skip it without saying so.

### C3. dep+devDep duplicate name

`src/package-file.js:292-298` collapses id-keyed selections to name-keyed ones
"a name is unique within a file", which is false when a package appears in both
`dependencies` and `devDependencies`. The new id keying makes the two rows
independently selectable while the writer applies one selection to both fields.

Fix: give `loadManifest` descriptors a `key` of `` `${field} ${name}` ``, have
`applyUpgrades` resolve `selections.get(d.key) ?? selections.get(d.name)`, and
key `applyProject`'s per-manifest map by `key`. Backward compatible with
name-keyed callers and tests.

Low value: needs a manifest npm itself treats as malformed, and on `main` both
rows already shared one name-keyed selection and both fields were written anyway
— so nothing regressed on the write path. Done anyway; it was four lines.

Left alone: `directField` in `applyUpgrades` has the same name-keyed ambiguity,
so an override routed to a package declared in both fields bumps whichever field
`loadManifest` saw last. Pre-existing, on the override path rather than the
selection path, and out of scope here.

## Deferred to a follow-up branch

Full per-workspace override routing, the real fix for Phase B: give manifest
edges distinct override keys by `parentPath`, carry `manifestPath` on scoped
pins, and have `applyProject` route a manifest-edge pin to *that workspace's*
manifest as a range bump instead of the root's `overrides`. This changes
`applyProject`'s contract and the scoped picker's rows. B1 makes the current
behavior safe in the meantime.

## Findings demoted or withdrawn by the adversarial pass

- **"Cross-workspace collapse is a regression"** — withdrawn as a regression.
  Pre-existing on `main`; the branch adds only a comment. Kept as Phase B.
- **"`applyProject` sends all overrides to the root"** — merged into Phase B; it
  is the same defect from the writer's side. The workspace-only-direct-dep half
  fails *loudly* at `npm install` (EOVERRIDE) rather than silently, and is
  correct whenever the pin satisfies the workspace's range — which is the
  documented, intended design.
- **"The new flags test blesses `--no-workspaces` + `-w`"** — withdrawn as
  evidence. That test asserts only that the parser treats the two flags
  orthogonally; it makes no claim about CLI behavior. The underlying gap is real
  and is A3.
- **dep+devDep duplicate name** — demoted to optional (C3), see above.

## Verification

`npm test` and `npm run test:integration` after each phase. Per `CLAUDE.md`,
re-read `README.md` before finishing: A2, A3 and B2 all touch it; C1, C2 and C3
are user-invisible and should be called out as such rather than silently skipped.

Order: A → B → C. A is the only genuine regression; B is the only part that can
silently write a wrong version.
