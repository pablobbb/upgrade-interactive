# Fixture: stale-transitive-minimatch

A real-world scenario: a project (`acme-web`) whose `package-lock.json` predates
security fixes for `brace-expansion`, so the pinned transitive versions are still
vulnerable. This exercises the **per-dependent scoped override** path with
`parent@version` keys — the case where the same transitive package sits under two
different versions of the same parent and each copy needs a *different* fix.

## Filenames

The manifest and lockfile are stored as `manifest.json` and `lock.json`, **not**
`package.json` / `package-lock.json`. Because this fixture deliberately pins
vulnerable versions, canonical names would trip repo-wide scanners (GitHub
Dependabot security alerts, `npm audit`, IDE npm tooling) with false positives.
The fixture runner copies them to the canonical names inside a throwaway temp
directory before loading, so the loaders still see real filenames.

## How it was built

1. `npm install --package-lock-only` on the manifest here (`glob@7.2.3` +
   `rimraf@5.0.5`) produced a genuine npm v3 lockfile. That tree hoists
   `minimatch@3.1.5` (from glob) and nests `minimatch@9.0.9` (from rimraf), each
   pulling its own `brace-expansion`.
2. The two `brace-expansion` nodes were then rolled back to real, published,
   still-vulnerable versions to represent a lockfile frozen before the fixes:
   - `node_modules/brace-expansion` → **1.1.11** (needed by `minimatch@3.1.5`,
     which declares `brace-expansion@^1.1.7`)
   - `node_modules/rimraf/node_modules/brace-expansion` → **2.0.2** (needed by
     `minimatch@9.0.9`, which declares `brace-expansion@^2.0.2`)

   Their `resolved`/`integrity` fields were dropped since the tarball hashes no
   longer match the pinned-back versions (npm would refetch on a real install).

## Registry data

`registry.snapshot.json` freezes the real npm metadata (published version lists)
and the real GitHub advisories for `brace-expansion` (GHSA-v6h2-p8h4-qcjw,
GHSA-f886-m6hf-6m8v, GHSA-3jxr-9vmj-r5cp) so the test runs offline and
deterministically. The high-severity GHSA-3jxr advisory covers `<1.1.16` and
`>=2.0.0 <2.1.2`, which is why the only safe in-range fixes are the versions in
`expected-overrides.json`.

## Expected result

Each vulnerable copy is pinned under its own parent, keyed by `parent@version`
because `minimatch` appears at two versions needing different targets:

```json
{
  "minimatch@3.1.5": { "brace-expansion": "1.1.16" },
  "minimatch@9.0.9": { "brace-expansion": "2.1.2" }
}
```
