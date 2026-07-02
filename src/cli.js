#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { App } from './components/App.js';
import { loadManifest, applyUpgrades } from './package-file.js';

const e = React.createElement;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
upgrade-interactive (nui)

An interactive dependency upgrader for npm projects, inspired by yarn's
"upgrade-interactive" (Yarn Berry / Yarn 4).

Usage
  $ npx upgrade-interactive [options]

Options
  --no-install    Update package.json only, skip running "npm install" afterwards
  --audit         Flag vulnerable packages (default: on)
  --no-audit      Skip the vulnerability check (no advisory network calls)
  --section       Group the list into Dependencies / Dev dependencies / Overrides (default: on)
  --no-section    Show one flat list instead
  -h, --help      Show this help message
  -v, --version   Show the version number

Audit and sectioning are on by default. Persist a preference either way with the
NUI_AUDIT / NUI_SECTION environment variables, or a package.json config block:

  "upgrade-interactive": { "audit": false, "section": true }

Precedence: command-line flag > environment variable > package.json config > default (on).

Controls (inside the interactive UI)
  <up>/<down>     select a package
  <left>/<right>  select which version to apply (Current / Range / Latest)
  c / r / l       select all packages' Current / Range / Latest column at once
  o               override a vulnerable package to a safe version (audit mode)
  x               remove an existing override that's no longer needed (audit mode)
  <enter>         apply the selected upgrades (and run npm install)
  <ctrl+c> / esc  abort without changing anything
`;

// Resolve a boolean toggle from flags > env var > package.json config > default(true).
function resolveToggle({ args, env, config, onFlag, offFlag, envVar, configKey }) {
  if (args.includes(offFlag)) return false;
  if (args.includes(onFlag)) return true;
  const envVal = env[envVar];
  if (envVal != null && envVal !== '') {
    return !/^(0|false|no|off)$/i.test(envVal.trim());
  }
  if (config && typeof config[configKey] === 'boolean') return config[configKey];
  return true;
}

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

  const skipInstall = args.includes('--no-install');

  if (!process.stdin.isTTY) {
    process.stderr.write('upgrade-interactive requires an interactive terminal (TTY).\n');
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  let manifest;
  try {
    manifest = await loadManifest(cwd);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const config = manifest.json['upgrade-interactive'];
  const audit = resolveToggle({
    args, env: process.env, config, onFlag: '--audit', offFlag: '--no-audit', envVar: 'NUI_AUDIT', configKey: 'audit',
  });
  const section = resolveToggle({
    args, env: process.env, config, onFlag: '--section', offFlag: '--no-section', envVar: 'NUI_SECTION', configKey: 'section',
  });

  const result = await new Promise((resolve) => {
    const { waitUntilExit } = render(
      e(App, {
        descriptors: manifest.descriptors,
        audit,
        section,
        cwd,
        overrides: manifest.json.overrides || {},
        onSubmit: (selections, overrides, removals) => resolve({ type: 'submit', selections, overrides, removals }),
        onAbort: () => resolve({ type: 'abort' }),
      }),
      { exitOnCtrlC: false }
    );
    waitUntilExit().catch(() => resolve({ type: 'abort' }));
  });

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

  const { applied, overrides, removed } = await applyUpgrades(
    manifest,
    result.selections,
    overrideSelections,
    overrideRemovals
  );

  process.stdout.write('\n');
  const byField = { dependencies: [], devDependencies: [] };
  for (const change of applied) byField[change.field].push(change);

  for (const field of ['dependencies', 'devDependencies']) {
    if (byField[field].length === 0) continue;
    process.stdout.write(`${field}\n`);
    for (const change of byField[field]) {
      process.stdout.write(`  ${change.name}  ${change.from} \u2192 ${change.to}\n`);
    }
  }

  if (overrides.length > 0 || removed.length > 0) {
    process.stdout.write('overrides\n');
    for (const change of overrides) {
      const target = change.parent ? `${change.parent} \u203a ${change.name}` : change.name;
      process.stdout.write(`  ${target}  \u2192 ${change.to}\n`);
    }
    for (const change of removed) {
      process.stdout.write(`  ${change.name}  removed\n`);
    }
  }

  if (applied.length === 0 && overrides.length === 0 && removed.length === 0) {
    process.stdout.write('No effective changes.\n');
    return;
  }

  if (skipInstall) {
    process.stdout.write('\nUpdated package.json. Run npm install to apply.\n');
    return;
  }

  process.stdout.write('\nRunning npm install...\n');
  await runNpmInstall(cwd);
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
