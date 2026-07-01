// Minimal npm registry client.
// Uses the "abbreviated" metadata format (much smaller / faster than full docs).

const REGISTRY = 'https://registry.npmjs.org';
const cache = new Map();

function encodePackageName(name) {
  // Scoped packages (@scope/name) keep the slash un-encoded for the
  // registry.npmjs.org convention, everything else is encoded normally.
  if (name.startsWith('@')) {
    const [scope, pkg] = name.split('/');
    return `${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}`;
  }
  return encodeURIComponent(name);
}

/**
 * Fetch { versions: string[], distTags: Record<string,string> } for a package.
 * Returns null if the package can't be resolved (404, network error, etc).
 */
export async function fetchPackageMeta(name) {
  if (cache.has(name)) return cache.get(name);

  const promise = (async () => {
    try {
      const res = await fetch(`${REGISTRY}/${encodePackageName(name)}`, {
        headers: {
          Accept: 'application/vnd.npm.install-v1+json, application/json',
          'User-Agent': 'upgrade-interactive',
        },
      });
      if (!res.ok) return null;
      const json = await res.json();
      const versions = Object.keys(json.versions || {});
      const distTags = json['dist-tags'] || {};
      if (versions.length === 0) return null;
      return { versions, distTags };
    } catch {
      return null;
    }
  })();

  cache.set(name, promise);
  return promise;
}

/**
 * Look up known vulnerabilities for a set of installed versions via npm's bulk
 * advisories endpoint (the same one `npm audit` uses; no auth required).
 *
 * @param {Record<string, Iterable<string>>} versionsByName
 * @returns {Promise<{ ok: boolean, advisories: Map<string, object[]> }>}
 *   `advisories` maps package name -> advisory objects that affect at least one
 *   submitted version. `ok` is false when a network/HTTP error occurred, so
 *   callers can distinguish "no vulnerabilities" from "couldn't check".
 */
export async function fetchBulkAdvisories(versionsByName) {
  const names = Object.keys(versionsByName);
  const advisories = new Map();
  if (names.length === 0) return { ok: true, advisories };

  const CHUNK = 200;
  let ok = true;

  for (let i = 0; i < names.length; i += CHUNK) {
    const slice = names.slice(i, i + CHUNK);
    const body = {};
    for (const name of slice) body[name] = Array.from(versionsByName[name]);

    try {
      const res = await fetch(`${REGISTRY}/-/npm/v1/security/advisories/bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'upgrade-interactive',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        ok = false;
        continue;
      }
      const json = await res.json();
      for (const [name, list] of Object.entries(json || {})) {
        if (Array.isArray(list) && list.length > 0) advisories.set(name, list);
      }
    } catch {
      ok = false;
    }
  }

  return { ok, advisories };
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 * Calls `onEach(result, item, index)` as each one resolves (out of order).
 */
export async function mapWithConcurrency(items, limit, worker, onEach) {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      const result = await worker(item, index);
      if (onEach) onEach(result, item, index);
    }
  });
  await Promise.all(runners);
}
