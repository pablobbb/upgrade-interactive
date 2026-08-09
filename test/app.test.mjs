// Basic smoke test for the interactive app, driven through simulated
// keypresses via ink-testing-library. Hits the real npm registry, so it
// needs network access. Run with: node test/app.test.mjs
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/components/App.js';
import { fetchSuggestions } from '../src/semver-suggest.js';

const e = React.createElement;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until `predicate(lastFrame())` holds. The suggestion fetches hit the real
// registry, so a fixed sleep is a bet on latency: too short and the assertion
// races the network (this file's historical flakiness), too long and every run
// pays for the worst case. Returns as soon as the frame is ready.
async function waitForFrame(lastFrame, predicate, { timeout = 15000, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const frame = lastFrame();
    if (frame && predicate(frame)) return frame;
    if (Date.now() > deadline) {
      console.error(`TIMEOUT after ${timeout}ms waiting for ${label || 'frame condition'}`);
      return lastFrame();
    }
    await wait(50);
  }
}

// The rows are loaded once no Loading… placeholder remains. Used wherever a test
// previously slept ~3s hoping the registry had answered.
const rowsLoaded = (lastFrame, label) =>
  waitForFrame(lastFrame, (f) => !f.includes('Loading...'), { label: label || 'rows to load' });

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function testBasicFlow() {
  const descriptors = [
    { name: 'chalk', range: '^4.0.0', field: 'dependencies' },
    { name: 'eslint', range: '^7.0.0', field: 'devDependencies' },
    { name: 'left-pad', range: '1.3.0', field: 'dependencies' }, // no upgrade available
  ];

  let submitted = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      onSubmit: (sel) => {
        submitted = sel;
      },
      onAbort: () => {},
    })
  );

  await rowsLoaded(lastFrame, 'the dep list to finish loading');
  assert(!lastFrame().includes('left-pad'), 'package with no available upgrade is dropped from the list');

  stdin.write('\u001B[B'); // down -> eslint
  await wait(50);
  stdin.write('\u001B[C'); // right -> range
  await wait(50);
  stdin.write('\u001B[C'); // right -> latest
  await wait(50);
  stdin.write('\r'); // enter
  await wait(100);
  unmount();

  assert(submitted != null, 'enter submits a selection');
  assert(submitted && submitted.has('eslint'), 'right-arrow-selected package is included');
  assert(submitted && !submitted.has('chalk'), 'untouched package (left at Current) is excluded');
}

async function testAbort() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  let submitted = 'untouched';
  let aborted = false;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      onSubmit: (sel) => {
        submitted = sel;
      },
      onAbort: () => {
        aborted = true;
      },
    })
  );
  await rowsLoaded(lastFrame, 'the dep list to finish loading');
  stdin.write('\u0003'); // ctrl+c
  await wait(50);
  unmount();

  assert(aborted, 'ctrl+c triggers onAbort');
  assert(submitted === 'untouched', 'onSubmit is never called on abort');
}

async function testBulkLatest() {
  const descriptors = [
    { name: 'chalk', range: '^4.0.0', field: 'dependencies' },
    { name: 'eslint', range: '^7.0.0', field: 'devDependencies' },
  ];
  let submitted = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, { descriptors, onSubmit: (sel) => (submitted = sel), onAbort: () => {} })
  );
  await rowsLoaded(lastFrame, 'both packages to load');
  stdin.write('l');
  await wait(50);
  stdin.write('\r');
  await wait(100);
  unmount();

  assert(submitted && submitted.size === 2, "'l' selects the Latest column for every loaded package");
}

