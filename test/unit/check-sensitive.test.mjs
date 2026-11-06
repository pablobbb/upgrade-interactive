// The scanner the pre-push hook and CI run (scripts/check-sensitive.mjs).
//
// Every sample is assembled at runtime, so this file holds nothing the scanner
// would flag in itself.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, identityLeaks, mask } from '../../scripts/check-sensitive.mjs';

/** @param {string} text */
const rules = (text, terms = /** @type {string[]} */ ([])) => scanText(text, { terms }).map((f) => f.rule);
const at = '@';

describe('check-sensitive — secrets', () => {
  it('flags tokens and keys', () => {
    assert.deepEqual(rules(`token: ${'gh'}p_${'a'.repeat(36)}`), ['github-token']);
    assert.deepEqual(rules(`${'np'}m_${'B'.repeat(36)}`), ['npm-token']);
    assert.deepEqual(rules(`${'AK'}IA${'Q'.repeat(16)}`), ['aws-key']);
    assert.deepEqual(rules(`-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`), ['private-key']);
    assert.deepEqual(rules(`//registry.npmjs.org/:_auth${'Token'}=abc123`), ['npm-auth']);
  });

  it('leaves ordinary code alone', () => {
    assert.deepEqual(rules('const token = process.env.NPM_TOKEN; // read at runtime'), []);
  });
});

describe('check-sensitive — personal data', () => {
  it('flags an email address, masking who it belongs to', () => {
    const [finding] = scanText(`contact: someone${at}gmail.com`);

    assert.equal(finding.rule, 'email');
    assert.equal(finding.shown, `so…(7 chars)${at}gmail.com`);
  });

  it('allows noreply addresses, example domains and the ssh remote', () => {
    assert.deepEqual(rules(`Co-Authored-By: Claude <noreply${at}anthropic.com>`), []);
    assert.deepEqual(rules(`1234+someone${at}users.noreply.github.com and a${at}example.com`), []);
    assert.deepEqual(rules(`git${at}github.com:org/repo.git`), []);
  });

  it('allows a maintainer contact inside a lockfile deprecation notice', () => {
    assert.deepEqual(rules(`      "deprecated": "Old versions... by contacting i${at}example.me",`), []);
  });

  it("doesn't read a package spec as an address", () => {
    assert.deepEqual(rules('minimatch@>=7 and glob@13.0.6 and @acme/web@1.0.0'), []);
  });

  it('flags a home directory, keeping placeholders and the CI runner', () => {
    assert.deepEqual(rules(`npx ${'/Users'}/someone/Git/upgrade-interactive`), ['home-path']);
    assert.deepEqual(rules(`${'C:'}\\Users\\someone\\repo`), ['home-path']);
    assert.deepEqual(rules('npx /Users/<you>/Git/upgrade-interactive, /home/runner/work'), []);
  });

  it('flags a machine-specific temp path', () => {
    assert.deepEqual(rules(`see ${'/private'}/tmp/claude-501/scratchpad/x`), ['machine-path']);
  });

  it('flags a commit identity that is not a noreply address', () => {
    assert.equal(identityLeaks(`someone${at}gmail.com`), true);
    assert.equal(identityLeaks(`1234+someone${at}users.noreply.github.com`), false);
    assert.equal(identityLeaks(`noreply${at}github.com`), false);
  });
});

describe('check-sensitive — infrastructure', () => {
  it('flags a lockfile entry resolved off the public registry', () => {
    assert.deepEqual(rules(`"res${'olved'}": "https://npm.acme-corp.example/x/-/x-1.0.0.tgz"`), ['private-registry']);
    assert.deepEqual(rules('"resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz"'), []);
  });

  it('flags private hosts and addresses, not versions or ranges', () => {
    assert.deepEqual(rules(`see https://build.${'corp'}`), ['private-host']);
    assert.deepEqual(rules(`at ${'192.168'}.1.20`), ['private-ip']);
    assert.deepEqual(rules('version 10.2.6, range >=10.0.0 <10.2.3, minimatch@10.2.5'), []);
  });
});

describe("check-sensitive — other projects' names", () => {
  it('flags a capture directory named after a project, not the placeholder', () => {
    assert.deepEqual(rules(`in ${'acme-shop'}-nui-run-20261104/`), ['capture-name']);
    assert.deepEqual(rules('in <project>-nui-run-20261104/'), []);
  });

  it('flags a listed term as a whole word, without printing it', () => {
    const findings = scanText('ran against secret-thing today', { terms: ['secret-thing'] });

    assert.deepEqual(findings.map((f) => [f.rule, f.shown]), [['listed-term', 'term #1 of the local list']]);
    assert.deepEqual(rules('a secret-things list', ['secret-thing']), [], 'part of a longer word');
  });

  it('honours the allow marker', () => {
    assert.deepEqual(rules(`someone${at}gmail.com  // sensitive-check: allow`), []);
  });
});

describe('check-sensitive — mask', () => {
  it('keeps two characters and the length', () => {
    assert.equal(mask('abcdefgh'), 'ab…(8 chars)');
    assert.equal(mask('abc'), '***');
  });
});
