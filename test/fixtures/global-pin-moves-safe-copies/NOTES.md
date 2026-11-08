# Fixture: global-pin-moves-safe-copies

The `minimatch` case of the 2026-11-04 field report (F3), rebuilt with npm. A
package installed at two majors has a vulnerable copy with no fix in its own
range, and an older copy the advisory doesn't affect. `o` falls through to a
global pin, which moves the safe copy across majors along with the vulnerable one.

## Filenames

Stored as `manifest.json` / `lock.json` (not the canonical names), consistent
with the other fixtures. The runner restores the canonical names in a temp dir.

## The state

| Dependent | Declares | Lockfile holds |
| --- | --- | --- |
| `glob@7.2.3` (direct) | `minimatch: ^3.1.1` | `3.1.5`, safe |
| `glob@11.1.0` (under `rimraf@6.0.1`) | `minimatch: ^10.1.1` | `10.2.6`, vulnerable |

`GHSA-g3hv-75wg-m249` affects `>=7.0.0 <11.0.1`, so 10.x has no safe version and
3.1.5 is untouched by it. The strategy is `scoped`, since one copy is already
safe, but no vulnerable copy can be pinned in its range. So the default
selection falls through to the global picker's first version.

## How it was built

`npm install --package-lock-only --ignore-scripts --before=2026-10-01` on the
manifest here. The lockfile is npm's own output, not edited.

## Registry data

`registry.snapshot.json` freezes `minimatch`'s published versions and every one
of its advisories from the bulk endpoint, both read on 2026-11-05. Other packages
have no advisories in the snapshot.

## Expected result

The global pin is still written: the picker warns rather than refuses, so what
`o` writes is unchanged.

```json
{ "minimatch": "11.0.1" }
```

The test that matters is in `test/unit/override-select.test.mjs`. At 11.0.1, the
pin is outside the declared major of both dependents. `glob@7.2.3` is already
safe and would move too, and `"minimatch@>=7"` is the narrower key.
