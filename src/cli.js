#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { App } from './components/App.js';
import { loadProject, applyProject } from './package-file.js';
import { resolveToggles, parseWorkspaceOptions } from './flags.js';
import { formatSummary, formatIgnoredConfigNote, isMonorepoProject, manifestPathsOf } from './summary.js';

const e = React.createElement;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
upgrade-interactive (nui)

An interactive dependency upgrader for npm projects, inspired by yarn's
"upgrade-interactive" (Yarn Berry / Yarn 4).

Usage
  $ npx upgrade-interactive [options]

Options
  --install       Run "npm install" after writing changes (default: on)
  --no-install    Update package.json only, skip running "npm install" afterwards
  --audit         Flag vulnerable packages (default: on)
  --no-audit      Skip the vulnerability check (no advisory network calls)
  --section       Group the list into Dependencies / Dev dependencies / Overrides (default: on)
  --no-section    Show one flat list instead
  -w, --workspace <name>   Limit to matching workspace(s); repeatable, matches package name or path
  --no-workspaces          Only the root package.json (ignore any "workspaces" field)
  -h, --help      Show this help message
  -v, --version   Show the version number

Install, audit and sectioning are on by default. Persist a preference either way
with the NUI_INSTALL / NUI_AUDIT / NUI_SECTION environment variables, or a
package.json config block:

  "upgrade-interactive": { "install": false, "audit": false, "section": true }

Precedence: command-line flag > environment variable > package.json config > default (on).

In an npm workspaces repo (a root "workspaces" field) the root and each workspace
are shown as their own section, and each package's range is written to its own
manifest; "overrides" are always written to the root. The config block above is
read from the root manifest only — a workspace's own block is ignored, and you
get a note when that changes the run. Use -w to focus on particular workspaces,
or --no-workspaces for the root manifest alone.

  $ npx upgrade-interactive -w packages/api      # by path
  $ npx upgrade-interactive -w @acme/web         # by package name
  $ npx upgrade-interactive -w packages/api -w @acme/web

A -w value that matches no workspace is an error listing what didn't match, as is
combining -w with --no-workspaces.

Controls (inside the interactive UI)
  <up>/<down>     select a package
  <left>/<right>  select which version to apply (Current / Range / Latest)
  c / r / l       select all packages' Current / Range / Latest column at once
  o               pin a vulnerable package to a safe version (override, or a
                  range bump for a direct dependency) (audit mode)
  x               remove an existing override that's no longer needed (audit mode)
  <enter>         apply the selected upgrades (and run npm install)
  <ctrl+c> / esc  abort without changing anything
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP + '\n');
    return;
  }

  if (args.includes('-v') || args.includes('--version')) {
    const pkgRaw = await readFile(path.join(__dirname, '..', 'package.json'), 'utf8');
    process.stdout.write(JSON.parse(pkgRaw).version + '\n');
    return;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write('upgrade-interactive requires an interactive terminal (TTY).\n');
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const { workspaces, filter } = parseWorkspaceOptions(args);
  let project;
  try {
    project = await loadProject(cwd, { workspaces, filter });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const config = project.root.json['upgrade-interactive'];
  const { install, audit, section } = resolveToggles({ args, env: process.env, config });

  // Audit against the project root: npm workspaces share the root lockfile, so
  // this also makes runs from inside a workspace subdirectory resolve correctly.
  const rootDir = path.dirname(project.root.filePath);
  const manifestPaths = manifestPathsOf(project, rootDir);

  const result = await new Promise((resolve) => {
    const { waitUntilExit } = render(
      e(App, {
        descriptors: project.descriptors,
        audit,
        section,
        cwd: rootDir,
        overrides: project.root.json.overrides || {},
        manifestPaths,
        onSubmit: (selections, overrides, removals) => resolve({ type: 'submit', selections, overrides, removals }),
        onAbort: () => resolve({ type: 'abort' }),
      }),
      { exitOnCtrlC: false }
    );
    waitUntilExit().catch(() => resolve({ type: 'abort' }));
  });

  // After the TUI, never before it: anything written ahead of render() scrolls
  // above the interface and is missed, and this note's whole job is to be seen.
  // Every exit path below runs through here, so an ignored setting is reported
  // whether or not the run ended in changes.
  const ignoredConfig = formatIgnoredConfigNote(project, { install, audit, section });
  if (ignoredConfig) process.stderr.write(`\n${ignoredConfig}`);

  if (result.type === 'abort') {
    process.stdout.write('\nAborted. No changes were made.\n');
    process.exitCode = 1;
    return;
  }

  const overrideSelections = result.overrides || {};
  const overrideRemovals = result.removals || [];
  if (
    result.selections.size === 0 &&
    Object.keys(overrideSelections).length === 0 &&
    overrideRemovals.length === 0
  ) {
    process.stdout.write('\nNo changes selected.\n');
    return;
  }

  const { applied, overrides, removed } = await applyProject(
    project,
    result.selections,
    overrideSelections,
    overrideRemovals
  );

  process.stdout.write('\n');
  process.stdout.write(formatSummary({ applied, overrides, removed, isMonorepo: isMonorepoProject(project) }));

  if (applied.length === 0 && overrides.length === 0 && removed.length === 0) {
    process.stdout.write('No effective changes.\n');
    return;
  }

  if (!install) {
    process.stdout.write('\nUpdated package.json. Run npm install to apply.\n');
    return;
  }

  // Install once, from the project root — npm workspaces share the root
  // lockfile, so a per-workspace install would be wrong. For a standalone
  // project the root dir is just cwd.
  process.stdout.write('\nRunning npm install...\n');
  await runNpmInstall(rootDir);
}

function runNpmInstall(cwd) {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, ['install'], { cwd, stdio: 'inherit' });
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
    child.on('error', () => {
      process.stderr.write('Failed to run npm install. Run it manually to finish updating your lockfile.\n');
      process.exitCode = 1;
      resolve();
    });
  });
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exitCode = 1;
});
