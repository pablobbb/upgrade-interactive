// Single source of truth for which `overrides` entry the UI stages *by default*
// when the user presses `o` on a vulnerable package and confirms without
// changing anything. Both the interactive pickers (their initial state) and the
// fixture test harness import these, so the test can't quietly assert against a
// stale copy of the picker's default while the real app diverges.

import semver from 'semver';

/** @import { OverrideSpec, PinInstance, PinRefusal, ScopedSpec, Vuln } from './types.js' */

// A vulnerable instance is "pinnable" when it's actually vulnerable, its
// declared range can accept at least one safe version without a downgrade, and
// npm would neither ignore nor reject the key its pin lands on (`pinRefusal`,
// see markPinRefusals in vulnerabilities.js).
/** @param {PinInstance | null | undefined} i */
export function isPinnableInstance(i) {
  return !!(
    i && i.vulnerable && !i.pinRefusal && Array.isArray(i.safeCandidates) && i.safeCandidates.length > 0
  );
}

// Why a pin was refused, worded for the picker and the row note.
/** @param {PinRefusal | null | undefined} refusal */
export function pinRefusalText(refusal) {
  if (!refusal) return null;
  if (refusal.kind === 'eoverride') {
    return `npm rejects "${refusal.key}" beside the root's ${refusal.name} ${refusal.rootSpec} (EOVERRIDE)`;
  }
  if (refusal.kind === 'reaches') return `npm would also apply the pin to ${refusal.copy}, and no fix suits both`;
  if (refusal.proposed) {
    return `npm keeps only one of the identical pins "${refusal.key}" and "${refusal.by}" (${refusal.name} ${refusal.version})`;
  }
  return `npm would ignore a pin beside your override "${refusal.by}"`;
}

/** @param {Partial<Pick<Vuln, 'instances'>>} vuln */
export function pinnableInstances(vuln) {
  return (vuln.instances || []).filter(isPinnableInstance);
}

// The scoped picker defaults each row to the newest in-range safe version; this
// is the index of that choice within an instance's `safeCandidates`.
/** @param {PinInstance} instance */
export function defaultScopedChoiceIndex(instance) {
  return instance.safeCandidates.length - 1;
}

// The `overrides` key a scoped pin under instance `i` lands on: "parent@version"
// when that parent is installed at several versions among `instances`, else the
// bare parent name. Decided from every installed parent, including the
// safe/no-fix instances that won't be staged — once those are discarded, the
// writer cannot tell that a bare parent key would also change a different
// version we meant to leave alone.
/**
 * @template {string | null} P
 * @param {PinInstance[]} instances
 * @param {PinInstance & { parentName: P }} i
 * @returns {string | P} never null for a named parent
 */
export function parentOverrideKey(instances, i) {
  if (i.parentName == null || !i.parentVersion) return i.parentName;
  const versions = new Set();
  for (const o of instances) if (o.parentName === i.parentName) versions.add(o.parentVersion);
  return versions.size > 1 ? `${i.parentName}@${i.parentVersion}` : i.parentName;
}

// `choices`, when supplied by the picker, is aligned to the pinnable instances.
/**
 * @param {PinInstance[]} instances
 * @param {number[]} [choices]
 * @returns {ScopedSpec}
 */
export function scopedOverrideSelection(instances, choices) {
  return {
    scoped: instances.filter(isPinnableInstance).map((i, index) => {
      const key = parentOverrideKey(instances, i);
      return {
        parentName: i.parentName,
        parentVersion: i.parentVersion,
        version: i.safeCandidates[choices?.[index] ?? defaultScopedChoiceIndex(i)],
        ...(key != null && key !== i.parentName ? { parentSelector: key } : {}),
      };
    }),
  };
}

// True when the package is installed at several versions across the tree, so a
// single global pin would be wrong and we offer per-parent scoped pins instead
// (as long as at least one vulnerable instance has an in-range fix). Mirrors the
// scoped-vs-global branch in App.openOverride.
/** @param {Vuln} vuln */
export function shouldScope(vuln) {
  return vuln.pinStrategy === 'scoped' && pinnableInstances(vuln).length > 0;
}

// True when no `overrides` entry can express a fix. Either manifests in this
// project declare different ranges for the package, and npm honors overrides
// only at the root, so any single pin would satisfy one manifest and silently
// rewrite or under-fix the others; or the package needs per-parent pins and npm
// would ignore or reject every fixable one (`pinRefusal`). Blocks *both* picker
// paths — clearing the scoped candidates alone would just fall through to the
// global one, which would also pin the copies the scoped strategy exists to
// leave alone.
/** @param {Vuln} vuln */
export function isPinBlocked(vuln) {
  if (vuln.pinConflict) return true;
  return (
    vuln.pinStrategy === 'scoped' &&
    pinnableInstances(vuln).length === 0 &&
    (vuln.instances || []).some((i) => i.pinRefusal)
  );
}

