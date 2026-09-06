# upgrade-interactive

Interactive dependency upgrader for npm projects (Ink/React TUI), inspired by
`yarn upgrade-interactive`, with vulnerability warnings and npm `overrides`
support. Source lives in `src/`, unit tests in `test/unit/` (`npm run test:unit`),
integration tests in `test/integration/` plus the TUI smoke test
`test/app.test.mjs` (`npm run test:integration`). `npm test` runs both.

`test/app.test.mjs` drives the real TUI, and parts of it hit the live registry.
Never gate an assertion on a fixed `wait(ms)` there — poll with `waitForFrame` /
`rowsLoaded`, and inject `loadSuggestions` / `runAudit` when the *ordering* of
those two is what's under test.

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

## Naming docs in `docs/`

`docs/` holds point-in-time records — spikes, field reports — each true of the
versions it measured and never revised afterwards. Name them
`YYYY-MM-DD-<kind>-<subject>.md`, date first, so the directory sorts into a
chronological log as they accumulate:

```
docs/2026-08-11-field-report.md
docs/2026-08-26-spike-reresolve.md
```

The date is when the work was *measured*, not when the file was last touched.
State the tool versions involved (`npm 11.13.0`) in the doc itself — a reader
needs both to know whether a finding still holds.

These docs are cited from code comments, the README and `CHANGELOG.md`, and
`CHANGELOG.md` ships in the npm tarball (`files`), so a published path cannot be
corrected. Renaming one means updating every reference in the same commit; check
with `grep -rn '<old-name>' --include='*.js' --include='*.mjs' --include='*.md' .`
and do it before tagging a release, never after.
