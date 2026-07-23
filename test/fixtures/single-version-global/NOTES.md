# Fixture: single-version-global

The simplest override case: a **transitive** package installed at exactly one
version across the tree, so a single global pin (a plain version string) is the
right shape — no per-parent scoping needed.

## Filenames

Stored as `manifest.json` / `lock.json` (not `package.json` /
`package-lock.json`) so the deliberately-vulnerable lockfile doesn't trip
repo-wide scanners. The runner restores the canonical names in a temp dir.

## How it was built

`npm install --package-lock-only` on `glob@7.2.3` produced a real lockfile with a
single `brace-expansion` (under `minimatch@3.1.5`). That node was then rolled
back to **1.1.11** (real, published, still-vulnerable) to represent a stale
lockfile. `brace-expansion` is transitive here — the project only depends on
`glob` — so a top-level override is valid and npm accepts it.

## Expected result

One global pin to the newest safe in-range version:

```json
{ "brace-expansion": "1.1.16" }
```

`roundtrip.json` marks this **accepted**: `npm install --package-lock-only`
resolves cleanly with the override applied.
