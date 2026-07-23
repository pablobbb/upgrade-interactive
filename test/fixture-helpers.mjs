// Shared helpers for the real-world fixture tests (test/fixtures/*).
//
// Fixtures store their manifest/lockfile as `manifest.json` / `lock.json` rather
// than the canonical `package.json` / `package-lock.json`, so a deliberately
// vulnerable lockfile doesn't trip repo-wide scanners (Dependabot alerts, npm
// audit, IDE npm tooling). Everything here stages a fixture into a throwaway temp
// dir under the real names before the loaders touch it.

import { readFile, readdir, mkdtemp, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/package-file.js';
import { loadInstalledVersions } from '../src/lockfile.js';
import { computeVulnerabilities } from '../src/vulnerabilities.js';
import { defaultOverrideSelection } from '../src/override-select.js';

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function listFixtures() {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// A registry double backed by a fixture's frozen snapshot (real published
// versions + real advisories), so tests are offline and deterministic.
export function stubFromSnapshot(snapshot) {
  return {
    fetchPackageMeta: async (name) => snapshot.meta[name] || null,
    fetchBulkAdvisories: async (versionsByName) => {
      const advisories = new Map();
      for (const name of Object.keys(versionsByName)) {
        if (snapshot.advisories[name]) advisories.set(name, snapshot.advisories[name]);
      }
      return { ok: true, advisories };
    },
  };
}

// Turn the audit result into the `overrides` map applyUpgrades expects, choosing
// exactly the defaults the UI's pickers stage — via `defaultOverrideSelection`,
// the same helper the pickers use for their initial state, so the fixtures
// assert against the real default rather than a copy that could drift from it.
export function overridesFromVulns(vulns) {
  const overrides = {};
  for (const [name, vuln] of vulns) {
    const spec = defaultOverrideSelection(vuln);
    if (spec != null) overrides[name] = spec;
  }
  return overrides;
}

// Copy a fixture into a fresh temp dir under the canonical filenames. Also drops
// a `.tool-versions` pinned to the running Node so `npm` works when the tests run
// under a version manager (asdf) in an otherwise unpinned temp dir; harmless in
// CI, which has no version manager.
export async function stageFixture(fixtureDir) {
  const work = await mkdtemp(path.join(tmpdir(), 'nui-fixture-'));
  await copyFile(path.join(fixtureDir, 'manifest.json'), path.join(work, 'package.json'));
  await copyFile(path.join(fixtureDir, 'lock.json'), path.join(work, 'package-lock.json'));
  await writeFile(path.join(work, '.tool-versions'), `nodejs ${process.versions.node}\n`, 'utf8');
  return work;
}

// The override names the tool would offer to drop (the `x` removal flow): every
// existing override flagged dead or redundant. Kept (unverifiable / still-needed)
// overrides are never in this map, so they survive.
export function removalsFromRemovable(removableOverrides) {
  return removableOverrides ? [...removableOverrides.keys()] : [];
}

// Run load -> audit against a staged working copy, returning the loaded manifest,
// the computed vulns, and the removable existing overrides, so callers can build
// + apply both additions and removals.
export async function auditFixture(work, snapshot) {
  const manifest = await loadManifest(work);
  const installed = await loadInstalledVersions(work);
  const { vulns, removableOverrides } = await computeVulnerabilities(
    { descriptors: manifest.descriptors, installed, overrides: manifest.json.overrides || {} },
    stubFromSnapshot(snapshot)
  );
  return { manifest, installed, vulns, removableOverrides };
}
