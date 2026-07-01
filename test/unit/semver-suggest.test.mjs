// Unit tests for the pure version-diff colorizer. No I/O, no async.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { colorizeVersionDiff } from '../../src/semver-suggest.js';

// The colored text is what the eye is drawn to; collapse the spans down to it.
const colored = (spans) => spans.filter((s) => s.color).map((s) => s.text).join('');

describe('colorizeVersionDiff', () => {
  it('returns a single uncolored span when the versions are identical', () => {
    assert.deepEqual(colorizeVersionDiff('^1.2.3', '^1.2.3'), [{ text: '^1.2.3', color: null }]);
  });

  it('colors only the patch segment when only the patch differs', () => {
    const spans = colorizeVersionDiff('1.2.3', '1.2.4');

    assert.equal(colored(spans), '.4');
  });

  it('colors from the major segment onward when the major version differs', () => {
    const spans = colorizeVersionDiff('1.2.3', '2.0.0');

    assert.equal(colored(spans), '2.0.0');
  });

  it('falls back to a single uncolored span for non-simple versions', () => {
    assert.deepEqual(colorizeVersionDiff('1.0.0', 'git://example.com/repo'), [
      { text: 'git://example.com/repo', color: null },
    ]);
  });
});
