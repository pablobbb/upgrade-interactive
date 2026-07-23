// Single source of truth for which `overrides` entry the UI stages *by default*
// when the user presses `o` on a vulnerable package and confirms without
// changing anything. Both the interactive pickers (their initial state) and the
// fixture test harness import these, so the test can't quietly assert against a
// stale copy of the picker's default while the real app diverges.

// A vulnerable instance is "pinnable" when it's actually vulnerable and its
// declared range can accept at least one safe version without a downgrade.
export function isPinnableInstance(i) {
  return !!(i && i.vulnerable && Array.isArray(i.safeCandidates) && i.safeCandidates.length > 0);
}

export function pinnableInstances(vuln) {
  return (vuln.instances || []).filter(isPinnableInstance);
}

// The scoped picker defaults each row to the newest in-range safe version; this
// is the index of that choice within an instance's `safeCandidates`.
export function defaultScopedChoiceIndex(instance) {
  return instance.safeCandidates.length - 1;
}

// True when the package is installed at several versions across the tree, so a
// single global pin would be wrong and we offer per-parent scoped pins instead
// (as long as at least one vulnerable instance has an in-range fix). Mirrors the
// scoped-vs-global branch in App.openOverride.
export function shouldScope(vuln) {
  return vuln.pinStrategy === 'scoped' && pinnableInstances(vuln).length > 0;
}

// The exact `overrides` value the UI would stage if the user pressed `o` on this
// vuln and hit <enter> without changing anything: a { scoped: [...] } spec for a
// multi-version package, a single global version string, or null when there's no
// safe fix to offer. This is the value that flows into applyUpgrades.
export function defaultOverrideSelection(vuln) {
  if (shouldScope(vuln)) {
    return {
      scoped: pinnableInstances(vuln).map((i) => ({
        parentName: i.parentName,
        parentVersion: i.parentVersion,
        version: i.safeCandidates[defaultScopedChoiceIndex(i)],
      })),
    };
  }
  if (vuln.safeVersions && vuln.safeVersions.length > 0) return vuln.safeVersions[0];
  return null;
}
