# npm-upgrade-interactive

A clone of `yarn upgrade-interactive` (the Yarn Berry / Yarn 4 version, built into
Yarn since v4) for npm projects. It was built by reading Yarn's actual source
(`@yarnpkg/plugin-interactive-tools`) rather than guessing at the UI, so the
keybindings, columns, and version-suggestion logic mirror it closely.

## Install / run

```sh
npx npm-upgrade-interactive
# or, once published/linked:
npm install -g npm-upgrade-interactive
nui
```

Requires Node 18+ and an interactive terminal.

### Using it inside a project (`npm run`)

npm has no plugin system for adding real subcommands the way yarn does, so
`npm upgrade-interactive` (no `run`) isn't possible. The closest equivalent,
and the standard way to wire up any custom npm command, is a script entry:

```json
"scripts": {
  "upgrade-interactive": "npm-upgrade-interactive"
}
```

Then `npm run upgrade-interactive` works from that project, every time.

## What it does

1. Reads `dependencies` and `devDependencies` from `package.json`.
2. For each package, looks up two candidate upgrades from the npm registry:
   - **Range** — the highest version that still satisfies your current
     semver range (what `npm outdated` calls "Wanted").
   - **Latest** — the version tagged `latest` on the registry, even if it's
     outside your current range (a major bump, for example).
   Both are re-formatted using your existing range modifier (`^`, `~`, or
   exact), and packages with nothing new to offer are left out of the list
   entirely — same as yarn.
3. Lets you pick, per package, whether to stay on **Current**, take the
   **Range** upgrade, or take the **Latest** upgrade.
4. Writes your choices back into `package.json` and runs `npm install`.

## Controls

| Key                | Action                                              |
| ------------------ | ---------------------------------------------------- |
| `↑` / `↓`          | Move between packages                                |
| `←` / `→`          | Move between Current / Range / Latest for that package |
| `c` / `r` / `l`     | Select **c**urrent / **r**ange / **l**atest for *every* package at once |
| `Enter`            | Apply the selected upgrades and run `npm install`     |
| `Ctrl+C` / `Esc`   | Abort — nothing is written                            |

Version numbers are colorized by the size of the bump (yellow-ish for
minor, red for major), with only the part of the version that actually
changed highlighted — same idea as yarn's diff highlighting.

## Flags

- `--no-install` — update `package.json` only, skip the `npm install` step
- `-h, --help`, `-v, --version`

## How closely does this match yarn?

Matched exactly:
- The three-column Current/Range/Latest layout and the help text wording
- The up/down/left/right navigation model (selection = which column is
  highlighted per row, not a separate checkbox)
- The `c`/`r`/`l` bulk-select shortcuts, including `l`'s fallback to the
  Range value when a package has no separate Latest suggestion
- Packages with no available upgrade never appear in the list
- The version-diff coloring algorithm (segment-by-segment: modifier → major
  → minor → patch)

Intentional differences:
- Only plain semver ranges are resolved (git/file/link/workspace ranges,
  and compound ranges like `>=1.0.0 <2.0.0`, are skipped — yarn handles
  these through its pluggable resolvers, which is out of scope here).
- Only `dependencies`/`devDependencies` are scanned (matches yarn's own
  scope for this command — it skips `peerDependencies`/`optionalDependencies` too).
- The list stays alphabetically sorted the whole time it's loading. Yarn's
  actual implementation fills rows in whatever order each network request
  finishes, which can make rows jump around while loading — this clone
  avoids that instead of reproducing it.
- No monorepo/workspace support (single `package.json` only).

## Project layout

```
src/
  cli.js                 entry point, arg parsing, apply + npm install
  registry.js             npm registry client
  semver-suggest.js       Current/Range/Latest suggestion + diff coloring
  package-file.js          package.json read/write
  components/
    App.js                 state machine + keybindings
    Header.js, Prompt.js, Row.js   presentation
test/
  app.test.mjs            simulated-keypress smoke tests (ink-testing-library)
```
