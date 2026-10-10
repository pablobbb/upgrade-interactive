// Single source of truth for which `overrides` entry the UI stages *by default*
// when the user presses `o` on a vulnerable package and confirms without
// changing anything. Both the interactive pickers (their initial state) and the
// fixture test harness import these, so the test can't quietly assert against a
// stale copy of the picker's default while the real app diverges.

// A vulnerable instance is "pinnable" when it's actually vulnerable, its
// declared range can accept at least one safe version without a downgrade, and
// npm would neither ignore nor reject the key its pin lands on (`pinRefusal`,
// see markPinRefusals in vulnerabilities.js).
export function isPinnableInstance(i) {
  return !!(
    i && i.vulnerable && !i.pinRefusal && Array.isArray(i.safeCandidates) && i.safeCandidates.length > 0
  );
}

// Why a pin was refused, worded for the picker and the row note.
export function pinRefusalText(refusal) {
  if (!refusal) return null;
  if (refusal.kind === 'eoverride') {
    return `npm rejects "${refusal.key}" beside the root's ${refusal.name} ${refusal.rootSpec} (EOVERRIDE)`;
  }
  return `npm would ignore a pin beside "${refusal.by}"`;
}

export function pinnableInstances(vuln) {
  return (vuln.instances || []).filter(isPinnableInstance);
}

// The scoped picker defaults each row to the newest in-range safe version; this
// is the index of that choice within an instance's `safeCandidates`.
export function defaultScopedChoiceIndex(instance) {
  return instance.safeCandidates.length - 1;
}

// The `overrides` key a scoped pin under instance `i` lands on: "parent@version"
// when that parent is installed at several versions among `instances`, else the
// bare parent name. Decided from every installed parent, including the
// safe/no-fix instances that won't be staged — once those are discarded, the
// writer cannot tell that a bare parent key would also change a different
// version we meant to leave alone.
export function parentOverrideKey(instances, i) {
  if (i.parentName == null || !i.parentVersion) return i.parentName;
  const versions = new Set();
  for (const o of instances) if (o.parentName === i.parentName) versions.add(o.parentVersion);
  return versions.size > 1 ? `${i.parentName}@${i.parentVersion}` : i.parentName;
}

// `choices`, when supplied by the picker, is aligned to the pinnable instances.
export function scopedOverrideSelection(instances, choices) {
  return {
    scoped: instances.filter(isPinnableInstance).map((i, index) => {
      const key = parentOverrideKey(instances, i);
      return {
        parentName: i.parentName,
        parentVersion: i.parentVersion,
        version: i.safeCandidates[choices?.[index] ?? defaultScopedChoiceIndex(i)],
        ...(key !== i.parentName ? { parentSelector: key } : {}),
      };
    }),
  };
}

// True when the package is installed at several versions across the tree, so a
// single global pin would be wrong and we offer per-parent scoped pins instead
// (as long as at least one vulnerable instance has an in-range fix). Mirrors the
// scoped-vs-global branch in App.openOverride.
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
export function isPinBlocked(vuln) {
  if (vuln.pinConflict) return true;
  return (
    vuln.pinStrategy === 'scoped' &&
    pinnableInstances(vuln).length === 0 &&
    (vuln.instances || []).some((i) => i.pinRefusal)
  );
}

// The exact `overrides` value the UI would stage if the user pressed `o` on this
// vuln and hit <enter> without changing anything: a { scoped: [...] } spec for a
// multi-version package, a single global version string, or null when there's no
// safe fix to offer. This is the value that flows into applyUpgrades.
export function defaultOverrideSelection(vuln) {
  if (isPinBlocked(vuln)) return null;
  if (shouldScope(vuln)) {
    return scopedOverrideSelection(vuln.instances);
  }
  if (vuln.safeVersions && vuln.safeVersions.length > 0) return vuln.safeVersions[0];
  return null;
}
