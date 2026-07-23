# Fixture: direct-dep-range-bump

When a vulnerable package is **also a direct dependency**, it must *not* get a
top-level `overrides` entry. npm's rule: "You may not set an override for a
package that you directly depend on unless both the dependency and the override
itself share the exact same spec" — otherwise it aborts with `EOVERRIDE`,
"conflicts with direct dependency". So the fix has to land as a **dependency
range bump** instead.

(This fixture previously documented the bug where the tool wrote the conflicting
override; it now verifies the corrected behavior.)

## Filenames

Stored as `manifest.json` / `lock.json` (not the canonical names) so the
deliberately-vulnerable lockfile doesn't trip repo-wide scanners. The runner
restores the canonical names in a temp dir.

## How it was built

`npm install --package-lock-only` on a project that depends **directly** on
`brace-expansion@^1.1.0`, with the installed `brace-expansion` node rolled back
to the still-vulnerable **1.1.11**.

## Expected result

No override is written; the direct dependency's range is bumped to the safe
version:

- `expected-overrides.json` → `{}` (no overrides block)
- `expected-dependencies.json` → `{ "brace-expansion": "1.1.16" }`

`roundtrip.json` marks this **accepted**: with the range bumped (and no
conflicting override), `npm install --package-lock-only` resolves cleanly.