// Build a fake audit result so these tests don't hit the advisory network.
function fakeAudit() {
  const vulns = new Map();
  vulns.set('chalk', {
    advisories: [],
    severity: 'high',
    cve: 'CVE-2021-0001',
    url: 'https://github.com/advisories/GHSA-chalk',
    affectedRange: '<4.1.0',
    current: '4.0.0',
    firstPatched: '4.1.2',
    safeVersions: ['4.1.2', '5.0.0'],
  });
  vulns.set('minimist', {
    advisories: [],
    severity: 'critical',
    cve: 'CVE-2021-44906',
    url: 'https://github.com/advisories/GHSA-xvch',
    affectedRange: '<1.2.6',
    current: '1.2.0',
    firstPatched: '1.2.6',
    safeVersions: ['1.2.6', '1.2.8'],
  });
  return { offline: false, vulns };
}

async function testAuditWarnings() {
  const descriptors = [
    { name: 'chalk', range: '^4.0.0', field: 'dependencies' },
    { name: 'eslint', range: '^7.0.0', field: 'devDependencies' },
  ];
  const { lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => fakeAudit(),
      onSubmit: () => {},
      onAbort: () => {},
    })
  );
  await rowsLoaded(lastFrame, 'both packages to load');
  const frame = lastFrame();
  // Collapse wrapping: the plain-text URL fallback can wrap a long advisory
  // line (a real terminal hides the URL inside the OSC 8 escape, so it doesn't).
  const flat = frame.replace(/\s+/g, ' ');
  unmount();

  assert(frame.includes('⚠'), 'a vulnerable row shows a warning icon');
  assert(frame.includes('high'), 'severity label is rendered for a direct vuln');
  assert(frame.includes('critical'), 'severity label is rendered for a transitive vuln');
  assert(frame.includes('CVE-2021-0001'), 'the CVE id is shown');
  assert(flat.includes('fixed in 4.1.2'), 'the first fixed version is shown');
  assert(
    frame.includes('Dependencies') && frame.includes('Override to a safe version'),
    'section headers render'
  );
  assert(flat.includes('1.2.0 → 1.2.6'), 'a transitive vuln shows its current → fixed column pair');
  assert(frame.includes('minimist'), 'a transitive vulnerable package appears in the override section');
}

async function testAuditPendingLoading() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  // Gate the audit so it stays pending long enough to observe the placeholders,
  // then release it and confirm the sections resolve.
  let release;
  const gate = new Promise((r) => (release = r));
  const { lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      overrides: { 'left-pad': '1.3.0' },
      runAudit: async () => {
        await gate;
        return {
          offline: false,
          vulns: new Map(),
          removableOverrides: new Map([['left-pad', { pin: '1.3.0', reason: 'dead' }]]),
        };
      },
      onSubmit: () => {},
      onAbort: () => {},
    })
  );

  await waitForFrame(lastFrame, (f) => (f.match(/Loading\.\.\./g) || []).length <= 2, { label: 'the dep row to load' });
  const pending = lastFrame();
  assert(
    pending.includes('Override to a safe version') && pending.includes('Unused overrides'),
    'both audit section headers render while the audit is pending'
  );
  assert(
    (pending.match(/Loading\.\.\./g) || []).length >= 2,
    'each pending audit section shows a Loading… placeholder'
  );

  release();
  await wait(200);
  const resolved = lastFrame();
  unmount();

  assert(!resolved.includes('Loading...'), 'placeholders disappear once the audit resolves');
  assert(
    !resolved.includes('Override to a safe version'),
    'the vuln section drops out when the audit finds nothing'
  );
  assert(
    resolved.includes('Unused overrides') && resolved.includes('left-pad'),
    'the unused-override section fills in with the resolved row'
  );
}

async function testAuditDisabled() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  const { lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: false,
      section: false,
      runAudit: async () => fakeAudit(),
      onSubmit: () => {},
      onAbort: () => {},
    })
  );
  await rowsLoaded(lastFrame, 'chalk to load');
  const frame = lastFrame();
  unmount();

  assert(!frame.includes('⚠'), 'no warnings shown when audit is disabled');
  assert(!frame.includes('Override to a safe version'), 'no override section when audit is disabled');
}

