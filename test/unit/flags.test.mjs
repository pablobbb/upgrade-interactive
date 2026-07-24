import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveToggle, resolveToggles, TOGGLES } from '../../src/flags.js';

const specs = Object.entries(TOGGLES); // [ ['install', {onFlag,...}], ... ]

// ---------------------------------------------------------------------------
// resolveToggle — run the same precedence suite against EVERY toggle spec, so
// --install / --audit / --section are all proven to behave identically.
// ---------------------------------------------------------------------------
for (const [name, spec] of specs) {
  const toggle = (args, env = {}, config = null) =>
    resolveToggle({ args, env, config, ...spec });

  test(`resolveToggle (${name}) — precedence`, async (t) => {
    await t.test('defaults to true with no signals', () => {
      assert.equal(toggle([]), true);
    });

    await t.test(`${spec.onFlag} returns true`, () => {
      assert.equal(toggle([spec.onFlag]), true);
    });

    await t.test(`${spec.offFlag} returns false`, () => {
      assert.equal(toggle([spec.offFlag]), false);
    });

    await t.test('off-flag wins when both flags are present', () => {
      assert.equal(toggle([spec.onFlag, spec.offFlag]), false);
    });

    await t.test('on-flag overrides an env var that would disable it', () => {
      assert.equal(toggle([spec.onFlag], { [spec.envVar]: '0' }), true);
    });

    await t.test('off-flag overrides an env var that would enable it', () => {
      assert.equal(toggle([spec.offFlag], { [spec.envVar]: '1' }), false);
    });

    await t.test('on-flag overrides a config value that would disable it', () => {
      assert.equal(toggle([spec.onFlag], {}, { [spec.configKey]: false }), true);
    });
  });

  test(`resolveToggle (${name}) — environment variable`, async (t) => {
    for (const falsey of ['0', 'false', 'no', 'off', 'FALSE', 'Off', ' no ']) {
      await t.test(`${spec.envVar}=${JSON.stringify(falsey)} disables`, () => {
        assert.equal(toggle([], { [spec.envVar]: falsey }), false);
      });
    }

    for (const truthy of ['1', 'true', 'yes', 'on', 'anything']) {
      await t.test(`${spec.envVar}=${JSON.stringify(truthy)} enables`, () => {
        assert.equal(toggle([], { [spec.envVar]: truthy }), true);
      });
    }

    await t.test('empty-string env var is ignored, falls through to config/default', () => {
      assert.equal(toggle([], { [spec.envVar]: '' }), true);
      assert.equal(toggle([], { [spec.envVar]: '' }, { [spec.configKey]: false }), false);
    });

    await t.test('whitespace-only env var counts as present and enables', () => {
      assert.equal(toggle([], { [spec.envVar]: '   ' }, { [spec.configKey]: false }), true);
    });

    await t.test('env var beats config', () => {
      assert.equal(toggle([], { [spec.envVar]: '0' }, { [spec.configKey]: true }), false);
      assert.equal(toggle([], { [spec.envVar]: '1' }, { [spec.configKey]: false }), true);
    });
  });

  test(`resolveToggle (${name}) — package.json config`, async (t) => {
    await t.test('config false disables', () => {
      assert.equal(toggle([], {}, { [spec.configKey]: false }), false);
    });

    await t.test('config true enables', () => {
      assert.equal(toggle([], {}, { [spec.configKey]: true }), true);
    });

    await t.test('non-boolean config is ignored, falls through to default', () => {
      assert.equal(toggle([], {}, { [spec.configKey]: 'yes' }), true);
      assert.equal(toggle([], {}, { [spec.configKey]: 0 }), true);
      assert.equal(toggle([], {}, {}), true);
    });
  });
}

// ---------------------------------------------------------------------------
// resolveToggles — the batch helper the CLI actually calls. Verifies every
// toggle is wired to its own flag / env var / config key with no cross-talk.
// ---------------------------------------------------------------------------
test('resolveToggles — wiring', async (t) => {
  await t.test('returns exactly the known toggles, all defaulting to true', () => {
    const out = resolveToggles({ args: [], env: {}, config: null });
    assert.deepEqual(out, { install: true, audit: true, section: true });
  });

  await t.test('each off-flag disables only its own toggle', () => {
    for (const [name, spec] of specs) {
      const out = resolveToggles({ args: [spec.offFlag], env: {}, config: null });
      for (const [other] of specs) {
        assert.equal(out[other], other !== name, `${spec.offFlag} should only affect ${name}`);
      }
    }
  });

  await t.test('each env var disables only its own toggle', () => {
    for (const [name, spec] of specs) {
      const out = resolveToggles({ args: [], env: { [spec.envVar]: '0' }, config: null });
      for (const [other] of specs) {
        assert.equal(out[other], other !== name, `${spec.envVar} should only affect ${name}`);
      }
    }
  });

  await t.test('each config key disables only its own toggle', () => {
    for (const [name, spec] of specs) {
      const out = resolveToggles({ args: [], env: {}, config: { [spec.configKey]: false } });
      for (const [other] of specs) {
        assert.equal(out[other], other !== name, `config.${spec.configKey} should only affect ${name}`);
      }
    }
  });

  await t.test('mixed sources resolve independently and per-toggle precedence holds', () => {
    const out = resolveToggles({
      args: ['--no-section'],                 // section off via flag
      env: { NUI_AUDIT: '0', NUI_INSTALL: '1' }, // audit off via env, install on via env
      config: { install: false, audit: true }, // overridden by the env vars above
    });
    assert.deepEqual(out, { install: true, audit: false, section: false });
  });
});
