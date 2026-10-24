# Fixture: held-by-scoped-pins

The user's own overrides hold a vulnerable version in place, and the fix sits
inside every dependent's declared range. This is the `brace-expansion` case of the
2026-10-17 field report (F1), reproduced with npm rather than trimmed from that
project's lockfile.

## Filenames

Stored as `manifest.json` / `lock.json` (not the canonical names), consistent with
the other fixtures. The runner restores the canonical names in a temp dir.

## The state

| Dependent | Declares | Lockfile holds |
| --- | --- | --- |
| `minimatch@5.1.9` (under `filelist`) | `brace-expansion: ^2.0.1` | `2.1.4`, vulnerable |
| `minimatch@9.0.9` (under `rimraf` › `glob`) | `brace-expansion: ^2.0.2` | `2.1.4`, vulnerable |
| `minimatch@3.1.5` (under `glob`) | `brace-expansion: ^1.1.7` | `1.1.21`, safe |

The manifest pins both 2.x copies with keys whose buckets are identical:

```json
"minimatch@5.1.9": { "brace-expansion": "2.1.4" },
"minimatch@9.0.9": { "brace-expansion": "2.1.4" }
```

`2.1.7` is the only safe 2.x, and both declared ranges admit it.

## How it was built

`npm install --package-lock-only --ignore-scripts` on `manifest.json` as it
stands, overrides included, on npm 11.13.0 (Node v24.16.0), 2026-10-20. npm
resolved both 2.x copies to a single hoisted `brace-expansion@2.1.4`, so the
lockfile is npm's own output in one step.

`registry.snapshot.json` was captured on the same day. It holds metadata for
`brace-expansion`, `filelist`, `glob`, `minimatch` and `rimraf`, and the
`brace-expansion` advisories only, since that is the package under test.

## Expected result

- **No new pin.** The two pins the tool would propose both set `2.1.7`, and npm
  keeps only one of two identical `parent@version` pins
  (`docs/2026-10-11-spike-override-keys.md`, Finding 2). The row is blocked.
  `expected-overrides.json` is therefore the manifest's own overrides,
  unchanged.
- **Nothing removable, nothing unapplied.** Qualified keys are never offered for
  removal, and both pins are in effect.
- **The note names the cause and the way out:** both keys as `heldBy`,
  `inRangeFix` true, and `remove those pins, then run npm update
  brace-expansion`. `test/unit/override-safety.test.mjs` asserts this.

## What npm does with it

Measured on npm 10.9.9 and 11.13.0:

| Step | Both 2.x copies |
| --- | --- |
| Remove both keys, then `npm update brace-expansion` | `2.1.7` |
| Keep the keys, `npm update brace-expansion` | stay on `2.1.4` |
| Remove both keys, `npm install` | stay on `2.1.4` (`up to date`) |

`test/integration/override-safety.test.mjs` replays the first two rows, which are
why the note asks for both steps.
