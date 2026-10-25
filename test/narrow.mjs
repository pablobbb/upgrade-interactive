// Assertions that also narrow a value's type to what the test expects of it.
//
// A test often relies on a lookup finding something, or on a spec being the
// per-dependent kind, and would crash on the next line if it weren't. These say
// so up front: a wrong expectation fails as an assertion, and the typecheck can
// follow the value from there.

import assert from 'node:assert/strict';

/** @import { OverrideSpec, ScopedSpec } from '../src/types.js' */

/**
 * The value, asserted to be neither null nor undefined.
 * @template T
 * @param {T | null | undefined} value
 * @param {string} [what]  named in the failure message
 * @returns {T}
 */
export function present(value, what = 'value') {
  assert.ok(value != null, `expected a ${what}, got ${value}`);
  return value;
}

/**
 * The spec, asserted to be the per-dependent (scoped) kind.
 * @param {OverrideSpec | null | undefined} spec
 * @returns {ScopedSpec}
 */
export function scopedOf(spec) {
  assert.ok(spec != null && typeof spec === 'object', `expected a scoped override spec, got ${JSON.stringify(spec)}`);
  return spec;
}