async function testOfflineNotice() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  const { lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => ({ offline: true, vulns: new Map() }),
      onSubmit: () => {},
      onAbort: () => {},
    })
  );
  await rowsLoaded(lastFrame, 'chalk to load');
  const frame = lastFrame();
  unmount();

  assert(frame.includes('no network'), 'a failed audit shows the offline notice instead of pretending all-clear');
}

async function testOverrideFlow() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  let submitted = null;
  let overrides = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => fakeAudit(),
      onSubmit: (sel, ovr) => {
        submitted = sel;
        overrides = ovr;
      },
      onAbort: () => {},
    })
  );

  await rowsLoaded(lastFrame, 'chalk to load');
  stdin.write('o'); // open the override picker on the focused chalk row
  await wait(80);
  assert(lastFrame().includes('Override') && lastFrame().includes('4.1.2'), "'o' opens the override picker with safe versions");

  stdin.write('[B'); // down -> 5.0.0
  await wait(50);
  stdin.write('\r'); // select
  await wait(50);
  stdin.write('\r'); // submit
  await wait(100);
  unmount();

  assert(overrides && overrides.chalk === '5.0.0', 'selecting a version stages an overrides entry that is passed to onSubmit');
}

// A package whose audit result arrives before its own suggestions has no dep row
// yet, so it shows up in the shared "Override to a safe version" section
// instead. Staging from that row and then letting the suggestions land used to
// strand the override: the vuln row is filtered out for good once the entry
// loads, and the provenance guard then made `o` a no-op on every remaining row.
//
// The ordering *is* the test, so it holds the suggestion fetch open explicitly
// rather than betting that the registry is slower than the audit. Racing the
// live registry made this the flakiest test in the file — and, when the metadata
// cache happened to be warm, silently turned it into a test of the ordinary
// same-row flow.
async function testOverrideOriginRehomed() {
  const descriptors = [{ name: 'lodash', range: '^4.17.0', field: 'dependencies' }];
  const vulns = new Map();
  vulns.set('lodash', {
    advisories: [],
    severity: 'high',
    cve: 'CVE-2021-7777',
    url: 'https://github.com/advisories/GHSA-rehome',
    affectedRange: '<4.17.20',
    current: '4.17.15',
    firstPatched: '4.17.20',
    safeVersions: ['4.17.20', '4.17.21'],
  });

  let releaseSuggestions;
  const suggestionGate = new Promise((r) => (releaseSuggestions = r));

  let overrides = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => ({ offline: false, vulns }),
      // Real suggestion logic, stubbed registry metadata — only the network and
      // its timing are removed, not the behavior under test.
      loadSuggestions: async (descriptor) => {
        await suggestionGate;
        return fetchSuggestions(descriptor, {
          fetchPackageMeta: async () => ({
            versions: ['4.17.15', '4.17.21', '5.0.0'],
            distTags: { latest: '5.0.0' },
          }),
        });
      },
      onSubmit: (sel, ovr) => {
        overrides = ovr;
      },
      onAbort: () => {},
    })
  );

  await wait(80); // audit resolved; suggestions held open
  const pending = lastFrame();
  assert(
    pending.includes('Loading...') && pending.includes('Override to a safe version'),
    'a package whose suggestions are still loading appears in the shared override section'
  );

  stdin.write('o'); // stage from the vuln row
  await wait(80);
  stdin.write('\r'); // take the first safe version (4.17.20)
  await wait(50);

  releaseSuggestions(); // the vuln row is now replaced by a dep row
  await wait(150);
  const loaded = lastFrame().replace(/\s+/g, ' ');
  assert(!loaded.includes('already staged above'), 'the note pointing at the vanished origin row is gone');

  stdin.write('o'); // re-open from the dep row that now owns the override
  await wait(80);
  assert(
    lastFrame().includes('Override lodash to a safe version'),
    "'o' still opens the picker after the origin row disappeared"
  );

  stdin.write('\u001B[B'); // down -> 4.17.21
  await wait(50);
  stdin.write('\r'); // select
  await wait(50);
  stdin.write('\r'); // submit
  await wait(100);
  unmount();

  assert(overrides && overrides.lodash === '4.17.21', 'the re-homed override is editable and submits the new version');
}

