# Spike: which npm primitive re-resolves an unapplied override?

**Date:** 2026-08-26 · **npm** 11.13.0 · **Node** v24.16.0 · macOS
**Context:** field report `upgrade-interactive-stale-lockfile.md` (reporter: npm
11.9.0, Node 24, macOS, workspace monorepo)

The report describes an override that sits correctly in `package.json` while the
lockfile still holds the old version, and states that `npm install` will not
apply it. The fix needs a primitive that forces npm to revisit an edge it
considers already satisfied. This spike tested the candidates. **None of the
three planned candidates works.** The result changes the design.

## Fixture

Reproduces the reporter's shape with real registry packages:

```
jsdom@29.1.1    -> undici ^7.25.0 , installed 7.28.0
node-gyp@12.4.0 -> undici ^6.25.0 , installed 6.28.0   (collateral-damage check)
overrides: { "jsdom": { "undici": "<mandate>" } }
```

Built by installing with the override at one version, then editing it — which is
exactly how the state arises in the wild: an override added *after* its lockfile
entry was resolved. `lockfileVersion: 3`.

Where the mandate matters, the fixture uses a mandate that is **not** the newest
version in range (installed 7.28.0, mandate 7.27.0, newest-in-range 7.29.0). That
separates "honored the override" from "happened to upgrade".

## Finding 1 — the trigger is workspaces, not npm in general

The report's central claim is that `npm install` never retroactively applies the
override. That is **not true in general**. It is true in a workspace monorepo.

| Project shape | mandate flipped, then `npm install` |
|---|---|
| Standalone | ✅ applies it — verified both upward (7.28.0→7.29.0) and downward (7.26.0→7.27.0) |
| Workspace monorepo | ❌ reports `up to date`, silently leaves the old version |

Same manifests, same override, same npm. The only difference is
`workspaces: ["packages/*"]` with the dependency declared in a workspace package.

This matters for the tool: for standalone projects the existing `--install` step
is already sufficient, and any warning we emit must not tell those users to do
extra work. The defect is real but narrower than reported.

## Finding 2 — `npm update` and `npm audit fix` do not honor the override

Both appear to work, and both are a coincidence. Against the workspace fixture
with **mandate 7.27.0**, newest-in-range 7.29.0:

| Command | Result | Honored mandate? |
|---|---|---|
| `npm install` | 7.28.0 (unchanged) | ❌ |
| `npm update undici` | **7.29.0** | ❌ took newest-in-range |
| `npm audit fix` | **7.29.0** | ❌ took newest-in-range |

They upgrade; they do not resolve against `overrides`. With a mandate of 7.29.0 —
the ordinary security case, where you pin to the newest patched version — both
land on the right version and clear `npm audit`, which is why this reads as
success. Change the mandate to anything else and they install a version the
manifest does not sanction, leaving the override still unapplied.

A downgrade mandate (7.26.0, inside `^7.25.0`) is also ignored by both: each
moved *up* to 7.29.0.

**Control** — the override shape is valid and npm does honor it. A clean-slate
resolve with mandate 7.27.0 lands exactly 7.27.0. So this is npm declining to
re-resolve, not a malformed override.

## Finding 3 — pruning lockfile nodes corrupts a workspace tree

This was the reporter's own validated procedure and the fallback in my plan.
Against the workspace fixture it removes the package and never restores it:

| Variant | Result |
|---|---|
| prune nodes + `npm install` | **undici ABSENT** — `removed 2 packages`, 64→62 |
| prune nodes + `npm install --package-lock-only` (reporter's exact commands) | **undici ABSENT** — `up to date` |
| prune nodes + `rm -rf node_modules` + `npm install` | **undici ABSENT** |

`jsdom` still requires `undici`, so the tree is left inconsistent.

I could not reproduce the reporter's success with this procedure. The divergence
is unexplained — candidates are npm 11.9.0 vs 11.13.0, or a dependency on tree
size/shape that a two-package fixture doesn't capture. Recording it as
unexplained rather than asserting their procedure is universally broken.

## Finding 4 — only a full clean slate applies the mandate

| Primitive | Applies mandate? | Note |
|---|---|---|
| `npm install` | ❌ | `up to date` |
| `npm update <name>` | ❌ | newest-in-range |
| `npm audit fix` | ❌ | newest-in-range |
| `npm ci` | ❌ | lockfile-faithful by design |
| `rm package-lock.json` + `npm install` | ❌ | rebuilds the lockfile from `node_modules` on disk, preserving the stale version |
| prune + any install variant | ❌ | corrupts (Finding 3) |
| **`rm -rf node_modules package-lock.json` + `npm install`** | ✅ | the only one that works |

The `rm package-lock.json`-only result is worth keeping in mind: deleting the
lockfile alone is not a clean slate, because npm will reconstruct it from the
installed tree.

## Consequences for the design

1. **There is no targeted re-resolve.** The only working primitive re-resolves
   the *entire* tree. The tool cannot offer a surgical, one-package fix, and
   `f` on a single row cannot mean "fix just this".
2. **Drop the lockfile-editing plan entirely.** Pruning nodes is not merely
   risky, it produces a broken tree in the shape that triggers the bug.
3. **`npm update` / `npm audit fix` must not be offered as the fix.** They would
   appear to work in the common security case while silently installing a version
   other than the mandated one.
4. **Detection is worth more than the action.** Phase 1 of the plan — detect the
   unapplied state, never offer such an override for removal, and stop reporting
   an accepted-but-already-present pin as "no changes" — is unaffected by all of
   this and remains the right work.
5. **Scope the warning to workspaces.** Standalone projects self-heal on the next
   `npm install`.

Open design question for the action, given (1): offer nothing and explain, or
offer the full clean reinstall behind an explicit confirmation that says plainly
that it re-resolves every dependency.

## Reproducing

Fixtures and helper scripts under the session scratchpad
(`spike/ws-snap`, `spike/disc-snap`, `report.mjs`, `prune.mjs`, `run.sh`).
Rebuild from scratch: install the manifest above with one override version, edit
it to another, then run the candidate.
