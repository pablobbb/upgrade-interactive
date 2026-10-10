// How npm treats `overrides` keys that name a parent package. The audit uses
// these rules to refuse a pin up front; the writer uses them to refuse a layout
// npm would ignore or reject. Measured against npm 11.13.0:
//
// - A bare "pkg" key and a "pkg@version" key are not combined. npm applies one
//   and silently ignores the other.
// - Two "pkg@version" keys keep their own pins only when they pin some shared
//   package to versions that don't overlap. Otherwise npm falls back to the
//   root override set for the copy other dependents resolve through (the
//   hoisted one), and that copy's pins are silently dropped. Two copies of
//   minimatch both pinned to brace-expansion 2.1.7 left the hoisted one on the
//   vulnerable 2.0.1; pinned to 2.1.6 and 2.1.7, both applied.
// - A "pkg@version" key without a "." value also pins pkg itself to `version`.
//   When the root declares pkg with any other spec that admits `version`, npm
//   fails the install with EOVERRIDE ("conflicts with direct dependency").
import semver from 'semver';

// The package an `overrides` key names: "pkg@1.0.0" and "@scope/pkg" both name
// a package, and index 0 is a scope, not a selector separator.
export function overrideKeyName(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

// The selector of a qualified key ("1.0.0" in "pkg@1.0.0"), or null when bare.
export function overrideKeySpec(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(at + 1) : null;
}

// The version an entry pins, as npm reads it: a string value, an object's "."
// value, or else the key's own selector ("*" for a bare key).
function pinnedSpec(key, value) {
  if (typeof value === 'string') return value || '*';
  if (value && typeof value === 'object' && typeof value['.'] === 'string') return value['.'] || '*';
  return overrideKeySpec(key) ?? '*';
}

// npm's test for whether two sibling override sets conflict: some package is
// pinned in both, to ranges that don't intersect. References ("$pkg") and
// non-semver specs never conflict, and a string value pins only the parent.
export function overrideBucketsConflict(a, b) {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
  for (const [key, value] of Object.entries(a)) {
    if (key === '.' || !(key in b)) continue;
    const x = pinnedSpec(key, value);
    const y = pinnedSpec(key, b[key]);
    if (x.startsWith('$') || y.startsWith('$')) continue;
    if (!semver.validRange(x) || !semver.validRange(y)) continue;
    if (!semver.intersects(x, y)) return true;
  }
  return false;
}

// True when writing `bucket` under the qualified `key` would make npm fail with
// EOVERRIDE because the root declares the package as `rootSpec`. npm applies
// the key to the root's own edge whenever that spec admits the key's selector
// (or isn't a semver range at all), and then rejects the edge as overridden
// unless the pinned value is the identical string.
export function risksEoverride(key, bucket, rootSpec) {
  const selector = overrideKeySpec(key);
  if (rootSpec == null || selector == null) return false;
  if (semver.validRange(rootSpec) && semver.validRange(selector) && !semver.intersects(rootSpec, selector)) return false;
  return pinnedSpec(key, bucket) !== rootSpec;
}
