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
  assert(frame.includes('Dependencies') && frame.includes('Overrides'), 'section headers render');
  assert(frame.includes('minimist'), 'a transitive vulnerable package appears under Overrides');
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
  assert(!frame.includes('Overrides'), 'no Overrides section when audit is disabled');
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

async function main() {
  await testBasicFlow();
  await testAbort();
  await testBulkLatest();
  await testAuditWarnings();
  await testAuditDisabled();
  await testOfflineNotice();
  await testOverrideFlow();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

main();
