# Field report: v2.2.0 on an Electron app (2026-10-17)

**Tool:** `upgrade-interactive` 2.2.0, `main` @ `04b53f3`. The npx cache the user ran
from (`npx /Users/pablo/Git/upgrade-interactive`) has `src/` identical to the clone, and so
does the registry tarball. · **npm** 11.13.0 · **Node** v24.16.0 · macOS (Darwin 24.6.0 arm64)

**Target project:** a standalone Electron 41 + Vue 3 app (no
workspaces). `electron-builder` 26 brings most of the transitive tree, including four
copies of `minimatch` and therefore four of `brace-expansion`.

**What the user reported, in their words:**

1. "Unused overrides after the first run. If I remove them, I get more vulnerabilities
   the second run." When asked, they confirmed they saw the extra vulnerabilities **in the
   tool's own list**, not in npm's `found N vulnerabilities` line.
2. "brace-expansion is reported as non-fixable, but there's a safe version" (second run).

> **Read "How this capture was made" first.** The capture was taken after the runs, not
> around them. Part of the sequence below is reconstructed, and finding F3 (the user's
> issue 1, second half) did **not** reproduce.

---

## How this capture was made

- `pre/` is the project's git `HEAD` (`f22c0b3`), from before the runs. `post/` is the
  working tree after them. Both were captured with `scripts/capture-run.sh` (`pre` against
  a copy of `HEAD`'s manifest and lockfile, `post` in the project), so `audit.json` on both
  sides comes from 2026-10-17 08:39Z, the same day as the runs.
- **There is no `session.txt`**, because the runs weren't `tee`'d. Instead, `frames/` holds
  re-renders of the real `App`, made with `ink-testing-library` against the live registry
  and the captured manifests (`tools/render-tui.mjs`). They show what the user would have
  seen, not their actual terminal.
- **The state between run 1 and run 2 could not be recovered.** `node_modules` already
  matched `post/`. It was rebuilt as `experiments/B`: the `post` manifest, plus the seven
  global pins at the tool's default (oldest safe) versions, plus `js-yaml`/`nanoid`,
  resolved from `pre`'s lockfile. Two facts support this reconstruction:
  - Five of those seven packages sit in `post/` at exactly the tool's default pin.
  - The other two (browserslist 4.29.3, baseline-browser-mapping 2.11.29) sit at the newest
    version in range, which fits npm re-resolving them once the pins were removed.
- The build passes after the upgrade: `build.log`, `npm run build`, exit 0, no warnings.

## 1. Outcome

| | pre | post |
|---|---|---|
| packages with a direct advisory (the tool's list) | 11 | 2 |
| `npm audit` total (includes metavulnerabilities — see F5) | 34 | 12 |
| build | — | exit 0 |

The two that remain:

- **`brace-expansion`** (high): two copies at 2.1.4. See F1.
- **`sprintf-js`** (moderate): every version is affected and none is fixed. The tool shows
  `1.1.3 → ?` here, which is correct.

**Sequence, as reconstructed:**

| | Tool's list | "Unused overrides" |
|---|---|---|
| Run 1 (`pre`, `frames/1-…`) | 11 rows | `js-yaml`, `nanoid` |
| Run 2 (`experiments/B`, `frames/2-…`) | 2 rows | 9: `js-yaml`, `nanoid` and the **seven run 1 had just written** |
| After removal (`post`, `frames/3-…`) | 2 rows (same ones) | none |

- **Run 1:** the user took in-range upgrades, global pins for seven packages, and scoped
  pins for `undici` (3) and `brace-expansion` (2 of 4 copies).
- **Run 2:** the user removed the unused overrides.

It's unknown whether `js-yaml`/`nanoid` were removed in run 1 or run 2. No finding depends
on it (experiments A and C).

---

## 2. Findings

### F1: `brace-expansion` has a working fix the tool can't reach (user issue 2) — verified

**The tree:**

| parent | declares | installed | safe in range |
|---|---|---|---|
| `minimatch@3.1.5` (×3 copies) | `^1.1.7` | 1.1.18 → 1.1.21 after run 1 | 1.1.21 |
| `minimatch@10.2.5` | `^5.0.5` | 5.0.9 → 5.0.12 after run 1 | 5.0.12 |
| `minimatch@9.0.9` (under `@electron/universal`) | `^2.0.2` | **2.1.4** | **2.1.7 only** |
| `minimatch@5.1.9` (under `filelist`) | `^2.0.1` | **2.1.4** | **2.1.7 only** |

On the 2.x line, GHSA-q2hr-2g5m-vwhr affects `>=2.0.0 <2.1.7`. That makes 2.1.7, the
newest 2.x, the only safe 2.x version.

**Run 1 showed a partial fix as a whole one.** The row said `brace-expansion 5.0.9 →
5.0.12` (one copy's numbers) and, once staged, `→ 2 scoped pins`. The two copies it left
behind were visible only inside the picker (`frames/1-run1-pre-state.txt`):

```
│ Pin brace-expansion per dependent:
│ ❯ minimatch@3.1.5 › 1.1.18 → 1.1.21
│   minimatch@10.2.5 › 5.0.9 → 5.0.12
│   minimatch@9.0.9 › 2.1.4 — npm would ignore a pin beside "minimatch@5.1.9", left as is
│   minimatch@5.1.9 › 2.1.4 — npm would ignore a pin beside "minimatch@9.0.9", left as is
```

**Run 2 blocks the row** (`frames/2-…`), and `o` does nothing:

```
  brace-expansion                              2.1.4 → 2.1.7
     ▲ high GHSA-6j4f-fj2g-mc7p … — affects >=2.0.0 <2.1.5   ⓘ npm would ignore a pin beside "minimatch@5.1.9" — edit overrides by hand
```

(The `affects` text contradicting `→ 2.1.7` is F7 of the 2026-08-11 report, not new.)

**The refusal itself is right.** Experiment F writes both keys to 2.1.7 and runs
`npm install --package-lock-only`. `filelist`'s copy stays on 2.1.4. That is
`docs/2026-10-11-spike-override-keys.md` Finding 2, row 3, reproduced on a real tree. With
2.1.7 the only safe target, no pair of non-overlapping pins exists.

**What works (experiment E):** delete both the `minimatch@9.0.9` and `minimatch@5.1.9` keys,
then run `npm update brace-expansion`.

- Both copies move to 2.1.7, and `brace-expansion` drops out of the audit.
- `package.json` loses 6 lines and gains no new override.
- It works because 2.1.7 satisfies both declared ranges. The existing pins are the only
  thing holding 2.1.4 in place, which is spike Finding 5 again.
- Deleting the keys alone isn't enough (experiment D): with an existing lock, npm keeps the
  locked 2.1.4 and reports `up to date`.
- In state D the tool still shows the identical note, naming `"minimatch@5.1.9"`, though no
  such key exists any more. The note reads as "an existing key is in the way". The conflict
  is really between the tool's own two proposed pins.

**Where the bad layout came from.** The project's commit `f4118af` (2026-08-27, "chore:
update deps") bumped both keys 2.1.2 → 2.1.4, giving them identical buckets. That is the
layout 2.2.0 now refuses to write. It fits a pre-2.2.0 run of this tool, but that isn't
verified. **2.2.0 never judges whether an existing object-valued override is still needed
or now harmful.** It does read them, but only to refuse new pins (`markPinRefusals`) and to
spot unapplied ones.

- The removability pass keeps only bare keys with string values
  (`src/vulnerabilities.js:603-609`). So a scoped pin that now pins a *vulnerable* version
  is neither flagged as the cause nor offered for removal.
- `unappliedOverrides` doesn't catch it either, because the pin *is* applied.

**Defect or artifact?** The defect is the tool's, not the project's, and its shape is
common: two copies of one parent whose child has a single shared safe version. That is spike
fixture B, and minimatch/brace-expansion is the textbook case. The gaps:

- (a) No route when every refused pin's target is inside its parent's declared range, which
  is exactly when "drop the pins + `npm update <pkg>`" works.
- (b) An existing scoped pin that is itself vulnerable is invisible as the cause.
- (c) The note names a key, not the two proposed pins, and it doesn't change after the user
  deletes that key.
- (d) A partial fix isn't shown on the row (`→ 2 scoped pins`, not "2 of 4 copies").

### F2: the tool writes overrides its next run calls unneeded (user issue 1, first half) — verified

Run 1 wrote global pins for seven packages. Run 2 lists all seven under **Unused
overrides**: "override X not needed (no longer prevents a known vulnerability)". Every pin
was inside every dependent's declared range, and the newest version in each range was
already safe:

| package | pre | pin written | dependents declare | in all ranges | newest in range |
|---|---|---|---|---|---|
| @xmldom/xmldom | 0.8.13 | 0.8.15 | `^0.8.8` | yes | 0.8.15 |
| baseline-browser-mapping | 2.10.37 | 2.11.0 | `^2.10.12` | yes | 2.11.29 |
| browserslist | 4.28.2 | 4.28.7 | `^4.24.0`, `>= 4.21.0` | yes | 4.29.3 |
| fast-uri | 3.1.5 | 3.1.8 | `^3.0.1` | yes | 3.1.8 |
| http-cache-semantics | 4.2.0 | 4.3.0 | `^4.0.0` | yes | 4.3.0 |
| postcss-selector-parser | 7.1.4 | 7.1.6 | `^7.1.4` | yes | 7.1.6 |
| source-map-js | 1.2.1 | 1.2.2 | `^1.2.1` | yes | 1.2.2 |

The removability rule ("the newest version in every declared range is safe",
`src/vulnerabilities.js:527-530`) was therefore already true **before** each pin was
written.

- The global path never asks that question. It pins the oldest safe version (F8 of the
  2026-08-11 report), even when a plain in-range update reaches a safe version with no
  override.
- So the verdict is right and the write is wrong. From the user's side, one run adds seven
  overrides and the next tells them to delete all seven.
- The older `js-yaml`/`nanoid` pins were also correctly called unneeded. Removing them from
  `pre` changes zero lockfile entries, and the tool's list stays the same (experiment A).

### F3: "removing them gives more vulnerabilities" — NOT reproduced

- Experiment B → C removes all nine "unused" pins and re-locks. The tool's list is identical
  before and after (`brace-expansion`, `sprintf-js`). The npm audit total is identical (12).
  The lockfile doesn't change.
- Experiment A (js-yaml/nanoid removed from `pre`) gives the same result.
- The real `post/`, taken after the removal, shows the same two rows as run 2.

Hypotheses, most likely first:

1. **The `brace-expansion` 2.x copies "came back".** Run 1 presented `brace-expansion` as
   fixed (`→ 2 scoped pins`, F1 d). On the next run it reappears with different numbers
   (`2.1.4 → 2.1.7`), next to a list of unused overrides the user was asked to remove. Seen
   that way, the list grew right after a removal. This fits every observation, and it is the
   only row that ever reappears. It is still an inference.
2. **A real `npm install` re-resolved differently from the lock-only replays.** `post/` has
   browserslist 4.29.3 and baseline-browser-mapping 2.11.29, where the lock-only replay kept
   4.28.7 and 2.11.0. So the real install did re-resolve edges after the removal.
   - The "redundant" rule assumes npm lands on the newest version in each declared range.
     npm can instead dedupe onto an existing copy that also satisfies the range, and that
     copy could be vulnerable.
   - This was not observed here (every final version is safe), and nothing in the capture
     shows it happened. It is a gap in the rule, not an explanation of this run.
3. **npm's own count (F5)** would explain it neatly, but the user ruled it out.

**What would settle it:** wrap the next such run in `capture-run.sh pre` / `nui | tee` /
`capture-run.sh post` and capture the moment the list grows.

### F4: the Latest column offers a downgrade when the `latest` dist-tag lags (incidental) — verified

`electron-builder`'s dist-tags are `latest: 26.15.3`, `v26: 26.17.0`, `next:
27.0.0-alpha.10`. Against `^26.17.0` the tool shows Latest `^26.15.3`:

```
  electron-builder                             ● ^26.17.0                        ○ ^26.15.3
```

In `post/`, `electron-builder` is listed **only** because of this downgrade, though the
README says packages with nothing new are left out. Bulk `l` would write `^26.15.3`. The
cause is in `src/semver-suggest.js:120-139`, which resolves `'latest'` and compares it only
for equality with the range and its resolution, never for being lower. Whether yarn does
the same wasn't checked. If keeping this is deliberate yarn parity, it belongs in the
README's Notes.

### F5: `npm audit` totals don't depend only on the lockfile (affects the capture method) — verified

- **The same `pre` lockfile, minutes apart:** the first reading was 21 (7 moderate, 14 high,
  `audit-drift/pre-audit-first-reading.json`). Every reading since has been 34 (7 moderate,
  27 high, `pre/audit.json`).
  - The direct-advisory set is the same 11 packages in both readings. The whole difference
    is in metavulnerabilities: packages flagged only through a vulnerable dependency.
  - The jump coincided with an `npm install --package-lock-only` warming the packument cache.
    That is inferred, not instrumented.
- **The same `post` lockfile, with and without the two `minimatch@…` keys in
  `package.json`:** 12 vs 9 (experiment D), stable across repeats.
  - `@electron/universal`, `filelist` and `minimatch` are flagged high via `brace-expansion`
    only while the keys are present.
  - The `electron-builder` chain goes from high to moderate.

**Consequences:**

- The `advisories: pre -> post` line in `capture-run.sh` uses `metadata.vulnerabilities`
  totals, so it can move without the tree changing.
- The "re-audit both lockfiles" step in CONTRIBUTING should compare **direct advisories**
  (`vulnerabilities[*].via` entries that are objects), not totals.
- The tool's own list uses the bulk advisory endpoint and isn't affected.

---

## 3. Suggested direction

These are leads for planning, not a spec. CONTRIBUTING's README-sync and test-first rules
apply to all of them.

- **F1 / F2 share a root.** An in-range fix needs no override. The audit already holds
  everything needed to see one:
  - each instance's `declaredRange`, `installedVersion` and `safeCandidates`;
  - for F1, the existing pin sitting on the edge.

  The route to offer is "drop the pin(s) on this edge + `npm update <pkg>`". F2 can be
  closed by taking that route instead of writing a global pin. F1 additionally needs:
  - existing object-valued overrides evaluated, at least "this pin's value is itself
    vulnerable";
  - the note reworded to name the two *proposed* pins;
  - the partial-fix count shown on the row.

  Mind how this interacts with F6 (2026-08-11): an out-of-range fix still needs an override.
- **F4** is a small, self-contained guard: drop or mark a Latest lower than the range
  resolution.
- **F5** changes the capture script's summary line and one CONTRIBUTING step. No code in
  `src/` is involved.
- **A fixture for F1 should be built with npm, not trimmed from this lockfile.**
  `pre/package-lock.json` (≈1,000 packages) is npm's own output. Trimming it would break the
  rule that a fixture lockfile is never hand-edited. Spike fixture B (`filelist@1.0.4 +
  glob@7.2.3 + rimraf@5.0.5`), resolved with two identical `minimatch@5.1.9` /
  `minimatch@9.0.9` brace-expansion pins and then left stale, is the same shape.

## 4. Method

1. **Found the user's runs.** Read `pre`/`post` manifests and lockfiles, and confirmed
   `node_modules/.package-lock.json` matched `post` (no intermediate state left).
2. **Never trusted a summary.**
   - Ran `computeVulnerabilities` directly: the same call `App.js` makes, with the CLI's
     `loadProject` / `manifestPathsOf` (`tools/probe.mjs`).
   - Rendered the real `App` for each state (`tools/render-tui.mjs`).
   - Each state's `probe.txt` holds the tool's verdicts.
3. **Re-audited everything, and repeated audits** when totals moved (F5). Compared direct
   advisories rather than totals.
4. **Ran counterfactuals** with `npm install --package-lock-only --ignore-scripts` (and
   `npm update brace-expansion --package-lock-only` for E). Each is in `experiments/` with
   its manifest, lockfile, `audit.json` and `probe.txt`:
   - **A:** `pre` minus `js-yaml`/`nanoid`, re-locked.
   - **B:** reconstructed run-1 result (see above).
   - **C:** B minus all nine "unused" pins, re-locked (the user's removal).
   - **D:** `post` minus both 2.x `minimatch@…` keys, re-locked (still 2.1.4).
   - **E:** D, then `npm update brace-expansion` (2.1.7 everywhere; fixed).
   - **F:** `post` with both 2.x keys set to 2.1.7, re-locked (one pin dropped).
5. **Checked every written pin against its dependents' declared ranges** (F2 table) and
   registry dist-tags (F4).
6. **Argued against each finding.**
   - F1's refusal was tested and holds. The gap is the missing route.
   - F2's verdict was tested and holds. The gap is the write.
   - F3 is reported as unreproduced rather than forced into F1/F5.

## 5. Limits

- **n = 1**, and the sequence is partly reconstructed (`experiments/B`). The exact
  selections in run 1 aren't known beyond what the manifests show.
- **The replays use `--package-lock-only`, not the real `npm install`.** `post/` shows the
  real install re-resolved some edges that the replays left alone (F3, hypothesis 2).
- **No original terminal output.** The frames are re-renders, and the analyst never saw the
  live TUI.
- Advisory data is from 2026-10-17 and will drift.
- npm 11.13.0 only. The F1 / experiment F behaviour is release-dependent (see the
  2026-10-11 spike).
- F3 is unresolved.

## 6. What's in the capture directory

The capture isn't committed. It lives in the `<project>-nui-run-20261017-0839/` directory
that `capture-run.sh` created next to the project's checkout, and every relative path in
this report (`pre/`, `frames/`, `experiments/`, `tools/`, …) is relative to it.

```
meta.txt                    capture-run.sh metadata + a hand-added note on how it was made
pre/  post/                 package.json, package-lock.json, audit.json, probe.txt
build.log                   npm run build on post (exit 0)
config/                     electron.vite / eslint / playwright / vitest configs, tsconfig.json
frames/                     re-rendered TUI: 1 = run 1 (with brace-expansion's picker open),
                            2 = run 2 (reconstructed), 3 = after removal (post)
audit-drift/                first audit readings of pre/post (pre read 21; see F5)
experiments/A…F/            counterfactual states (§4)
tools/probe.mjs             node tools/probe.mjs <tool-src-dir> <project-dir> [pkg…]
tools/render-tui.mjs        node tools/render-tui.mjs <tool-repo-dir> <project-dir> [pkg-to-open-with-o]
                            (needs the tool repo's devDependencies: ink-testing-library)
```

Both scripts import from the tool checkout you point them at, so they rerun against any
later version of `src/`. They need network access (registry and bulk advisory endpoint).
