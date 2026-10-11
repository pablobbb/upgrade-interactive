# Spike: how npm treats several `overrides` keys for one parent package

**Date:** 2026-10-11 (single-version runs on npm 11.13.0 began 2026-10-10)
· **npm** 9.9.4, 10.9.9, 11.0.0–11.12.0 (bisect), 11.13.0, 11.21.0, 12.2.0
· **Node** v24.16.0 for every npm · macOS
**Context:** scoped pins on `bugfix/override-safety`, which key a pin under a
specific copy of its parent (`"minimatch@3.1.5": { "brace-expansion": … }`)
when the parent is installed at several versions.

The tool's override rules had been derived on npm 11.13.0 alone. Re-running
the same scenarios across npm releases shows that **npm's handling of several
keys for one parent changed twice inside npm 11**, and that two further
behaviours — `EOVERRIDE`, and a key pinning the parent itself — hold on every
release tested. It also shows that the fixes the scoped pins deliver are
available without any override.

## Fixture

Real registry packages, resolved with
`npm install --package-lock-only --ignore-scripts`. Outcomes are read from the
lockfile through node's lookup (each copy's dependency, wherever npm placed
it), never from fixed paths: npm releases nest the same tree differently.

```
A: glob@7.2.3 + rimraf@5.0.5           -> glob@7.2.3 (root) and glob@10.5.0 (under rimraf)
B: filelist@1.0.4 + glob@7.2.3 + rimraf@5.0.5
                                        -> minimatch at 3.1.5, 5.1.9 and 9.0.9
C: minimatch@3.0.4 + glob@7.1.6        -> glob declares minimatch ^3.0.4
```

Pins use versions that are *not* the newest in range wherever possible
(`inflight` 1.0.5 against a natural 1.0.6, `minimatch` 3.1.3 against 3.1.5), so
"npm honoured the override" can't be mistaken for "npm happened to upgrade".
Scenarios marked *stale lock* first build a lockfile with temporary overrides,
then remove them, as happens in the wild.

## Finding 1 — a bare key and a qualified key for one parent don't combine

Fixture A, fresh resolve.

| Overrides | 9.9.4 / 10.9.9 | 11.13.0 / 11.21.0 / 12.2.0 |
|---|---|---|
| `glob: {inflight}` then `glob@7.2.3: {minimatch}` | qualified key ignored | qualified key ignored |
| `glob@7.2.3: {inflight, minimatch}` then `glob: {inflight}` | both applied | **neither** applied |

npm never picks "the more specific" key. A key written after an existing bare
key — the order the tool would produce — is ignored on every release tested.

## Finding 2 — two `parent@version` keys: three regimes

Fixture A, fresh resolve, keys `glob@7.2.3` and `glob@10.5.0`. "Dropped" means
glob@7.2.3's pin did not apply; glob@10.5.0's applied in every row.

| The two keys pin… | 9.9.4 – 11.1.0 | 11.2.0 – 11.11.1 | 11.12.0 – 12.2.0 |
|---|---|---|---|
| different packages (`inflight` / `minimatch`) | applied | applied | **dropped** |
| one package, different versions (`3.1.3` / `9.0.5`) | **dropped** | applied | applied |
| one package, the same version (`3.1.3` / `3.1.3`) | applied (9.9.4, 10.9.9) | not measured | **dropped** (11.13.0+) |

Flip points found by bisecting the first two rows: 11.1.0 → 11.2.0 and
11.11.1 → 11.12.0. Measured points: 9.9.4, 10.9.9, 11.0.0, 11.1.0, 11.2.0,
11.3.0, 11.5.0, 11.6.0, 11.10.0, 11.11.0, 11.11.1, 11.12.0, 11.13.0, 11.21.0,
12.2.0.

