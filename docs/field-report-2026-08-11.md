# Field report — v2.1.0 on a real Astro project (2026-08-11)

First real-world run of `upgrade-interactive` v2.1.0 (`main` @ `ddb9e98`) against a
project outside the test suite. This records what happened, what was verified, and
the prioritized follow-up work that came out of it.

**Target project:** `giovanepersempre` — a static Astro 5 site (`output: 'static'`;
no SSR adapter installed, only `@astrojs/mdx`, `@astrojs/rss`, `@astrojs/sitemap`),
`sharp` as a build-time devDependency for image optimization.

**Inputs analyzed:** `package.json` + `package-lock.json` before and after the run,
plus the tool's own on-screen output. Everything below was re-verified by running
`npm audit` against the actual lockfiles and by installing purpose-built trees — not
inferred from the tool's report.

> **Read §5 (Limits) before acting on any priority in this document.** This is one
> run against one project with an unusually favorable dependency topology. Several
> findings are ranked on evidence that section explicitly qualifies.

---

## 1. Outcome

The run worked. 16 advisories → 4, with every staged fix landing in the lockfile.

| | pre | post |
|---|---|---|
| critical | 1 | 0 |
| high | 11 | 2 |
| moderate | 3 | 0 |
| low | 1 | 2 |
| **total** | **16** | **4** |

