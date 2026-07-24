# upgrade-interactive

Interactive dependency upgrader for npm projects (Ink/React TUI), inspired by
`yarn upgrade-interactive`, with vulnerability warnings and npm `overrides`
support. Source lives in `src/`, unit tests in `test/unit/` (`npm run
test:unit`), integration test via `npm run test:integration`. `npm test`
runs both.

## Keep the README in sync — every change

**Before finishing any change, re-read `README.md` and update it to match.**
This applies to every task, not just "feature work". Concretely:

- New/changed/removed behavior, flags, env vars (`NUI_*`), keybindings, or
  `package.json` config options → update the matching README section
  (**Flags**, **Controls**, **What it does**).
- Changes to version-suggestion logic (`src/semver-suggest.js`) or
  audit/override behavior → update **What it does** and the
  **How closely does this match yarn?** section, which documents deliberate
  divergences from yarn.
- The CLI `--help` text in `src/cli.js` and the README must never disagree —
  if you touch one, check the other.
- If a change genuinely has no user-visible effect (pure refactor,
  test-only), state that explicitly in your summary instead of silently
  skipping the README check.

Do not end a task with the README describing behavior the code no longer has.