async function testRemovableOverride() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  const removableOverrides = new Map([['left-pad', { pin: '1.3.0', reason: 'dead' }]]);
  let submitted = null;
  let removals = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => ({ offline: false, vulns: new Map(), removableOverrides }),
      onSubmit: (sel, ovr, rem) => {
        submitted = sel;
        removals = rem;
      },
      onAbort: () => {},
    })
  );

  await rowsLoaded(lastFrame, 'chalk to load');
  const frame = lastFrame();
  assert(frame.includes('left-pad') && frame.includes('not needed'), 'a no-longer-needed override is listed under Overrides');

  stdin.write('[B'); // down from chalk -> left-pad override row
  await wait(50);
  stdin.write('x'); // stage removal
  await wait(50);
  assert(lastFrame().includes('removing override'), "'x' stages the override for removal");
  stdin.write('\r'); // submit
  await wait(100);
  unmount();

  assert(removals && removals.includes('left-pad'), 'the removal is passed to onSubmit');
}

async function testScopedOverrideFlow() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  const vulns = new Map();
  vulns.set('dependency-a', {
    advisories: [],
    severity: 'high',
    cve: 'CVE-2021-9999',
    url: 'https://github.com/advisories/GHSA-scoped',
    affectedRange: '>=1.0.0 <1.3.0',
    current: '1.2.0',
    firstPatched: '1.3.0',
    safeVersions: ['1.3.0'],
    pinStrategy: 'scoped',
    instances: [
      {
        parentName: 'pkg-a',
        parentPath: 'node_modules/pkg-a',
        parentVersion: '1.0.0',
        declaredRange: '^1.2.0',
        installedVersion: '1.2.0',
        vulnerable: true,
        safeCandidates: ['1.3.0'],
        bestSafeInRange: '1.3.0',
      },
      {
        parentName: 'pkg-b',
        parentPath: 'node_modules/pkg-b/node_modules/dependency-a',
        parentVersion: '1.0.0',
        declaredRange: '^0.4.0',
        installedVersion: '0.4.0',
        vulnerable: false,
        safeCandidates: [],
        bestSafeInRange: null,
      },
    ],
  });

  let overrides = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => ({ offline: false, vulns }),
      onSubmit: (sel, ovr) => {
        overrides = ovr;
      },
      onAbort: () => {},
    })
  );

  await rowsLoaded(lastFrame, 'chalk to load');
  stdin.write('[B'); // down from chalk -> the dependency-a override row
  await wait(50);
  stdin.write('o'); // open the scoped picker
  await wait(80);
  const frame = lastFrame();
  assert(frame.includes('per dependent') && frame.includes('pkg-a'), "'o' opens the scoped picker listing dependents");
  assert(frame.includes('already safe'), 'the already-safe instance is shown as left alone');

  stdin.write('\r'); // apply the default pins
  await wait(50);
  stdin.write('\r'); // submit
  await wait(100);
  unmount();

  const spec = overrides && overrides['dependency-a'];
  assert(spec && Array.isArray(spec.scoped), 'a scoped override spec is staged and passed to onSubmit');
  assert(spec && spec.scoped.length === 1, 'only the vulnerable instance is pinned (the safe one is left out)');
  assert(
    spec && spec.scoped[0].parentName === 'pkg-a' && spec.scoped[0].version === '1.3.0',
    'the pin targets the vulnerable dependent at its in-range fix'
  );
}

