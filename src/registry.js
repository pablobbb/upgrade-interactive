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
