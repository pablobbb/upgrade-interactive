# Fixture: unapplied-override-toplevel

The same unapplied state as `unapplied-override-scoped`, but with the pin
top-level (`overrides: { "brace-expansion": … }`) — the slot the tool itself
writes to. That is what makes this fixture cover the second half of the bug:
**accepting a fix that is already in the file**.

## Filenames

Stored as `manifest.json` / `lock.json` (not the canonical names), consistent
with the other fixtures. The runner restores the canonical names in a temp dir.

## The state

| | |
| --- | --- |
| `minimatch@3.1.5` declares | `brace-expansion: ^1.1.7` |
| Lockfile holds | `brace-expansion@1.1.11` — **vulnerable** |
| Manifest mandates | `brace-expansion@1.1.16` — safe |

## How it was built

As with the scoped fixture, npm produced the state: `npm install
--package-lock-only` on `glob@7.2.3` with the manifest pinning `brace-expansion`
to `1.1.11`, then the pin edited to `1.1.16` without re-resolving. See that
fixture's NOTES.md for the frozen snapshot's contents.

## Expected result

This is the reported bug end to end. The audit reads the installed `1.1.11`,
flags `brace-expansion` as vulnerable, and offers `1.1.16`. The user accepts.
The writer finds `1.1.16` **already** at `overrides["brace-expansion"]` and
correctly writes nothing — so the run stages a security fix and changes no file.

Before the fix that combination was reported as "no effective changes", which
reads as "you were already fine" to someone who is still vulnerable.

- `expected-overrides.json` — unchanged: the pin was already correct.
- `expected-already-present.json` — the pin the writer declined to rewrite,
  which is what lets the summary say so explicitly instead of reporting nothing.
- `expected-unapplied.json` — the finding that explains *why* nothing changed.
  `parentName` is `null` because a top-level pin has no scoping dependent.

The override is also not offered for removal; the test asserts that separately.
This fixture is the one that catches a regression there: its key is a string
pin, so it reaches the removability pass, where without the gate the tree's safe
fallback (`^1.1.7` → `1.1.16`) would read as `redundant`.
