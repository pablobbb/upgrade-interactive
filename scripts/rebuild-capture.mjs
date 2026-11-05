#!/usr/bin/env node
// rebuild-capture.mjs — rebuild a project from one side of a capture-run.sh capture.
//
//   node scripts/rebuild-capture.mjs <capture>/post <out-dir>
//   node scripts/rebuild-capture.mjs <capture>/pre <out-dir> --manifests <capture>/post
//
// A capture holds the root package.json and package-lock.json, but not the
// workspaces' own manifests. The lockfile records each of them in its `packages`
// map, under the workspace's path, so they can be written back out: enough for
// npm to resolve the project and for the tool to audit it. Scripts are not
// recorded there, so a rebuilt project has none of its workspaces' scripts.
//
// `--manifests <side>` takes the manifests from another side while keeping this
// side's lockfile. `pre` + `--manifests post` is the state the run's `npm install`
// started from, so installing in it replays the run.
//
// Install in the result with `--package-lock-only --ignore-scripts`: it is a
// stranger's dependency tree.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// The lockfile fields that carry a workspace's manifest.
const FIELDS = [
  'name', 'version', 'license', 'bin', 'engines', 'dependencies', 'devDependencies',
  'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies',
];

function usage(message) {
  if (message) process.stderr.write(`rebuild-capture: ${message}\n`);
  process.stderr.write('usage: rebuild-capture.mjs <capture-side> <out-dir> [--manifests <capture-side>]\n');
  process.exit(1);
}

const args = process.argv.slice(2);
const at = args.indexOf('--manifests');
const manifestsSide = at === -1 ? null : args[at + 1];
if (at !== -1) args.splice(at, 2);
const [side, out] = args;
if (!side || !out || (at !== -1 && !manifestsSide)) usage();
for (const dir of [side, manifestsSide].filter(Boolean)) {
  for (const file of ['package.json', 'package-lock.json']) {
    if (!existsSync(path.join(dir, file))) usage(`${dir} has no ${file}`);
  }
}
if (existsSync(out) && readdirSync(out).length > 0) usage(`${out} is not empty`);

/** @param {string} dir */
const lockOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).packages || {};
const from = manifestsSide || side;

mkdirSync(out, { recursive: true });
copyFileSync(path.join(from, 'package.json'), path.join(out, 'package.json'));
copyFileSync(path.join(side, 'package-lock.json'), path.join(out, 'package-lock.json'));

// A workspace is a lockfile path with no node_modules segment, other than the root.
let count = 0;
for (const [at, info] of Object.entries(lockOf(from))) {
  if (!at || at.includes('node_modules/')) continue;
  const manifest = {};
  for (const field of FIELDS) if (info[field] != null) manifest[field] = info[field];
  mkdirSync(path.join(out, at), { recursive: true });
  writeFileSync(path.join(out, at, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  count++;
}
process.stdout.write(`${out}: root manifest + ${count} workspace manifest${count === 1 ? '' : 's'}\n`);
