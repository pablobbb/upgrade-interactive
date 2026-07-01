// Unit tests for OSC 8 terminal hyperlinks and their plain-text fallback.
// The TTY branch is exercised by temporarily overriding process.stdout.isTTY.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hyperlink } from '../../src/links.js';

function withTTY(isTTY, fn) {
  const original = process.stdout.isTTY;
  process.stdout.isTTY = isTTY;
  try {
    return fn();
  } finally {
    process.stdout.isTTY = original;
  }
}

describe('hyperlink', () => {
  it('returns the text unchanged when no url is given', () => {
    assert.equal(hyperlink('lodash', null), 'lodash');
  });

  it('appends the url in parentheses when output is not a TTY', () => {
    withTTY(false, () => {
      assert.equal(hyperlink('CVE-1', 'https://example.com'), 'CVE-1 (https://example.com)');
    });
  });

  it('wraps the text in an escape sequence (not the fallback) when writing to a TTY', () => {
    withTTY(true, () => {
      const out = hyperlink('CVE-1', 'https://example.com');
      assert.ok(out.includes('https://example.com'));
      assert.ok(out.includes('CVE-1'));
      assert.notEqual(out, 'CVE-1 (https://example.com)');
    });
  });
});