async function testScopedOverrideDisambiguation() {
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  const vulns = new Map();
  vulns.set('dependency-a', {
    advisories: [],
    severity: 'high',
    cve: 'CVE-2021-8888',
    url: 'https://github.com/advisories/GHSA-dup',
    affectedRange: '<2.5.0',
    current: '2.4.0',
    firstPatched: '1.3.0',
    safeVersions: ['2.5.0'],
    pinStrategy: 'scoped',
    // The same parent (pkg-a) is installed at two versions, each needing a
    // different in-range fix.
    instances: [
      {
        parentName: 'pkg-a',
        parentPath: 'node_modules/pkg-a',
        parentVersion: '1.0.0',
        declaredRange: '^1.2.0',
        installedVersion: '1.2.0',
        vulnerable: true,
        safeCandidates: ['1.3.0'],
        bestSafeInRange: '1.3.0',
      },
      {
        parentName: 'pkg-a',
        parentPath: 'node_modules/other/node_modules/pkg-a',
        parentVersion: '2.0.0',
        declaredRange: '^2.0.0',
        installedVersion: '2.4.0',
        vulnerable: true,
        safeCandidates: ['2.5.0'],
        bestSafeInRange: '2.5.0',
      },
    ],
  });

  let overrides = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => ({ offline: false, vulns }),
      onSubmit: (sel, ovr) => {
        overrides = ovr;
      },
      onAbort: () => {},
    })
  );

  await rowsLoaded(lastFrame, 'chalk to load');
  stdin.write('[B'); // down to the dependency-a override row
  await wait(50);
  stdin.write('o'); // open the scoped picker
  await wait(80);
  const frame = lastFrame();
  assert(
    frame.includes('pkg-a@1.0.0') && frame.includes('pkg-a@2.0.0'),
    'the picker version-qualifies a parent installed at multiple versions'
  );

  stdin.write('\r'); // apply
  await wait(50);
  stdin.write('\r'); // submit
  await wait(100);
  unmount();

  const spec = overrides && overrides['dependency-a'];
  assert(spec && spec.scoped.length === 2, 'both vulnerable copies of the duplicated parent are pinned');
  assert(
    spec && spec.scoped.every((p) => p.parentName === 'pkg-a' && p.parentVersion),
    'each staged pin carries its parent version for disambiguation'
  );
}

// Deterministic column shapes, so the assertions below don't depend on what the
// registry happens to publish today. `maxed` gets no Latest column (its range
// already reaches the newest version); `outdated` gets no Range column (it is
// already at the top of its range, and the only upgrade is a new major). Those
// are the two shapes where a column is missing from the end / the middle.
const COLUMN_SHAPES = {
  maxed: { versions: ['1.0.0', '1.4.0'], distTags: { latest: '1.4.0' } },
  outdated: { versions: ['1.0.0', '2.0.0'], distTags: { latest: '2.0.0' } },
};
const shapedSuggestions = (descriptor) =>
  fetchSuggestions(descriptor, { fetchPackageMeta: async (name) => COLUMN_SHAPES[name] });

async function testArrowStopsAtLastColumn() {
  const descriptors = [{ name: 'maxed', range: '^1.0.0', field: 'dependencies' }];
  let submitted = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      loadSuggestions: shapedSuggestions,
      onSubmit: (sel) => (submitted = sel),
      onAbort: () => {},
    })
  );
  await rowsLoaded(lastFrame, 'the no-Latest package to load');

  stdin.write('\u001B[C'); // right -> Range
  await wait(50);
  stdin.write('\u001B[C'); // right again -> there is no Latest to move to
  await wait(50);
  stdin.write('\r');
  await wait(100);
  unmount();

  assert(
    submitted && submitted.get('maxed') === '^1.4.0',
    'right-arrow past the last populated column keeps the Range selection'
  );
}

