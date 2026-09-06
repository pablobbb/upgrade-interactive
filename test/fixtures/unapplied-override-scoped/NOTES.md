# Fixture: unapplied-override-scoped

Exercises **detection of an override npm never applied**, in its scoped form
(`overrides: { minimatch: { "brace-expansion": … } }`). The pin sits in the
manifest, but resolution happened before it was added, so the lockfile still
holds the old version and npm never revisits the edge.

## Filenames

Stored as `manifest.json` / `lock.json` (not the canonical names), consistent
with the other fixtures. The runner restores the canonical names in a temp dir.

## The state

| | |
| --- | --- |
| `minimatch@3.1.5` declares | `brace-expansion: ^1.1.7` |
| Lockfile holds | `brace-expansion@1.1.11` — **vulnerable** |
| Manifest mandates | `brace-expansion@1.1.16` — safe |

The mandate satisfies the declared range, so this is not an unsatisfiable pin:
it is simply one resolution never saw.

## How it was built

npm produced the unapplied state itself, the same way it arises in practice —
resolve *with* one pin, then change the pin without re-resolving:

1. `manifest.json` pinned `minimatch › brace-expansion` to the vulnerable
   `1.1.11`, and `npm install --package-lock-only` on `glob@7.2.3` honoured it.
   The lockfile is therefore genuinely npm's, with `1.1.11` legitimately
   resolved.
2. The pin was then edited to the safe `1.1.16` — the fix a user would apply on
   seeing the advisory — and the lockfile was left untouched.

That is the exact sequence behind the bug this fixture guards: the audit reads
the un-overridden `1.1.11`, flags it, and the user "accepts the fix" that is
already in the file.

`registry.snapshot.json` is the same frozen capture (2026-07-23) the
`stale-overrides-removal` fixture uses; it already covers `brace-expansion`,
`glob` and `minimatch`. In it `1.1.16` is the highest published `1.x` and the
`maintenance-v1` tag, and the advisories include one for `<1.1.16` — so `1.1.16`
is the safe pin and `1.1.11` is vulnerable under three separate advisories.

## Expected result

`expected-unapplied.json` records the finding, naming the dependent
(`minimatch@3.1.5`) alongside the mandated and installed versions.

The override is **not** offered for removal, which the test asserts separately.
Under the pre-fix logic it would have been read as `redundant` — without the
pin, `^1.1.7` resolves to the safe `1.1.16` — but that reasoning is unsound
here, because the versions it reads are what resolution produced while ignoring
the pin.

`expected-overrides.json` shows the top-level `brace-expansion` pin the tool
adds beside the existing scoped one: the scoped pin addresses
`overrides.minimatch`, the new one `overrides["brace-expansion"]`, so they
occupy different slots and both survive.
