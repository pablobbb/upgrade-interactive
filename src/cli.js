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
npm-upgrade-interactive (nui)

A faithful clone of "yarn upgrade-interactive" (Yarn Berry / Yarn 4) for npm projects.

Usage
  $ npx npm-upgrade-interactive [options]

Options
  --no-install   Update package.json only, skip running "npm install" afterwards
  -h, --help     Show this help message
  -v, --version  Show the version number

Controls (inside the interactive UI)
  <up>/<down>     select a package
  <left>/<right>  select which version to apply (Current / Range / Latest)
  c / r / l       select all packages' Current / Range / Latest column at once
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

  const skipInstall = args.includes('--no-install');

  if (!process.stdin.isTTY) {
    process.stderr.write('npm-upgrade-interactive requires an interactive terminal (TTY).\n');
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

  const result = await new Promise((resolve) => {
    const { waitUntilExit } = render(
      e(App, {
        descriptors: manifest.descriptors,
        onSubmit: (selections) => resolve({ type: 'submit', selections }),
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

  if (result.selections.size === 0) {
    process.stdout.write('\nNo changes selected.\n');
    return;
  }

  const applied = await applyUpgrades(manifest, result.selections);

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