All 5 direct-dependency range bumps and all 13 `overrides` entries resolved as
intended — including the split `picomatch` case (hoisted `4.0.2 → 4.0.5`, plus
`anymatch`'s nested `2.3.1 → 2.3.2`). No fix was mis-applied.

The 4 survivors were `astro` (high), `sharp` (high), `@astrojs/mdx` (low, reported
only because it depends on `astro`), and `esbuild` (low). All required major
upgrades of direct dependencies that the user deliberately chose not to take —
a scope decision, not a tool failure.

### 1.1 The counterfactual

Two trees were built and installed to find out whether zero was reachable that day:

| tree | overrides | audit |
|---|---|---|
| the actual run (astro 5, 13 overrides) | 13 | 4 |
| **A** — majors only, **no overrides block at all** | 0 | **0** |
| **B** — majors + the 13 overrides the run wrote | 13 | **0** |

With `astro ^7.2.1`, `@astrojs/mdx ^7.0.5`, `sharp ^0.35.3` and no `overrides`
whatsoever, npm resolves clean on its own — `picomatch 4.0.5`, `vite 8.2.1`,
`postcss 8.5.26`, `nanoid 3.3.18`, `fast-xml-parser 5.10.1`, `h3 1.15.11` — because
astro 7's own dependency ranges already require the patched versions. Every one of
the 13 overrides was load-bearing *only* for staying on astro 5.

**Do not over-generalize this.** Astro is a framework monolith that owns its whole
toolchain (vite, rollup, postcss, esbuild, picomatch, devalue, nanoid all arrive
through it), so this tree had effectively one real dependency. Upgrading it swept 13
transitive advisories. In a project with many unrelated direct dependencies, a single
major sweeps almost nothing and the equivalent analysis is far harder. The result is
real; its generality is unproven from one sample.

What it does establish: the tool has no concept of what a *set* of choices costs. It
evaluates each row independently. A user optimizing for a clean audit gets no signal
that one path needs 13 overrides and leaves 2 highs while another needs none.

### 1.2 What worked

Worth recording, since the rest of this document is failure-focused:

- **The two-version `picomatch` split.** `2.3.1` under `anymatch` and `4.0.2`
  hoisted, needing *different* safe targets under different parents, correctly
  produced scoped pins rather than one wrong global pin. This is the hardest case in
  the codebase and it was handled right.
- **Direct-dependency `EOVERRIDE` avoidance.** Pins for directly-declared packages
  were routed to range bumps instead of conflicting top-level overrides.
- **No incorrect writes.** Every version that reached `package.json` resolved to the
  intended version in the lockfile. The one defect (F1) is an *omission*, not a
  wrong value.

---

## 2. Findings

### F1 — A top-level pin silently clobbers a scoped pin on the same key

The summary printed both `vite › picomatch → 4.0.5` and `vite → 7.3.6`. Only the
second reached `package.json`. Key ordering proves the mechanism: `"vite": "7.3.6"`
sits between `tinyglobby` and `defu` — the slot where the picomatch scoped pass had
created `"vite": { "picomatch": "4.0.5" }`, which the later `vite` string pin
overwrote. The header row said `→ 6 scoped pins`; 5 landed.

Reproduced directly against the writer:

```
staged      : {picomatch: {scoped:[vite, fdir]}, vite: "7.3.6"}
summary says: [{picomatch→4.0.5 parent:vite}, {picomatch→4.0.5 parent:fdir}, {vite→7.3.6}]
file has    : {"vite":"7.3.6","fdir":{"picomatch":"4.0.5"}}
```

`pinTopLevel` assigns `root[name] = version` unconditionally
([src/package-file.js:212-217](../src/package-file.js#L212-L217)). The inverse case
already merges correctly via the `{'.': …}` form
([src/package-file.js:250](../src/package-file.js#L250)), so the failure is purely
order-dependent — and the audit's own display order (picomatch first, vite last) is
exactly the order that triggers it.

Benign here only by luck: picomatch 4.0.5 hoisted to the root anyway.

**This is the one finding fully independent of this project.** It is a code-level
defect reproduced in isolation; its severity does not rest on how often it fires.

### F2 — The summary can report overrides that are not in the file

Direct consequence of F1: the post-run summary is built from `appliedOverrides`
pushes rather than from the serialized result, so it describes intent, not outcome.

### F3 — No notion of what a *set* of choices costs (see §1.1)

The tool cannot answer "what is the cheapest set of changes that reaches zero
advisories?"

**Tractability caveat.** The full version — enumerate candidate combinations, resolve
each, audit each — is not an interactive operation. Each install in §1.1 took ~6
minutes, and npm's resolver cannot be cheaply simulated. The affordable
approximation is to group advisories by the `fixAvailable: {name, version,
isSemVerMajor}` that `npm audit` already returns per advisory; in the post-run audit
all four pointed at `astro`/`@astrojs/mdx`/`sharp`. That is close to re-surfacing
what `npm audit fix --force` knows, and is a considerably smaller feature than the
framing above suggests. Plan accordingly.

### F4 — When no fix can be offered, nothing explains why

`sharp` had no in-range safe candidate for either installed instance, so pressing `o`
correctly did nothing — and said nothing. The blocking constraint (astro 5 declares
`optionalDependencies: { sharp: "^0.34.0" }`, and no astro 5.x or 6.x release ever
widened it — `^0.34.0 || ^0.35.0` first appears in astro **7.0.4**) was already known
to the audit layer and never surfaced. Reconstructing it by hand took a registry
sweep and a build probe.

Worth recording for the eventual fix: the declared range is *not* the real
constraint. A probe with `astro@5.18.2` and a forced `sharp@0.35.3` ran Astro's own
image service successfully (webp/avif/jpeg all transformed; the removed `failOnError`
constructor option is ignored rather than rejected). The only behavior change is that
truncated/corrupt images now fail instead of being silently tolerated. So a scoped
override *is* a valid escape hatch here — the tool just has no way to say so.

This finding is cheap to act on and survived review unqualified.

### F5 — Selected columns are not checked against the advisory

`astro ● ^5.18.2` was rendered next to `fixed in 7.1.0` with nothing marking it as a
non-fix. The run ends on raw `npm install` output, so neither the residual count nor
its cause is stated.

### F5b — No post-install audit delta

The run silently *introduced* a low: `esbuild 0.25.5 → 0.27.7` arrived via the astro
bump and landed inside `>=0.27.3 <0.28.1`.

**Weak supporting evidence.** That advisory is Windows-only and dev-server-only —
unreachable for this project — and no delta can catch a bump that lands in an
advisory published *later*, which is the general case. Split out from F5 and ranked
lower because the underlying idea may be sound while this example does not carry it.

### F6 — Range validation applies on one code path but not the other

`safeCandidates` (scoped path) filters by each parent's `declaredRange`
([src/vulnerabilities.js:153-155](../src/vulnerabilities.js#L153-L155)).
`safeVersions` (global path) filters only by "not vulnerable, not a downgrade"
([src/vulnerabilities.js:450](../src/vulnerabilities.js#L450)).

Which path a package takes is decided by `decidePinStrategy` — one installed copy
means global. So whether a pin is validated against its dependents' declared ranges
depends on how many copies happen to be installed, a property the user cannot see.
That is how `vite: "7.3.6"` was written under astro's declared `vite: "^6.4.1"`.

**The resulting pin was tested and is fine.** A fixture reproducing the post-run
state (astro 5.18.2, the 13 overrides, vite forced to 7.3.6) with an `.astro` page,
an `.mdx` page and the sitemap integration builds cleanly:

```
BUILD EXIT=0
(no errors/warnings in build log)
dist/  index.html  post/  sitemap-0.xml  sitemap-index.xml
```

That fixture does not exercise `astro:assets`, content collections, view transitions,
client islands or custom vite plugins, and covers `build` but not `dev` — so it shows
this shape of site is unaffected, not that forcing vite 7 under astro 5 is safe in
general. The finding is the *invisible asymmetry*, not that this pin is dangerous.

Note the tension with F4: forcing out-of-range is sometimes exactly right. Any fix
must be a warning, never a block.

### F7 — The advisory line can contradict itself

```
picomatch    4.0.2 → 4.0.4
   ⚠ high GHSA-c2c7-rcm5-vvqj — affects <2.3.2   → 6 scoped pins
```

4.0.2 does not satisfy `<2.3.2`. `affectedRange` comes from a single `primary`
advisory (worst severity; ties keep the first —
[src/vulnerabilities.js:426-433](../src/vulnerabilities.js#L426-L433),
[:478](../src/vulnerabilities.js#L478)), while `firstPatched` derives from the set
safe against *all* matching advisories. picomatch had four equal-severity advisories
spanning `<2.3.2` and `>=4.0.0 <4.0.4`, so the row shows one advisory's range beside
another's fix. Same shape on `astro`: `affects <=5.15.6 · fixed in 7.1.0`.

**Cosmetic.** `firstPatched` — the actionable number — was correct throughout, and
the user reached correct decisions despite the bad range text.

### F8 — The two pickers default in opposite directions

Global defaults to the *oldest* safe version
([src/components/OverridePicker.js:32](../src/components/OverridePicker.js#L32), with
`safeVersions` sorted ascending); scoped defaults to the *newest*
([src/override-select.js:19-21](../src/override-select.js#L19-L21)). In this run the
user overrode the global default on all nine global pins.

**Conflicts with F6.** Changing the global default to "newest" makes an out-of-range
pin *more* likely, which is precisely F6's failure mode. Evidence is also one user in
one session. Blocked on F6 or dropped.

### F9 — Optional peer dependencies are treated as parents

`fdir@6.4.6` declares only `peerDependencies: { picomatch }` with
`peerDependenciesMeta.picomatch.optional`, and still received a scoped pin.
`RANGE_FIELDS` ([src/vulnerabilities.js:69](../src/vulnerabilities.js#L69)) includes
`peerDependencies` without consulting the meta.

**Fix direction unverified.** npm may well apply an `fdir > picomatch` override when
fdir resolves picomatch through hoisting, which is what happened here — so skipping
optional peer parents could under-fix a real edge. Verify before changing.

---

## 3. Plan

### P0 — Stop losing writes

1. **Make `pinTopLevel` merge instead of replace.** When `root[name]` is already an
   object, write `root[name]['.'] = version`; mirror of the existing string→object
   promotion. *(F1)*
   - Test (`test/unit/package-file.test.mjs`): stage a scoped child pin under parent
     `P` **and** a top-level pin on `P`, in **both** insertion orders, and assert
     identical output containing both.
   - README: no change (bug fix, restores documented behavior).

2. **Derive the summary from the serialized manifest, not from intent.** Or add a
   post-write assertion reconciling `appliedOverrides` against the final JSON. *(F2)*
   - Test: a writer-level case where a staged override is dropped must fail loudly
     rather than be reported as applied.

### P1 — Say what stands between the user and zero

3. **Explain the blocked path.** When `o` can offer nothing, say why — *"no in-range
   fix: astro declares ^0.34.0; safe versions start at 0.35.0"* — and note when
   forcing out-of-range would work. *(F4)*
   - Cheapest item here and the one that would have saved the most manual work.
   - README: **Controls** (what `o` does when it can do nothing).

4. **Mark columns that don't clear the advisory, and state the residual.** Compute
   per-column residual vulnerability and mark it; end the run with
   `16 → 4 (2 need a major)` rather than raw npm output. *(F5)*
   - README: **What it does**.

5. **Group advisories by their `fixAvailable` target.** The affordable form of F3:
   *"these 4 advisories are all fixed by astro ^7.2.1."* Do **not** promise a full
   combinatorial "cheapest path to zero" without first proving it can run at
   interactive speed. *(F3)*
   - Half the machinery exists: **Unused overrides** already detects an override that
     *has become* pointless.
   - README: **What it does**.

### P2 — Unsafe defaults and blind spots

6. **Make the global picker range-aware.** Mark candidates falling outside the
   dependents' declared ranges; `overrideInfo` already carries the ranges. Warn, do
   not block — F4 shows out-of-range is sometimes the right answer. *(F6)*
   - README: **Notes** — a forced out-of-range pin is a deliberate divergence from
     what npm would resolve and must be written down there, per `CLAUDE.md`.

7. **Post-install audit delta.** Re-audit after install and diff, so an introduced
   advisory is visible. *(F5b)* — validate against a project where the delta matters
   more than it did here.

### P3 — Cleanup

8. **Fix the self-contradicting advisory line.** Show the union of matching ranges,
   or select `primary` as the advisory that determines `firstPatched`. *(F7)*
   - Test: fixture with two disjoint equal-severity ranges; assert the rendered range
     covers the displayed `current`.
9. **Investigate `peerDependenciesMeta.*.optional` parents** — confirm npm's actual
   override behavior on a hoisted optional peer edge *before* changing anything. *(F9)*
10. **Unify picker defaults** — only after item 6 lands. *(F8)* — README: **Controls**.

### Suggested sequencing

- **PR 1:** items 1–2. Pure bug fix, fully unit-testable, no UI surface. The only
  work here justified independently of this project.
- **PR 2:** items 3–5. User-facing clarity; gather a second real-world run first if
  item 5's scope is contested.
- **PR 3:** items 6–7, then 8–10.

---

## 4. Method

Reproducible without the original machine:

1. `npm audit --json` against `pre/package-lock.json` and `post/package-lock.json` —
   establishes the 16 → 4 delta and attributes each survivor.
2. Lockfile inspection for resolved versions, duplicate copies, and dependent ranges
   (e.g. astro's `optionalDependencies.sharp`, which explains the pre-run
   `node_modules/astro/node_modules/sharp@0.33.5` nested copy).
3. Direct invocation of `applyUpgrades` with a hand-built override map — the F1
   repro.
4. Registry sweep over every astro 5/6/7 release to find where the `sharp` range
   widened (7.0.4).
5. Install probes: `astro@5.18.2` + forced `sharp@0.35.3` exercising Astro's image
   service; then trees **A** and **B** installed and audited.
6. Build probe: a minimal Astro 5 site carrying the run's exact `overrides` block,
   built with `astro build` to test whether the forced `vite@7.3.6` breaks anything.

---

## 5. Limits

- **n = 1.** One project, one framework, one user's choices. Every finding except F1
  is ranked partly on how it manifested here.
- **Favorable topology.** A framework monolith owning its whole toolchain is close to
  the best case for §1.1's result and close to the worst case for generalizing it.
- **No baseline of the user's real site.** All build testing used synthetic fixtures;
  the actual site was never built, before or after.
- **Advisory data is a moving target.** Every audit number here reflects the database
  on 2026-08-11/12 and will drift.
- **F9's fix direction is untested**, and **F5b's supporting example is unreachable**
  on this project. Both are recorded as leads, not conclusions.
