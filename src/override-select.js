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
  if (refusal.kind === 'reaches') return `npm would also apply the pin to ${refusal.copy}, and no fix suits both`;
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

// The `overrides` key each scoped pin lands on, aligned with `pins`
// ([{ i, version }]). A parent installed at a single version among `instances`
// keeps the bare name. Otherwise a pin is keyed by its parent's version —
// decided from every installed parent, including the safe/no-fix instances that
// won't be staged, since a bare key would also change the copies meant to be
// left alone. Copies of one parent pinned to the same version share one key
// ("parent@1.0.0 || 1.1.0"): npm drops a copy's pins when two keys for one
// parent pin the same version (override-keys.js).
export function scopedPinKeys(instances, pins) {
  const versions = new Map();
  for (const o of instances) {
    if (o.parentName == null) continue;
    if (!versions.has(o.parentName)) versions.set(o.parentName, new Set());
    versions.get(o.parentName).add(o.parentVersion);
  }
  const group = (p) =>
    p.i.parentName != null && p.i.parentVersion && versions.get(p.i.parentName).size > 1
      ? `${p.i.parentName}\0${p.version}`
      : null;
  const sharing = new Map();
  for (const p of pins) {
    const g = group(p);
    if (!g) continue;
    if (!sharing.has(g)) sharing.set(g, []);
    if (!sharing.get(g).includes(p.i.parentVersion)) sharing.get(g).push(p.i.parentVersion);
  }
  return pins.map((p) => {
    const g = group(p);
    return g ? `${p.i.parentName}@${sharing.get(g).join(' || ')}` : p.i.parentName;
  });
}

// `choices`, when supplied by the picker, is aligned to the pinnable instances.
export function scopedOverrideSelection(instances, choices) {
  const pins = instances.filter(isPinnableInstance).map((i, index) => ({
    i,
    version: i.safeCandidates[choices?.[index] ?? defaultScopedChoiceIndex(i)],
  }));
  const keys = scopedPinKeys(instances, pins);
  return {
    scoped: pins.map(({ i, version }, index) => ({
      parentName: i.parentName,
      parentVersion: i.parentVersion,
      version,
      ...(keys[index] !== i.parentName ? { parentSelector: keys[index] } : {}),
    })),
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
