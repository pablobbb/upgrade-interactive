// Unit tests for the pure version-diff colorizer and the Current/Range/Latest
// suggestion logic. The colorizer is pure; the suggestion tests inject the
// registry metadata lookup so they run fully offline.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { colorizeVersionDiff, fetchSuggestions } from '../../src/semver-suggest.js';

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

  it('colors only the prerelease segment when only the prerelease differs', () => {
    const spans = colorizeVersionDiff('1.2.3', '1.2.3-rc.1');

    assert.equal(colored(spans), '-rc.1');
  });
});

// A registry double: fetchPackageMeta returns the given { versions, distTags }
// regardless of package name.
function stubMeta(meta) {
  return { fetchPackageMeta: async () => meta };
}

const valueOf = (suggestions, key) => suggestions.find((s) => s.key === key)?.value ?? null;

describe('fetchSuggestions — compound ranges collapse to caret', () => {
  it('offers ^highest-in-range and ^latest for an AND range', async () => {
    const deps = stubMeta({ versions: ['1.0.0', '1.9.0', '2.5.0', '3.1.0'], distTags: { latest: '3.1.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '>=1.0.0 <2.0.0' }, deps);

    assert.ok(s, 'a compound-range package is no longer dropped');
    assert.equal(valueOf(s, 'range'), '^1.9.0', 'Range = highest version the range already allows, as a caret');
    assert.equal(valueOf(s, 'latest'), '^3.1.0', 'Latest = newest published, as a caret');
  });

  it('picks the highest branch of an OR range', async () => {
    const deps = stubMeta({ versions: ['1.5.0', '2.9.0', '3.1.0'], distTags: { latest: '3.1.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '1.x || 2.x' }, deps);

    assert.equal(valueOf(s, 'range'), '^2.9.0');
    assert.equal(valueOf(s, 'latest'), '^3.1.0');
  });

  it('resolves a hyphen range', async () => {
    const deps = stubMeta({ versions: ['1.0.0', '1.8.0', '2.0.0', '2.4.0'], distTags: { latest: '2.4.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '1.0.0 - 2.0.0' }, deps);

    assert.equal(valueOf(s, 'range'), '^2.0.0', 'highest version at or below the inclusive upper bound');
    assert.equal(valueOf(s, 'latest'), '^2.4.0');
  });

  it('suppresses Latest when it already falls inside the compound range', async () => {
    const deps = stubMeta({ versions: ['1.0.0', '3.1.0'], distTags: { latest: '3.1.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '>=1.0.0 <4.0.0' }, deps);

    assert.equal(valueOf(s, 'range'), '^3.1.0');
    assert.equal(valueOf(s, 'latest'), null, 'Latest equals the Range collapse, so it is not shown twice');
  });

  it('drops the package when the compound range is unparseable', async () => {
    const deps = stubMeta({ versions: ['1.0.0'], distTags: { latest: '1.0.0' } });

    assert.equal(await fetchSuggestions({ name: 'x', range: '>= not a range' }, deps), null);
  });

  it('still handles a simple caret range unchanged', async () => {
    const deps = stubMeta({ versions: ['4.0.0', '4.9.0', '5.0.0'], distTags: { latest: '5.0.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '^4.0.0' }, deps);

    assert.equal(valueOf(s, 'range'), '^4.9.0');
    assert.equal(valueOf(s, 'latest'), '^5.0.0');
  });

  it('skips protocol ranges (git/file/etc)', async () => {
    const deps = stubMeta({ versions: ['1.0.0'], distTags: { latest: '1.0.0' } });

    assert.equal(await fetchSuggestions({ name: 'x', range: 'file:../x' }, deps), null);
    assert.equal(await fetchSuggestions({ name: 'x', range: 'workspace:*' }, deps), null);
  });
});

describe('fetchSuggestions — simple ranges', () => {
  it('preserves a tilde modifier in both suggestions', async () => {
    const deps = stubMeta({ versions: ['4.0.0', '4.0.5', '4.9.0', '5.0.0'], distTags: { latest: '5.0.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '~4.0.0' }, deps);

    assert.equal(valueOf(s, 'range'), '~4.0.5', 'Range respects the tilde (patch-only) bound');
    assert.equal(valueOf(s, 'latest'), '~5.0.0', 'Latest keeps the original modifier style');
  });

  it('treats an exact pinned version as an implicit caret for the Range column', async () => {
    const deps = stubMeta({ versions: ['4.0.0', '4.9.0', '5.0.0'], distTags: { latest: '5.0.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '4.0.0' }, deps);

    assert.equal(valueOf(s, 'range'), '4.9.0', 'Range = newest same-major, still written as an exact pin');
    assert.equal(valueOf(s, 'latest'), '5.0.0');
  });

  it('keeps the caret modifier for a short ^major.minor range', async () => {
    const deps = stubMeta({ versions: ['1.2.0', '1.9.0', '2.0.0'], distTags: { latest: '2.0.0' } });

    const s = await fetchSuggestions({ name: 'x', range: '^1.2' }, deps);

    assert.equal(valueOf(s, 'range'), '^1.9.0');
    assert.equal(valueOf(s, 'latest'), '^2.0.0');
  });

  it('resolves a bare dist-tag range through the dist-tags map', async () => {
    const deps = stubMeta({ versions: ['1.0.0', '2.0.0-beta.1'], distTags: { latest: '1.0.0', beta: '2.0.0-beta.1' } });

    const s = await fetchSuggestions({ name: 'x', range: 'beta' }, deps);

    assert.equal(valueOf(s, 'range'), '2.0.0-beta.1', 'the tag itself resolves through dist-tags');
    assert.equal(valueOf(s, 'latest'), '1.0.0');
  });

  it('drops a package that is already fully up to date', async () => {
    const deps = stubMeta({ versions: ['4.9.0'], distTags: { latest: '4.9.0' } });

    assert.equal(await fetchSuggestions({ name: 'x', range: '^4.9.0' }, deps), null);
  });

  it('drops a package whose metadata cannot be fetched', async () => {
    const deps = { fetchPackageMeta: async () => null };

    assert.equal(await fetchSuggestions({ name: 'x', range: '^1.0.0' }, deps), null);
  });
});