In fixture A the parent (`glob`) is also a root dependency. The tool's usual
shape — a transitive parent, keys pinning different versions (the
`stale-transitive-minimatch` fixture's `minimatch@3.1.5` / `minimatch@9.0.9`) —
applied both pins on 9.9.4, 10.9.9 and 11.21.0 alike.

Not instrumented, but consistent with the 11.12+ column: arborist's
`OverrideSet.findSpecificOverrideSet` falls back to the common ancestor (the
root set) when two sibling sets have no conflicting rule, and
`Node.updateOverridesEdgeInRemoved` doesn't undo it once the edge that caused
it moves on.

## Finding 3 — `EOVERRIDE` against a root dependency's range (every release)

Fixture A with the root declaring `glob: "^7.2.0"`:

| Overrides | 9.9.4 – 12.2.0 |
|---|---|
| `glob@7.2.3: {minimatch}` | fails: `EOVERRIDE` |
| `glob@7.2.3: {".": "^7.2.0", minimatch}` | installs, pin applied |

With the root declaring exactly `7.2.3`, the plain key installs. A
`"glob@7.2.3 || 10.5.0"` key failed even then (11.13.0).

## Finding 4 — a key also pins the parent, and matches by declared range

A key without a `"."` value pins the parent itself to the key's selector, for
every dependency the key matches — and npm matches it against the range each
dependent *declares*, not the version it resolved to.

Fixture `glob@7.1.6` alone (declares `minimatch ^3.0.4`, natural 3.1.5), fresh
resolve, override `{"<key>": {"brace-expansion": "1.1.13"}}`:

| Key | 9.9.4 – 12.2.0 |
|---|---|
| `minimatch@3.1.5` (the installed version) | minimatch 3.1.5, brace-expansion 1.1.13 |
| `minimatch@3.0.4` | minimatch **downgraded to 3.0.4**, brace-expansion 1.1.13 |

With an existing lockfile npm keeps the copies it has, which hides this; a
fresh resolve applies it.

Fixture C, stale lock (root `minimatch@3.0.4` on a vulnerable
`brace-expansion` 1.1.11; glob's own `minimatch@3.1.2` on 1.1.21), override
`{"minimatch@3.0.4": {"brace-expansion": "1.1.12"}}`: glob's copy was moved to
1.1.12 too — a downgrade — on 11.13.0, 11.21.0 and 12.2.0. On 9.9.4 and 10.9.9
the stale lock itself couldn't be built this way (npm merged the two
`brace-expansion` nodes), so this is unmeasured there.

**One key for two versions.** Fixture B, `"minimatch@5.1.9 || 9.0.9":
{"brace-expansion": …}`:

| | 9.9.4 / 10.9.9 | 11.13.0 / 11.21.0 / 12.2.0 |
|---|---|---|
| stale lock | neither copy pinned (10.9.9) | both pinned (11.13.0) |
| fresh resolve | neither copy pinned | 5.x not pinned: the 11.13.0 lockfile shows `filelist` (declares `^5.0.1`) **moved onto minimatch@9.0.9** |

## Finding 5 — `npm update <pkg>` delivers in-range fixes without any override

Every scoped pin the tool writes targets a version inside its parent's
declared range. `npm update <pkg> --package-lock-only`, no overrides, stale
locks:

| Fixture | 10.9.9 / 11.13.0 / 12.2.0 |
|---|---|
| `stale-transitive-minimatch` (brace-expansion 1.1.11 and 2.0.2) | 1.1.21 and 2.1.7 |
| A with minimatch 3.1.1 under glob@7.2.3 | 3.1.5 under glob@7, 9.0.9 under glob@10 kept |

`package.json` was unchanged in every run. Each copy moved to the newest version
in its own range, already-safe copies included.

## Consequences for the design

- The scoped-pin rules (`src/override-keys.js`) were fitted to npm 11.13. The
  refusals they add are conservative on older npm: a layout refused because
  11.12+ drops it still applies on 9.9–11.11, but a lockfile may be regenerated
  by any npm, so refusing stays the safe choice.
- Two gaps remain unguarded: keys pinning different versions for a parent the
  root also declares, which npm 11.1 and earlier half-apply (Finding 2, row 2);
  and the parent pinning on a fresh resolve (Finding 4), which every
  `parent@version` key the tool has written since 2.2.0 carries.
- The shared `||` key was reverted (Finding 4).
- Real-npm tests run the claims above only on the releases they were measured
  on; the tool's own refusals are asserted on every release.
- Finding 5 suggests in-range fixes need no override at all; overrides would
  then be needed only for fixes outside a dependent's declared range.

## Reproducing

The scenarios are small `package.json` files; for example, Finding 2 row 1:

```json
{
  "dependencies": { "glob": "7.2.3", "rimraf": "5.0.5" },
  "overrides": { "glob@7.2.3": { "inflight": "1.0.5" }, "glob@10.5.0": { "minimatch": "9.0.5" } }
}
```

```
npm install --package-lock-only --ignore-scripts
npm ls inflight --package-lock-only     # 1.0.6 on npm 11.12+: the pin was dropped
```

To run another npm release without replacing the system one:
`npm install npm@<version>` into a scratch directory and invoke
`node <dir>/node_modules/npm/bin/npm-cli.js`. Under asdf, call the Node binary
directly: the `node` shim puts its own `npm` back at the front of `PATH` for
child processes.
