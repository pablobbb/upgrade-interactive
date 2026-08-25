# Contributing

Thanks for helping out. This is a small project; the sections below cover the
few things that are easy to get wrong.

## Getting set up

```sh
npm ci
npm test              # unit + integration
npm run test:unit     # test/unit/*.test.mjs
npm run test:integration
```

CI runs `npm test` on Node 18, 20, 22 and 24. The package declares
`engines.node >= 18`, so don't reach for syntax or APIs newer than that.

## Keep the README in sync — every change

This is the project's one hard rule, and it is not limited to feature work. See
[CLAUDE.md](CLAUDE.md) for the full statement. In short:

- New/changed/removed behavior, flags, env vars (`NUI_*`), keybindings, or
  `package.json` config options → update the matching README section
  (**Flags**, **Controls**, **What it does**).
- The CLI `--help` text in `src/cli.js` and the README must never disagree.
- Deliberate divergences — from yarn, or from what npm itself would do — go in
  the README (**Workspaces** or **Notes**), not in a code comment. A comment
  claiming "documented in the README" is a bug if the README doesn't say it.
- If a change genuinely has no user-visible effect, say so explicitly in the PR
  description rather than skipping the check silently.

## Tests

Unit tests are the default. `test/app.test.mjs` drives the real TUI and parts of
it hit the live registry — **never gate an assertion there on a fixed
`wait(ms)`**. Poll with `waitForFrame` / `rowsLoaded`, and inject
`loadSuggestions` / `runAudit` when the *ordering* of those two is what's under
test.

When fixing a bug in the manifest writer, test **both insertion orders**. A
scoped pin and a top-level pin on the same package are written by separate
passes, and a shipped release lost one to the other because no test ever staged
the two together in both directions.

## Real-world runs

The test suite covers synthetic trees. It does not cover what npm actually does
with a real dependency graph, and the gap between those two is where the
interesting bugs live.

`scripts/capture-run.sh` snapshots a run against a real project. Run it **from
the target project**, not from this repo:

```sh
/path/to/capture-run.sh pre                        # before the run
nui | tee /tmp/nui-session.txt                     # run the tool, keep its output
/path/to/capture-run.sh post --session /tmp/nui-session.txt
```

It produces one directory containing `package.json` + `package-lock.json` +
`npm audit --json` for both sides, the tool's own output, the post-upgrade build
log, and a `meta.txt` with tool/node/npm versions.

The `audit.json` on each side is the artifact that matters most: advisory
databases drift, so re-auditing a lockfile weeks later does **not** reproduce
what the tool saw at the time.

### Analyzing one

Write down your method and your limits alongside the findings — a capture is
only worth as much as the reader's ability to tell a defect from an artifact of
one project's dependency graph. The method in brief:

1. **Never trust the tool's own summary.** Diff it against the written
   `package.json` and the resulting lockfile. That discrepancy is how the
   writer's one known write-loss bug was found; an analysis that starts from the
   summary cannot see it.
2. Re-audit both lockfiles rather than trusting reported counts.
3. Look for advisories the run *introduced*, not only ones it fixed.
4. Check every written override against its dependents' declared ranges, to
   catch forced majors.
5. When advisories remain, build the counterfactual tree — what would a
   different set of choices have cost?
6. Then argue against yourself: for each finding, is it a defect, or an artifact
   of that project's dependency topology? One run is one sample.

Record findings as a dated report under `docs/`. Don't treat a previous report's
findings as a checklist — that biases the next run toward confirming them
instead of finding what's actually there.

## Releasing

The first real-world run found a silent write-loss bug that had already shipped
in v2.1.0, because no unit test staged the two override kinds together. Field
runs catch a class of bug the suite structurally can't, so:

- [ ] `npm test` green on the CI matrix
- [ ] README, `src/cli.js --help`, and actual behavior all agree
- [ ] `CHANGELOG.md` updated
- [ ] **One capture run against a real project**, with `audit.json` inspected on
      both sides and the post-upgrade build passing
- [ ] Anything surprising from that run either fixed, or written down in `docs/`
      before tagging
- [ ] Version bumped, tagged, published

## Pull requests

Branch names use conventional prefixes: `feature/*`, `bugfix/*`, `hotfix/*`,
`chore/*`, `refactor/*`.

Keep PRs to one concern. If a change alters what the tool writes to
`package.json`, say so explicitly in the description — that is the surface where
mistakes are silent and permanent.
