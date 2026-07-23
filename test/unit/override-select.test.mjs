// Unit tests for the default override-selection helper — the single source of
// truth the interactive pickers and the fixture harness share for "what does
// pressing `o` then <enter> stage?". Locking it down here keeps the pickers and
// the harness from silently drifting apart.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPinnableInstance,
  pinnableInstances,
  defaultScopedChoiceIndex,
  shouldScope,
  defaultOverrideSelection,
} from '../../src/override-select.js';

// A vuln instance as computeVulnerabilities emits it (only the fields the
// selector reads).
function instance({ parentName, parentVersion, vulnerable = true, safeCandidates = [] }) {
  return { parentName, parentVersion, vulnerable, safeCandidates };
}

describe('isPinnableInstance', () => {
  it('is true only for a vulnerable instance with an in-range safe candidate', () => {
    assert.equal(isPinnableInstance(instance({ vulnerable: true, safeCandidates: ['1.2.3'] })), true);
    assert.equal(isPinnableInstance(instance({ vulnerable: false, safeCandidates: ['1.2.3'] })), false);
    assert.equal(isPinnableInstance(instance({ vulnerable: true, safeCandidates: [] })), false);
  });

  it('is false for nullish or malformed instances', () => {
    assert.equal(isPinnableInstance(null), false);
    assert.equal(isPinnableInstance(undefined), false);
    assert.equal(isPinnableInstance({ vulnerable: true, safeCandidates: 'nope' }), false);
  });
});

describe('defaultScopedChoiceIndex', () => {
  it('points at the newest in-range safe version (last candidate)', () => {
    assert.equal(defaultScopedChoiceIndex({ safeCandidates: ['1.1.16', '1.1.17', '1.1.18'] }), 2);
    // Must equal what vulnerabilities.js records as bestSafeInRange for the same
    // list, so the picker default and the audit's summary agree.
    const safeCandidates = ['2.0.2', '2.1.2'];
    assert.equal(safeCandidates[defaultScopedChoiceIndex({ safeCandidates })], '2.1.2');
  });
});

describe('shouldScope', () => {
  it('scopes a multi-version package with at least one fixable instance', () => {
    const vuln = {
      pinStrategy: 'scoped',
      instances: [instance({ parentName: 'a', safeCandidates: ['1.1.16'] })],
    };
    assert.equal(shouldScope(vuln), true);
  });

  it('does not scope when the strategy is global', () => {
    const vuln = {
      pinStrategy: 'global',
      instances: [instance({ parentName: 'a', safeCandidates: ['1.1.16'] })],
    };
    assert.equal(shouldScope(vuln), false);
  });

  it('does not scope when no instance is pinnable', () => {
    const vuln = {
      pinStrategy: 'scoped',
      instances: [instance({ parentName: 'a', vulnerable: true, safeCandidates: [] })],
    };
    assert.equal(shouldScope(vuln), false);
  });
});

describe('defaultOverrideSelection', () => {
  it('returns a scoped spec pinning each fixable dependent to its newest safe version', () => {
    const vuln = {
      pinStrategy: 'scoped',
      instances: [
        instance({ parentName: 'minimatch', parentVersion: '3.1.5', safeCandidates: ['1.1.15', '1.1.16'] }),
        instance({ parentName: 'minimatch', parentVersion: '9.0.9', safeCandidates: ['2.0.2', '2.1.2'] }),
        // already-safe instance: not vulnerable, so it's left alone
        instance({ parentName: 'other', vulnerable: false, safeCandidates: ['9.9.9'] }),
      ],
    };
    assert.deepEqual(defaultOverrideSelection(vuln), {
      scoped: [
        { parentName: 'minimatch', parentVersion: '3.1.5', version: '1.1.16' },
        { parentName: 'minimatch', parentVersion: '9.0.9', version: '2.1.2' },
      ],
    });
  });

  it('returns the lowest safe version string for a global vuln', () => {
    const vuln = { pinStrategy: 'global', safeVersions: ['1.2.6', '1.2.7', '1.2.8'] };
    assert.equal(defaultOverrideSelection(vuln), '1.2.6');
  });

  it('returns null when there is no safe fix to offer', () => {
    assert.equal(defaultOverrideSelection({ pinStrategy: 'global', safeVersions: [] }), null);
    assert.equal(defaultOverrideSelection({ pinStrategy: 'global' }), null);
  });

  it('falls back to a global pin when a scoped vuln has no pinnable instance', () => {
    const vuln = {
      pinStrategy: 'scoped',
      instances: [instance({ parentName: 'a', vulnerable: true, safeCandidates: [] })],
      safeVersions: ['3.0.0', '3.0.1'],
    };
    assert.equal(defaultOverrideSelection(vuln), '3.0.0');
  });
});

describe('pinnableInstances', () => {
  it('keeps only the vulnerable, fixable instances and tolerates a missing list', () => {
    const vuln = {
      instances: [
        instance({ parentName: 'a', vulnerable: true, safeCandidates: ['1.0.0'] }),
        instance({ parentName: 'b', vulnerable: false, safeCandidates: ['1.0.0'] }),
      ],
    };
    assert.deepEqual(pinnableInstances(vuln).map((i) => i.parentName), ['a']);
    assert.deepEqual(pinnableInstances({}), []);
  });
});
