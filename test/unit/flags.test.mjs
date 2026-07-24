import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveToggle } from '../../src/flags.js';

// A toggle keyed like the real --install / NUI_INSTALL / config.install trio.
const toggle = (args, env = {}, config = null) =>
  resolveToggle({
    args,
    env,
    config,
    onFlag: '--install',
    offFlag: '--no-install',
    envVar: 'NUI_INSTALL',
    configKey: 'install',
  });

test('resolveToggle — precedence', async (t) => {
  await t.test('defaults to true with no signals', () => {
    assert.equal(toggle([]), true);
  });

  await t.test('--install returns true', () => {
    assert.equal(toggle(['--install']), true);
  });

  await t.test('--no-install returns false', () => {
    assert.equal(toggle(['--no-install']), false);
  });

  await t.test('off-flag wins when both flags are present', () => {
    assert.equal(toggle(['--install', '--no-install']), false);
  });

  await t.test('--install overrides an env var that would disable it', () => {
    assert.equal(toggle(['--install'], { NUI_INSTALL: '0' }), true);
  });

  await t.test('--no-install overrides an env var that would enable it', () => {
    assert.equal(toggle(['--no-install'], { NUI_INSTALL: '1' }), false);
  });

  await t.test('--install overrides a config value that would disable it', () => {
    assert.equal(toggle(['--install'], {}, { install: false }), true);
  });
});

test('resolveToggle — environment variable', async (t) => {
  for (const falsey of ['0', 'false', 'no', 'off', 'FALSE', 'Off', ' no ']) {
    await t.test(`NUI_INSTALL=${JSON.stringify(falsey)} disables`, () => {
      assert.equal(toggle([], { NUI_INSTALL: falsey }), false);
    });
  }

  for (const truthy of ['1', 'true', 'yes', 'on', 'anything']) {
    await t.test(`NUI_INSTALL=${JSON.stringify(truthy)} enables`, () => {
      assert.equal(toggle([], { NUI_INSTALL: truthy }), true);
    });
  }

  await t.test('empty-string env var is ignored, falls through to config/default', () => {
    assert.equal(toggle([], { NUI_INSTALL: '' }), true);
    assert.equal(toggle([], { NUI_INSTALL: '' }, { install: false }), false);
  });

  await t.test('whitespace-only env var counts as present and enables (trims to non-falsey)', () => {
    assert.equal(toggle([], { NUI_INSTALL: '   ' }, { install: false }), true);
  });

  await t.test('env var beats config', () => {
    assert.equal(toggle([], { NUI_INSTALL: '0' }, { install: true }), false);
    assert.equal(toggle([], { NUI_INSTALL: '1' }, { install: false }), true);
  });
});

test('resolveToggle — package.json config', async (t) => {
  await t.test('config false disables', () => {
    assert.equal(toggle([], {}, { install: false }), false);
  });

  await t.test('config true enables', () => {
    assert.equal(toggle([], {}, { install: true }), true);
  });

  await t.test('non-boolean config is ignored, falls through to default', () => {
    assert.equal(toggle([], {}, { install: 'yes' }), true);
    assert.equal(toggle([], {}, { install: 0 }), true);
    assert.equal(toggle([], {}, {}), true);
  });
});
