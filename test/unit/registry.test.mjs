// Unit tests for the npm registry client and the concurrency helper.
//
// Network access is faked at the `fetch` seam, so these run fully offline.
// Note: fetchPackageMeta caches per package name for the process lifetime, so
// every test uses a unique package name to stay independent of the others.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPackageMeta, fetchBulkAdvisories, mapWithConcurrency } from '../../src/registry.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replace global fetch with `handler(url, options, callNumber)`; returns the
// recorded calls for assertions.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return calls;
}

const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

// --- mapWithConcurrency --------------------------------------------------------

describe('mapWithConcurrency', () => {
  it('processes every item and reports each result with its item and index', async () => {
    const seen = [];

    await mapWithConcurrency([10, 20, 30], 2, async (n) => n * 2, (result, item, index) => {
      seen[index] = { result, item };
    });

    assert.deepEqual(seen, [
      { result: 20, item: 10 },
      { result: 40, item: 20 },
      { result: 60, item: 30 },
    ]);
  });

  it('never runs more workers than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
    });

    assert.equal(peak, 2);
  });

  it('resolves without calling the worker for an empty item list', async () => {
    let workerCalls = 0;

    await mapWithConcurrency([], 4, async () => {
      workerCalls++;
    });

    assert.equal(workerCalls, 0);
  });
});

// --- fetchPackageMeta ----------------------------------------------------------

describe('fetchPackageMeta', () => {
  it('returns the version list and dist-tags for a resolvable package', async () => {
    stubFetch(() =>
      jsonResponse({ versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } })
    );

    const meta = await fetchPackageMeta('meta-ok');

    assert.deepEqual(meta, { versions: ['1.0.0', '2.0.0'], distTags: { latest: '2.0.0' } });
  });

  it('returns null for an HTTP error (unknown package)', async () => {
    stubFetch(() => jsonResponse({}, false));

    assert.equal(await fetchPackageMeta('meta-404'), null);
  });

  it('returns null when the request throws (no network)', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    assert.equal(await fetchPackageMeta('meta-net-err'), null);
  });

  it('returns null for a package document with no versions', async () => {
    stubFetch(() => jsonResponse({ versions: {}, 'dist-tags': {} }));

    assert.equal(await fetchPackageMeta('meta-empty'), null);
  });

  it('fetches each package only once, serving repeats from the cache', async () => {
    const calls = stubFetch(() => jsonResponse({ versions: { '1.0.0': {} }, 'dist-tags': {} }));

    const first = await fetchPackageMeta('meta-cached');
    const second = await fetchPackageMeta('meta-cached');

    assert.equal(calls.length, 1);
    assert.deepEqual(second, first);
  });

  it('encodes a scoped package name but keeps the scope/name slash', async () => {
    const calls = stubFetch(() => jsonResponse({ versions: { '1.0.0': {} }, 'dist-tags': {} }));

    await fetchPackageMeta('@scope/meta-scoped');

    assert.ok(
      calls[0].url.endsWith('/%40scope/meta-scoped'),
      `url should keep the slash un-encoded, got ${calls[0].url}`
    );
  });
});

// --- fetchBulkAdvisories ---------------------------------------------------------

describe('fetchBulkAdvisories', () => {
  it('reports ok without any request when there is nothing to check', async () => {
    const calls = stubFetch(() => jsonResponse({}));

    const res = await fetchBulkAdvisories({});

    assert.equal(res.ok, true);
    assert.equal(res.advisories.size, 0);
    assert.equal(calls.length, 0);
  });

  it('POSTs the versions and keeps only packages that have advisories', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ 'bulk-vulnerable': [{ severity: 'high' }], 'bulk-clean': [] })
    );

    const res = await fetchBulkAdvisories({
      'bulk-vulnerable': ['1.0.0'],
      'bulk-clean': ['2.0.0'],
    });

    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      'bulk-vulnerable': ['1.0.0'],
      'bulk-clean': ['2.0.0'],
    });
    assert.equal(res.ok, true);
    assert.deepEqual([...res.advisories.keys()], ['bulk-vulnerable']);
  });

  it('splits more than 200 packages across multiple requests', async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const versionsByName = {};
    for (let i = 0; i < 201; i++) versionsByName[`chunk-${i}`] = ['1.0.0'];

    await fetchBulkAdvisories(versionsByName);

    assert.equal(calls.length, 2);
    assert.equal(Object.keys(JSON.parse(calls[0].options.body)).length, 200);
    assert.equal(Object.keys(JSON.parse(calls[1].options.body)).length, 1);
  });

  it('reports not-ok when a chunk fails but still returns advisories from the others', async () => {
    stubFetch((url, options, callNumber) =>
      callNumber === 1
        ? jsonResponse({}, false)
        : jsonResponse({ 'chunk-200': [{ severity: 'low' }] })
    );
    const versionsByName = {};
    for (let i = 0; i < 201; i++) versionsByName[`chunk-${i}`] = ['1.0.0'];

    const res = await fetchBulkAdvisories(versionsByName);

    assert.equal(res.ok, false, 'a failed chunk must not be silently treated as all-clear');
    assert.ok(res.advisories.has('chunk-200'), 'the successful chunk is still used');
  });

  it('reports not-ok when the request throws (no network)', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    const res = await fetchBulkAdvisories({ 'bulk-net-err': ['1.0.0'] });

    assert.equal(res.ok, false);
    assert.equal(res.advisories.size, 0);
  });
});
