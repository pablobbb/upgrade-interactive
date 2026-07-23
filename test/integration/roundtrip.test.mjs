// npm round-trip integration test: after writing the overrides the tool would
// produce for each fixture, actually run `npm install --package-lock-only` and
// assert npm's verdict. This is the literal "do we follow how npm works?" check —
// it verifies npm *accepts* what we write, and it fails loudly on the direct-dep
// EOVERRIDE bug that the offline test can only characterize.
//
// Needs network (npm resolves against the live registry), so it lives in
// test:integration rather than the offline `npm test` suite.
//
// Each fixture may include a `roundtrip.json`:
//   { "expect": "accepted" }                              (default if absent)
//   { "expect": "rejected", "code": "EOVERRIDE", ... }
// "accepted" asserts npm exits 0; "rejected" asserts a non-zero exit whose
// output includes the given npm error code.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { applyUpgrades } from '../../src/package-file.js';
import {
  FIXTURES_DIR,
  listFixtures,
  readJson,
  overridesFromVulns,
  removalsFromRemovable,
  stageFixture,
  auditFixture,
} from '../fixture-helpers.mjs';

function runNpmInstall(cwd) {
  return new Promise((resolve) => {
    execFile(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund'],
      // ASDF_NODEJS_VERSION lets npm's shim resolve under a version manager; the
      // staged dir also carries a .tool-versions. Both are harmless in CI.
      { cwd, env: { ...process.env, ASDF_NODEJS_VERSION: process.versions.node }, timeout: 120000 },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        // Distinguish "npm ran and exited non-zero" (a real rejection) from "npm
        // never ran" (not on PATH, killed by timeout). A non-zero *exit* sets a
        // numeric error.code; a spawn/timeout failure sets a string code
        // ('ENOENT') or none. Without this split, a code-less `rejected` fixture
        // would pass just because npm was missing — a false green.
        if (error && typeof error.code !== 'number') {
          resolve({ ran: false, code: null, output: `${error.message}\n${output}` });
          return;
        }
        resolve({ ran: true, code: error ? error.code : 0, output });
      }
    );
  });
}

async function readRoundtripConfig(fixtureDir) {
  const file = path.join(fixtureDir, 'roundtrip.json');
  try {
    await access(file);
  } catch {
    return { expect: 'accepted' };
  }
  return readJson(file);
}

const tmpDirs = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('real-world fixtures — npm round-trip', async () => {
  const fixtures = await listFixtures();
  assert(fixtures.length > 0, 'expected at least one fixture directory');

  for (const name of fixtures) {
    it(`${name}: npm accepts/rejects the written overrides as expected`, async () => {
      const fixtureDir = path.join(FIXTURES_DIR, name);
      const snapshot = await readJson(path.join(fixtureDir, 'registry.snapshot.json'));
      const config = await readRoundtripConfig(fixtureDir);

      const work = await stageFixture(fixtureDir);
      tmpDirs.push(work);
      const { manifest, vulns, removableOverrides } = await auditFixture(work, snapshot);
      await applyUpgrades(
        manifest,
        new Map(),
        overridesFromVulns(vulns),
        removalsFromRemovable(removableOverrides)
      );

      const { ran, code, output } = await runNpmInstall(work);
      assert.ok(ran, `${name}: npm failed to run (is npm on PATH? did it time out?)\n${output}`);

      if (config.expect === 'rejected') {
        assert.notEqual(code, 0, `${name}: expected npm to reject the overrides\n${output}`);
        if (config.code) {
          assert.match(output, new RegExp(config.code), `${name}: expected npm error ${config.code}\n${output}`);
        }
      } else {
        assert.equal(code, 0, `${name}: expected npm to accept the overrides\n${output}`);
      }
    });
  }
});
