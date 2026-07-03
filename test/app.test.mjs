// Basic smoke test for the interactive app, driven through simulated
// keypresses via ink-testing-library. Hits the real npm registry, so it
// needs network access. Run with: node test/app.test.mjs
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/components/App.js';

const e = React.createElement;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

  await wait(4000);
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
  const { stdin, unmount } = render(
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
  await wait(2500);
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
  const { stdin, unmount } = render(
    e(App, { descriptors, onSubmit: (sel) => (submitted = sel), onAbort: () => {} })
  );
  await wait(3000);
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
    isDirect: true,
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
    isDirect: false,
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
  await wait(3500);
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
  await wait(3000);
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
  await wait(3000);
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

  await wait(3500);
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

  await wait(3500);
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
    isDirect: false,
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

  await wait(3500);
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
    isDirect: false,
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

  await wait(3500);
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

async function main() {
  await testBasicFlow();
  await testAbort();
  await testBulkLatest();
  await testAuditWarnings();
  await testAuditDisabled();
  await testOfflineNotice();
  await testOverrideFlow();
  await testScopedOverrideFlow();
  await testScopedOverrideDisambiguation();
  await testRemovableOverride();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

main();
