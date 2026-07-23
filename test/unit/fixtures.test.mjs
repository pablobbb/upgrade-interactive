// End-to-end fixture tests: drive real npm-generated lockfiles through the full
// load -> audit -> write pipeline and assert the exact `overrides` we'd write.
//
// Unlike the other unit tests (which hand-build tiny in-memory trees), these use
// genuine manifest + lockfile pairs under test/fixtures/, so they catch
// divergence between our model of npm's lockfile/overrides shapes and what npm
// actually produces. The registry (published versions + advisories) is frozen
// per fixture in `registry.snapshot.json`, so the tests stay offline and
// deterministic while the lockfile stays real. See each fixture's NOTES.md.
//
// This is the OFFLINE half: it asserts the overrides we *write*. The network
// half (test/integration/roundtrip.test.mjs) asserts npm *accepts* them.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, access } from 'node:fs/promises';
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

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const tmpDirs = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('real-world fixtures — full pipeline to written overrides', async () => {
  const fixtures = await listFixtures();
  assert(fixtures.length > 0, 'expected at least one fixture directory');

  for (const name of fixtures) {
    it(`${name}: writes the expected overrides`, async () => {
      const fixtureDir = path.join(FIXTURES_DIR, name);
      const snapshot = await readJson(path.join(fixtureDir, 'registry.snapshot.json'));
      const expected = await readJson(path.join(fixtureDir, 'expected-overrides.json'));

      const work = await stageFixture(fixtureDir);
      tmpDirs.push(work);
      const { manifest, vulns, removableOverrides } = await auditFixture(work, snapshot);

      // Apply both halves of what the tool would do: add the pins for vulnerable
      // packages, drop the existing overrides flagged removable. A fixture that
      // only adds has no removals, and one that only removes has no vulns.
      const overrides = overridesFromVulns(vulns);
      const removals = removalsFromRemovable(removableOverrides);
      await applyUpgrades(manifest, new Map(), overrides, removals);

      const manifestJson = await readJson(path.join(work, 'package.json'));
      const written = manifestJson.overrides || {};
      assert.deepEqual(written, expected, `${name}: written overrides should match expected-overrides.json`);

      // Fixtures whose fix lands as a dependency-range bump (a direct dep that
      // can't take a top-level override) carry an expected-dependencies.json.
      const depsFile = path.join(fixtureDir, 'expected-dependencies.json');
      if (await exists(depsFile)) {
        const expectedDeps = await readJson(depsFile);
        const merged = { ...manifestJson.dependencies, ...manifestJson.devDependencies };
        for (const [dep, range] of Object.entries(expectedDeps)) {
          assert.equal(merged[dep], range, `${name}: ${dep} should be bumped to ${range}`);
        }
      }
    });
  }
});
