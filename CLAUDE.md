# upgrade-interactive

Interactive dependency upgrader for npm projects (Ink/React TUI), inspired by
`yarn upgrade-interactive`, with vulnerability warnings and npm `overrides`
support. Source lives in `src/`, unit tests in `test/unit/` (`npm test`),
integration tests in `test/integration/` plus the TUI smoke test
`test/app.test.mjs` (`npm run test:integration`).

## Keep the README in sync — every change

**Before finishing any change, re-read `README.md` and update it to match.**
This applies to every task, not just "feature work". Concretely:

- New/changed/removed behavior, flags, env vars (`NUI_*`), keybindings, or
  `package.json` config options → update the matching README section
  (**Flags**, **Controls**, **What it does**).
- Changes to version-suggestion logic (`src/semver-suggest.js`) or
  audit/override behavior → update **What it does**.
- Deliberate divergences — from yarn, or from what npm itself would do — must be
  written down, not left in a code comment: workspace-specific ones in
  **Workspaces**, everything else in **Notes**. A comment claiming "documented in
  the README" is a bug if the README doesn't say it.
- The CLI `--help` text in `src/cli.js` and the README must never disagree —
  if you touch one, check the other.
- If a change genuinely has no user-visible effect (pure refactor,
  test-only), state that explicitly in your summary instead of silently
  skipping the README check.

Do not end a task with the README describing behavior the code no longer has.
