// The global override picker's warning, rendered. The field report that prompted
// it (2026-11-04, F3) lost its terminal output, so these pin what the user sees
// instead: the cost of a pin is on screen before <enter>, and follows the cursor.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { OverridePicker } from '../../src/components/OverridePicker.js';
import { vulnFixture } from '../typed-fixtures.mjs';

const e = React.createElement;
const SGR = /\u001B\[[0-9;]*m/g;
const DOWN = '\u001B[B';

/**
 * @param {string} name
 * @param {string[]} versions
 * @param {import('../../src/types.js').Vuln} vuln
 */
function picker(name, versions, vuln) {
  const instance = render(e(OverridePicker, { name, versions, vuln, onSelect: () => {}, onCancel: () => {} }));
  const frame = () => (instance.lastFrame() || '').replace(SGR, '');
  return { ...instance, frame };
}

// Send `key` until the frame shows its effect. Ink attaches its input handler
// after the first render, so a key written straight away can be lost; resending
// is safe for a move that clamps at the end of the list.
/**
 * @param {{ write: (data: string) => void }} stdin
 * @param {() => string} frame
 * @param {string} key
 * @param {(f: string) => boolean} predicate
 */
async function press(stdin, frame, key, predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate(frame()) && Date.now() < deadline) {
    stdin.write(key);
    await new Promise((r) => setTimeout(r, 10));
  }
  return frame();
}

// The field report's tree, cut to three dependents.
const minimatch = vulnFixture({
  advisories: [{ vulnerable_versions: '>=7.0.0 <11.0.1' }],
  instances: [
    { parentName: 'eslint-plugin-react', parentPath: 'node_modules/eslint-plugin-react', declaredRange: '^3.1.2', installedVersion: '3.1.5', vulnerable: false },
    { parentName: 'readdir-glob', parentPath: 'node_modules/readdir-glob', declaredRange: '^5.1.0', installedVersion: '5.1.9', vulnerable: false },
    { parentName: 'editorconfig', parentPath: 'node_modules/editorconfig', declaredRange: '~10.2.4', installedVersion: '10.2.5', vulnerable: true },
  ],
});

describe('OverridePicker — a pin past declared majors', () => {
  it('says which dependents leave their major, which are already safe, and the narrower key', () => {
    const { frame, unmount } = picker('minimatch', ['11.0.1', '11.0.4'], minimatch);
    const text = frame();
    unmount();

    assert.match(text, /▲ 11\.0\.1 is outside the declared major of 3 dependents, such as eslint-plugin-react \^3\.1\.2/);
    assert.match(text, /2 are already safe and would move too: eslint-plugin-react and readdir-glob/);
    assert.match(text, /To leave those alone, pin "minimatch@>=7" by hand instead \(README, Notes\)/);
  });

  // fast-uri in the field report: 3.1.9 is in range, 4.2.3 is not.
  it('follows the cursor', async () => {
    const fastUri = vulnFixture({
      advisories: [{ vulnerable_versions: '>=3.0.0 <3.1.9' }],
      instances: [{ parentName: 'ajv', parentPath: 'node_modules/ajv', declaredRange: '^3.0.1', installedVersion: '3.1.8', vulnerable: true }],
    });
    const { frame, stdin, unmount } = picker('fast-uri', ['3.1.9', '4.2.3'], fastUri);
    const before = frame();
    const after = await press(stdin, frame, DOWN, (f) => f.includes(`❯ 4.2.3`));
    unmount();

    assert.doesNotMatch(before, /outside the declared major/);
    assert.match(after, /▲ 4\.2\.3 is outside the declared major of 1 dependent: ajv \^3\.0\.1/);
    assert.doesNotMatch(after, /already safe/);
  });

  it('shows no warning when every dependent takes the version', () => {
    const qs = vulnFixture({
      advisories: [{ vulnerable_versions: '<=6.16.0' }],
      instances: [{ parentName: 'co-body', parentPath: 'node_modules/co-body', declaredRange: '^6.5.2', installedVersion: '6.16.0', vulnerable: true }],
    });
    const { frame, unmount } = picker('qs', ['6.16.1', '6.17.1'], qs);
    const text = frame();
    unmount();

    assert.doesNotMatch(text, /▲/);
  });
});
