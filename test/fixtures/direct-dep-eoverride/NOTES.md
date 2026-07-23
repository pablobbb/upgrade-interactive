# Fixture: direct-dep-eoverride  (documents a known bug)

This fixture captures a **bug**: when a vulnerable package is also a *direct*
dependency, the tool writes a top-level `overrides` entry that conflicts with the
`dependencies` spec, and npm rejects the install with `EOVERRIDE`.

npm's rule: "You may not set an override for a package that you directly depend
on unless both the dependency and the override itself share the exact same spec."

## Filenames

Stored as `manifest.json` / `lock.json` (not the canonical names) so the
deliberately-vulnerable lockfile doesn't trip repo-wide scanners. The runner
restores the canonical names in a temp dir.

## How it was built

`npm install --package-lock-only` on a project that depends **directly** on
`brace-expansion@^1.1.0`, with the installed `brace-expansion` node rolled back
to the still-vulnerable **1.1.11**.

## Current (incorrect) behavior

`expected-overrides.json` records what the tool writes *today*:

```json
{ "brace-expansion": "1.1.16" }
```

Because `brace-expansion` is a direct dependency at `^1.1.0`, this top-level pin
conflicts, so `roundtrip.json` marks the round-trip **rejected** with code
`EOVERRIDE`. The offline runner asserts the (wrong) output we currently produce;
the round-trip runner asserts npm refuses it. Together they pin the bug down.

## When the direct-dep path is fixed

The correct behavior is to bump the dependency range instead of writing a
conflicting override (or use npm's `$name` reference). At that point:

- update `expected-overrides.json` to the corrected output (likely empty, with
  the fix expressed as a `dependencies` range bump), and
- flip `roundtrip.json` to `{ "expect": "accepted" }`.
