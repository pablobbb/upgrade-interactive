import semver from 'semver';
import { fetchPackageMeta } from './registry.js';

// Same regex yarn uses to split a "simple" semver range into
// [modifier, major, .minor, .patch, -prerelease] groups.
const SIMPLE_SEMVER = /^((?:[\^~]|>=?)?)([0-9]+)(\.[0-9]+)(\.[0-9]+)((?:-\S+)?)$/;

// Ranges we can't safely resolve against the registry (git/file/link/workspace
// protocols, npm aliases, complex boolean ranges, dist-tags other than a bare
// tag name, etc). Yarn handles these through pluggable resolvers; we just skip them.
function isSimpleRange(range) {
  if (!range) return false;
  if (/^(git|github|gitlab|bitbucket|file|link|workspace|http|https|npm):/.test(range)) return false;
  // Reject compound ranges ("1.x || 2.x", "1.0.0 - 2.0.0", etc) and anything
  // with internal whitespace; those aren't resolvable by our simple scheme.
  if (/\s/.test(range)) return false;
  return true;
}

function getModifier(range) {
  const match = range.match(SIMPLE_SEMVER);
  if (match) return match[1];
  if (range.startsWith('^')) return '^';
  if (range.startsWith('~')) return '~';
  return '';
}

/** Re-apply the original range's modifier (^, ~, or exact) to a resolved version. */
function applyModifier(modifier, version) {
  return `${modifier}${version}`;
}

/**
 * Resolve the highest published version matching `targetRange` (a semver
 * range OR a dist-tag name like "latest"), then re-format it using the
 * original descriptor's modifier style. Mirrors yarn's fetchUpdatedDescriptor.
 */
function resolveAgainstMeta(meta, originalRange, targetRange) {
  const modifier = getModifier(originalRange);

  if (Object.prototype.hasOwnProperty.call(meta.distTags, targetRange)) {
    const version = meta.distTags[targetRange];
    if (!version) return null;
    return applyModifier(modifier, version);
  }

  const best = semver.maxSatisfying(meta.versions, targetRange, { includePrerelease: false });
  if (!best) return null;
  return applyModifier(modifier, best);
}

/**
 * Colorize the part of `to` that differs from `from`, segment by segment
 * (modifier / major / minor / patch / prerelease), exactly like yarn's
 * colorizeVersionDiff. Returns an array of { text, color } spans ready to
 * be rendered as a sequence of <Text color=...> chunks.
 */
export function colorizeVersionDiff(from, to) {
  if (from === to) return [{ text: to, color: null }];

  const matchedFrom = from.match(SIMPLE_SEMVER);
  const matchedTo = to.match(SIMPLE_SEMVER);
  if (!matchedFrom || !matchedTo) return [{ text: to, color: null }];

  const SEMVER_COLORS = ['gray', 'red', 'yellow', 'green', 'magenta'];
  let color = null;
  const spans = [];

  for (let t = 1; t < matchedTo.length; ++t) {
    const differs = matchedFrom[t] !== matchedTo[t];
    if (color !== null || differs) {
      if (color === null) color = SEMVER_COLORS[Math.min(t - 1, SEMVER_COLORS.length - 1)];
      spans.push({ text: matchedTo[t], color });
    } else {
      spans.push({ text: matchedTo[t], color: null });
    }
  }

  return spans;
}

/**
 * Compute the { label: 'current'|'range'|'latest', value, spans }[] suggestion
 * set for a single descriptor, or null if there's nothing to upgrade to
 * (mirrors yarn: a package with no viable Range/Latest suggestion is
 * dropped from the list entirely).
 */
export async function fetchSuggestions(descriptor) {
  const { name, range } = descriptor;
  if (!isSimpleRange(range)) return null;

  const meta = await fetchPackageMeta(name);
  if (!meta) return null;

  const referenceRange = semver.valid(range) ? `^${range}` : range;

  let rangeResolution = null;
  let latestResolution = null;
  try {
    rangeResolution = resolveAgainstMeta(meta, range, referenceRange);
  } catch {
    rangeResolution = null;
  }
  try {
    latestResolution = resolveAgainstMeta(meta, range, 'latest');
  } catch {
    latestResolution = null;
  }

  const suggestions = [
    { key: 'current', value: null, spans: [{ text: range, color: null }] },
    { key: 'range', value: null, spans: [] },
    { key: 'latest', value: null, spans: [] },
  ];

  if (rangeResolution && rangeResolution !== range) {
    suggestions[1] = { key: 'range', value: rangeResolution, spans: colorizeVersionDiff(range, rangeResolution) };
  }

  if (latestResolution && latestResolution !== rangeResolution && latestResolution !== range) {
    suggestions[2] = { key: 'latest', value: latestResolution, spans: colorizeVersionDiff(range, latestResolution) };
  }

  const usableCount = suggestions.filter((s) => s.spans.length > 0).length;
  if (usableCount <= 1) return null;

  return suggestions;
}
