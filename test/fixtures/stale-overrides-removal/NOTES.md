# Fixture: stale-overrides-removal

Exercises the **removal** path (the `x` action): an existing `overrides` block
whose entries are no longer pulling their weight. The tool flags the removable
ones and, crucially, leaves the rest alone.

## Filenames

Stored as `manifest.json` / `lock.json` (not the canonical names), consistent
with the other fixtures. The runner restores the canonical names in a temp dir.

## The three overrides

The manifest pins three packages, one per outcome:

| Override | Outcome | Why |
| --- | --- | --- |
| `left-pad: 1.3.0` | **dead → removed** | Nothing in the installed tree depends on `left-pad` anymore. |
| `brace-expansion: 1.1.16` | **redundant → removed** | The tree (`minimatch@3.1.5` → `^1.1.7`) already resolves to `1.1.16`, which is non-vulnerable, so the pin does nothing. |
| `concat-map: 0.0.1` | **kept** | `concat-map` is in the tree (via `brace-expansion`), but the frozen snapshot has no metadata for it, so its fallback can't be verified. We never remove an override we can't prove is safe to drop. |

## How it was built

`npm install --package-lock-only` on `glob@7.2.3` produced a real lockfile where
`brace-expansion` resolves to the current safe `1.1.16` (no rollback here — the
point is that the tree is already fine). The `overrides` block was then authored
onto the manifest. `registry.snapshot.json` deliberately omits `concat-map` and
`left-pad` metadata so their outcomes are dead/kept rather than resolvable.

## Expected result

Only the dead and redundant pins are dropped; the unverifiable one survives:

```json
{ "concat-map": "0.0.1" }
```

`roundtrip.json` marks this **accepted**: npm installs cleanly with the trimmed
overrides.