async function testBulkRangeSkipsMissingColumn() {
  const descriptors = [
    { name: 'maxed', range: '^1.0.0', field: 'dependencies' },
    { name: 'outdated', range: '^1.0.0', field: 'dependencies' },
  ];
  let submitted = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      loadSuggestions: shapedSuggestions,
      onSubmit: (sel) => (submitted = sel),
      onAbort: () => {},
    })
  );
  await rowsLoaded(lastFrame, 'both packages to load');

  stdin.write('r');
  await wait(50);
  // The marker itself is the bug: parked on an absent column it renders as a
  // bare ● in a blank cell, which reads as "this row is staged" while carrying
  // no version at all. Collapse the column padding to compare row by row.
  const marked = lastFrame().replace(/\s+/g, ' ');
  stdin.write('\r');
  await wait(100);
  unmount();

  assert(marked.includes('outdated ● ^1.0.0'), "'r' marks Current on a row that offers no Range");
  assert(
    !marked.includes('outdated ○ ^1.0.0'),
    "'r' must not leave the marker on the blank Range cell of a no-Range row"
  );
  assert(submitted && submitted.get('maxed') === '^1.4.0', "'r' selects Range where the package offers one");
  assert(
    submitted && !submitted.has('outdated'),
    "'r' leaves a package with no Range column on Current, rather than staging its major"
  );
}
// A vulnerable package with far more safe versions than the overlay can show at
// once — the shape that used to render straight past the bottom of the terminal.
function manyCandidatesAudit() {
  const safeVersions = Array.from({ length: 30 }, (_, i) => `1.${i + 10}.0`);
  const vulns = new Map();
  vulns.set('chalk', {
    advisories: [],
    severity: 'high',
    cve: 'CVE-2021-0001',
    url: 'https://github.com/advisories/GHSA-chalk',
    affectedRange: '<1.10.0',
    current: '1.0.0',
    firstPatched: safeVersions[0],
    safeVersions,
  });
  return { offline: false, vulns, safeVersions };
}

async function testOverridePickerScrolls() {
  const { safeVersions, ...audit } = manyCandidatesAudit();
  const last = safeVersions[safeVersions.length - 1];
  const descriptors = [{ name: 'chalk', range: '^4.0.0', field: 'dependencies' }];
  let overrides = null;
  const { stdin, lastFrame, unmount } = render(
    e(App, {
      descriptors,
      audit: true,
      section: true,
      runAudit: async () => audit,
      onSubmit: (sel, ovr) => (overrides = ovr),
      onAbort: () => {},
    })
  );

  await rowsLoaded(lastFrame, 'chalk to load');
  stdin.write('o');
  await waitForFrame(lastFrame, (f) => f.includes('to a safe version:'), { label: 'the picker to open' });

  const opened = lastFrame();
  assert(opened.includes('more below'), 'a candidate list taller than the overlay says how many are hidden');
  assert(!opened.includes(last), 'the far end of the list starts out off-window');

  // Walk to the bottom: the window must follow the cursor, not stay put. Press
  // and poll rather than sending a fixed count — a keypress landing mid-render
  // can be dropped, and ↓ clamps at the end, so extra presses are harmless.
  // Watch the *cursor*, not mere visibility: the window reveals the tail a few
  // keystrokes before the cursor gets there.
  const cursorOnLast = `❯ ${last}`;
  const deadline = Date.now() + 15000;
  while (!lastFrame().includes(cursorOnLast) && Date.now() < deadline) {
    stdin.write('\u001B[B');
    await wait(20);
  }
  const scrolled = lastFrame();

  assert(scrolled.includes(cursorOnLast), 'scrolling down puts the last candidate under the cursor');
  assert(scrolled.includes('more above'), 'and reports the candidates now scrolled off the top');

  stdin.write('\r'); // apply the version the window scrolled to
  await wait(50);
  stdin.write('\r'); // submit
  await wait(100);
  unmount();

  assert(overrides && overrides.chalk === last, 'the version selected at the bottom of the list is the one staged');
}

async function main() {
  await testBasicFlow();
  await testAbort();
  await testBulkLatest();
  await testArrowStopsAtLastColumn();
  await testBulkRangeSkipsMissingColumn();
  await testAuditWarnings();
  await testAuditPendingLoading();
  await testAuditDisabled();
  await testOfflineNotice();
  await testOverrideFlow();
  await testOverridePickerScrolls();
  await testScopedOverrideFlow();
  await testScopedOverrideDisambiguation();
  await testOverrideOriginRehomed();
  await testRemovableOverride();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

main();
