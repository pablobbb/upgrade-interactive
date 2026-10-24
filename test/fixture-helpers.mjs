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
import semver from 'semver';
import { loadManifest } from '../src/package-file.js';
import { loadInstalledVersions } from '../src/lockfile.js';
import { computeVulnerabilities } from '../src/vulnerabilities.js';
import { defaultOverrideSelection } from '../src/override-select.js';

/**
 * @import {
 *   Advisory, BulkAdvisories, OverrideSpec, PackageMeta, RemovableOverride, Vuln,
 * } from '../src/types.js'
 */

/**
 * A fixture's frozen registry: `registry.snapshot.json`.
 * @typedef {{ meta: Record<string, PackageMeta>, advisories: Record<string, Advisory[]> }} RegistrySnapshot
 */

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

/**
 * Parsed JSON, typed by the caller (annotate the variable it lands in).
 * @param {string} file
 * @returns {Promise<any>}
 */
export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function listFixtures() {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// A registry double backed by a fixture's frozen snapshot (real published
// versions + real advisories), so tests are offline and deterministic.
/** @param {RegistrySnapshot} snapshot */
export function stubFromSnapshot(snapshot) {
  return {
    /** @param {string} name */
    fetchPackageMeta: async (name) => snapshot.meta[name] || null,
    /**
     * @param {Record<string, Iterable<string>>} versionsByName
     * @returns {Promise<BulkAdvisories>}
     */
    fetchBulkAdvisories: async (versionsByName) => {
      /** @type {Map<string, Advisory[]>} */
      const advisories = new Map();
      for (const [name, versions] of Object.entries(versionsByName)) {
        const matching = (snapshot.advisories[name] || []).filter((a) =>
          [...versions].some((v) => semver.satisfies(v, a.vulnerable_versions, { includePrerelease: true }))
        );
        if (matching.length > 0) advisories.set(name, matching);
      }
      return { ok: true, advisories };
    },
  };
}

// Turn the audit result into the `overrides` map applyUpgrades expects, choosing
// exactly the defaults the UI's pickers stage — via `defaultOverrideSelection`,
// the same helper the pickers use for their initial state, so the fixtures
// assert against the real default rather than a copy that could drift from it.
/** @param {Map<string, Vuln>} vulns */
export function overridesFromVulns(vulns) {
  /** @type {Record<string, OverrideSpec>} */
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
/** @param {string} fixtureDir */
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
/** @param {Map<string, RemovableOverride> | null | undefined} removableOverrides */
export function removalsFromRemovable(removableOverrides) {
  return removableOverrides ? [...removableOverrides.keys()] : [];
}

// Run load -> audit against a staged working copy, returning the loaded manifest,
// the computed vulns, the removable existing overrides, and the overrides the
// installed tree never applied, so callers can build + apply both additions and
// removals and assert on what npm's own resolution left un-honoured.
/**
 * @param {string} work
 * @param {RegistrySnapshot} snapshot
 */
export async function auditFixture(work, snapshot) {
  const manifest = await loadManifest(work);
  // Every fixture is a single-package project, so the root is the only manifest
  // — the same value cli.js computes via manifestPathsOf for a standalone run.
  const manifestPaths = [''];
  const installed = await loadInstalledVersions(work);
  const { vulns, removableOverrides, unappliedOverrides } = await computeVulnerabilities(
    {
      descriptors: manifest.descriptors,
      installed,
      overrides: manifest.json.overrides || {},
      manifestPaths,
    },
    stubFromSnapshot(snapshot)
  );
  return { manifest, installed, vulns, removableOverrides, unappliedOverrides };
}
