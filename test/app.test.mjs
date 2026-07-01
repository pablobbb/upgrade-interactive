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

async function main() {
  await testBasicFlow();
  await testAbort();
  await testBulkLatest();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

main();