// Whether a pin to `version` takes a dependent declaring `range` to another
// major line: outside the range, and outside `^` its lowest version. So an exact
// "1.16.0" taking 1.16.2 isn't, and "^0.8.8" taking 0.9.0 is. A range that isn't
// semver (a git URL, a tag) is skipped.
/**
 * @param {string} range
 * @param {string} version
 */
function leavesMajor(range, version) {
  if (!semver.validRange(range) || !semver.valid(version)) return false;
  if (semver.satisfies(version, range, { includePrerelease: true })) return false;
  const floor = semver.minVersion(range);
  return !floor || !semver.satisfies(version, `^${floor.version}`, { includePrerelease: true });
}

// The dependents a global pin to `version` takes past the major they declare, and
// which of them are already safe and would move anyway. The picker used to offer
// such a pin as a plain version: in the 2026-11-04 field report, a pin to
// minimatch 11 moved eslint's minimatch@3, which the advisory doesn't affect, and
// broke five eslint-plugin-react rules that call it as a function (F3). It's
// still offered, since it also fixed ten vulnerable copies; the picker says what
// it costs. The root's own edge is left out: for a direct dependency `o` bumps the
// root's range instead. A dependent already on the pin's line isn't moved by it.
/**
 * @param {Pick<Vuln, 'instances'>} vuln
 * @param {string} version
 */
export function crossedDependents(vuln, version) {
  const crossed = (vuln.instances || []).filter((i) => i.parentPath !== '' && leavesMajor(i.declaredRange, version));
  const alreadySafe = crossed.filter(
    (i) =>
      !i.vulnerable &&
      !!i.installedVersion &&
      !!semver.valid(i.installedVersion) &&
      !semver.satisfies(version, `^${i.installedVersion}`, { includePrerelease: true })
  );
  return { crossed, alreadySafe };
}

// A version-qualified key that pins only what the advisories affect, for the user
// to write by hand instead of a global pin that moves safe copies: "pkg@>=7" when
// every matching advisory starts at 7.0.0. On the field report's tree it fixed as
// many copies as the run's bare "minimatch" pin and left eslint on 3.1.5 (F3). The
// unspaced form is the one npm 10.9.9 also honoured. Null when there's no safe
// copy below the advisories to spare, when one has no lower bound, or when the key
// would also catch a newer copy and lower it to `version`.
/**
 * @param {string} name
 * @param {Pick<Vuln, 'advisories' | 'instances'>} vuln
 * @param {string} version
 * @returns {string | null}
 */
export function narrowerKey(name, vuln, version) {
  const floors = (vuln.advisories || []).map((a) => {
    try {
      return semver.minVersion(a.vulnerable_versions);
    } catch {
      return null;
    }
  });
  if (floors.length === 0 || floors.some((f) => !f || f.version === '0.0.0')) return null;
  const floor = /** @type {import('semver').SemVer[]} */ (floors).reduce((a, b) => (semver.lt(b, a) ? b : a));
  /** @param {string | null} v */
  const below = (v) => !!v && !!semver.valid(v) && semver.lt(v, floor);
  const instances = vuln.instances || [];
  if (!instances.some((i) => !i.vulnerable && below(i.installedVersion))) return null;
  const caught = instances.some(
    (i) => !!i.installedVersion && !!semver.valid(i.installedVersion) && !below(i.installedVersion) && semver.gt(i.installedVersion, version)
  );
  if (caught) return null;
  const whole = floor.minor === 0 && floor.patch === 0 && floor.prerelease.length === 0;
  return `${name}@>=${whole ? floor.major : floor.version}`;
}

// The exact `overrides` value the UI would stage if the user pressed `o` on this
// vuln and hit <enter> without changing anything: a { scoped: [...] } spec for a
// multi-version package, a single global version string, or null when there's no
// safe fix to offer. This is the value that flows into applyUpgrades.
/**
 * @param {Vuln} vuln
 * @returns {OverrideSpec | null}
 */
export function defaultOverrideSelection(vuln) {
  if (isPinBlocked(vuln)) return null;
  if (shouldScope(vuln)) {
    return scopedOverrideSelection(vuln.instances);
  }
  if (vuln.safeVersions && vuln.safeVersions.length > 0) return vuln.safeVersions[0];
  return null;
}
