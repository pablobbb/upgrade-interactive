#!/usr/bin/env node
// check-sensitive.mjs — keep secrets and personal data out of this public repo.
//
//   node scripts/check-sensitive.mjs                      # every tracked file, as it is on disk
//   node scripts/check-sensitive.mjs --history            # every commit on every ref
//   node scripts/check-sensitive.mjs --commits <rev…>     # those commits (the pre-push hook)
//
// For commits it reads the lines each one adds, its message, the paths it
// touches, and its author and committer emails. It exits 1 when it finds
// something, and masks what it found: on GitHub the CI log is public too, so
// printing a leak in full would publish it again.
//
// What it looks for:
// - secrets: private keys, npm/GitHub/AWS/Slack tokens, `_authToken`, bearer tokens;
// - personal data: email addresses outside an allowlist, home-directory and
//   machine temp paths, commit identities that aren't a noreply address;
// - infrastructure: lockfile `resolved` URLs off the public registry, private
//   hosts and IPs;
// - other projects' names (CLAUDE.md, "Never name other projects"): a capture
//   directory named anything but `<project>-nui-run-…`, and every term listed in
//   `.git/info/sensitive-terms` (one per line, `#` comments) or in the
//   NUI_SENSITIVE_TERMS environment variable (comma- or newline-separated).
//   `.git/info/` never leaves the machine, so the names never reach the repo.
//
// A line can opt out with the marker `sensitive-check: allow` on it, for an
// example that has to look like the real thing. Use it sparingly: it is visible.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ rule: string, line: number, shown: string }} Finding
 *   `shown` is already masked.
 * @typedef {{ id: string, re: RegExp, mask?: (match: string) => string, allow?: (match: string, line: string) => boolean }} Rule
 */

const ALLOW_MARKER = 'sensitive-check: allow';

// Addresses that are public by design: GitHub's noreply forms, the co-author
// trailer this repo's commits carry, and reserved example domains.
const ALLOWED_EMAIL = [
  /@users\.noreply\.github\.com$/i,
  /^noreply@github\.com$/i,
  /^noreply@anthropic\.com$/i,
  /^git@github\.com$/i,
  /@example\.(?:com|org|net)$/i,
  /\.(?:example|invalid|test)$/i,
];

/** @param {string} s */
export function mask(s) {
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}…(${s.length} chars)`;
}

/** @param {string} email */
export function allowedEmail(email) {
  return ALLOWED_EMAIL.some((re) => re.test(email));
}

/** @type {Rule[]} */
export const RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'npm-auth', re: /_auth(?:Token)?\s*=\s*\S+/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    id: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    // npm copies a package's deprecation notice into the lockfile verbatim, and a
    // fixture's lockfile must stay npm's own output; those carry a maintainer's public contact.
    allow: (m, line) => allowedEmail(m) || /^\s*"deprecated":/.test(line),
    mask: (m) => {
      const [user, domain] = m.split('@');
      return `${mask(user)}@${domain}`;
    },
  },
  {
    // A placeholder like `/Users/<you>/` or `/home/$USER/` is fine, and so is the
    // CI runner's home.
    id: 'home-path',
    re: /(?:\/Users|\/home)\/(?![<$]|runner\/)[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\(?![<%])[A-Za-z0-9._-]+\\/g,
    mask: (m) => m.replace(/([/\\])([^/\\]+)([/\\])$/, (_, a, name, b) => `${a}${mask(name)}${b}`),
  },
  { id: 'machine-path', re: /\/private\/(?:tmp|var\/folders)\/[^\s'"`)]+|\/var\/folders\/[a-z0-9_]{2}\/[^\s'"`)]+/g },
  {
    id: 'private-registry',
    re: /"resolved":\s*"https?:\/\/[^"/]+|\bregistry\s*=\s*https?:\/\/[^\s/]+/g,
    allow: (m) => /registry\.npmjs\.org$/.test(m),
    mask: (m) => m.replace(/(https?:\/\/)(.+)$/, (_, scheme, host) => `${scheme}${mask(host)}`),
  },
  { id: 'private-host', re: /\bhttps?:\/\/[A-Za-z0-9.-]+\.(?:internal|corp|lan|intranet|local)\b/g },
  { id: 'private-ip', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b(?![.\d])/g },
  {
    // `<project>-nui-run-…` is the convention; anything else is a project's name.
    id: 'capture-name',
    re: /(?<![<\w-])[a-z0-9][a-z0-9._-]*-nui-run-\d{8}/gi,
    allow: (m) => /^project-nui-run-/i.test(m),
  },
];

/**
 * Terms that must never appear: other projects' names, kept outside the repo.
 * @param {string} root
 * @returns {string[]}
 */
export function loadTerms(root) {
  /** @type {string[]} */
  const terms = [];
  const file = path.join(root, '.git', 'info', 'sensitive-terms');
  if (existsSync(file)) terms.push(...readFileSync(file, 'utf8').split('\n'));
  if (process.env.NUI_SENSITIVE_TERMS) terms.push(...process.env.NUI_SENSITIVE_TERMS.split(/[,\n]/));
  return [...new Set(terms.map((t) => t.replace(/#.*$/, '').trim()).filter((t) => t.length > 0))];
}

/** @param {string} s */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every finding in `text`, line by line.
 * @param {string} text
 * @param {{ terms?: string[] }} [options]
 * @returns {Finding[]}
 */
export function scanText(text, { terms = [] } = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const termRes = terms.map((t) => new RegExp(`(?<![\\w-])${escape(t)}(?![\\w-])`, 'i'));
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      for (const m of line.matchAll(re)) {
        if (rule.allow && rule.allow(m[0], line)) continue;
        findings.push({ rule: rule.id, line: index + 1, shown: (rule.mask || mask)(m[0]) });
      }
    }
    for (const [i, re] of termRes.entries()) {
      if (re.test(line)) findings.push({ rule: 'listed-term', line: index + 1, shown: `term #${i + 1} of the local list` });
    }
  }
  return findings;
}

/**
 * A commit identity that would publish a personal address.
 * @param {string} email
 */
export function identityLeaks(email) {
  return email.length > 0 && !allowedEmail(email);
}

/** @param {string[]} args */
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });

const BINARY = /\.(?:png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|woff2?|ttf|otf)$/i;

/** @param {string} root */
function scanTracked(root) {
  /** @type {{ where: string, finding: Finding }[]} */
  const out = [];
  const terms = loadTerms(root);
  for (const file of git(['-C', root, 'ls-files', '-z']).split('\0').filter(Boolean)) {
    for (const finding of scanText(file, { terms })) out.push({ where: `${file} (path)`, finding });
    if (BINARY.test(file)) continue;
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    const content = readFileSync(full);
    if (content.includes(0)) continue;
    for (const finding of scanText(content.toString('utf8'), { terms })) out.push({ where: `${file}:${finding.line}`, finding });
  }
  return out;
}

/**
 * @param {string} root
 * @param {string[]} revs  rev-list arguments
 */
function scanCommits(root, revs) {
  /** @type {{ where: string, finding: Finding }[]} */
  const out = [];
  const terms = loadTerms(root);
  const SEP = '\u0001nui-commit\u0001';
  const log = git(['-C', root, 'log', '-p', '-U0', '--no-color', '--no-ext-diff', `--format=${SEP}%h%x00%ae%x00%ce%x00%B${SEP}`, ...revs]);
  const parts = log.split(SEP);
  for (let i = 1; i < parts.length; i += 2) {
    const [sha, author, committer, message] = parts[i].split('\0');
    const diff = parts[i + 1] || '';
    for (const [who, email] of [['author', author], ['committer', committer]]) {
      if (identityLeaks(email)) {
        out.push({ where: `${sha} (${who})`, finding: { rule: 'commit-identity', line: 0, shown: RULES.find((r) => r.id === 'email')?.mask?.(email) ?? mask(email) } });
      }
    }
    for (const finding of scanText(message, { terms })) out.push({ where: `${sha} (message)`, finding });
    let file = '?';
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        file = line.slice(4).replace(/^b\//, '');
        for (const finding of scanText(file, { terms })) out.push({ where: `${sha} ${file} (path)`, finding });
        continue;
      }
      if (!line.startsWith('+') || BINARY.test(file)) continue;
      for (const finding of scanText(line.slice(1), { terms })) out.push({ where: `${sha} ${file}`, finding });
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const root = git(['rev-parse', '--show-toplevel']).trim();
  let findings;
  let scope;
  if (args[0] === '--history') {
    findings = scanCommits(root, ['--all']);
    scope = 'every commit on every ref';
  } else if (args[0] === '--commits') {
    findings = scanCommits(root, args.slice(1));
    scope = 'the commits being pushed';
  } else if (args.length === 0) {
    findings = scanTracked(root);
    scope = 'every tracked file';
  } else {
    process.stderr.write('usage: check-sensitive.mjs [--history | --commits <rev-list args…>]\n');
    process.exit(2);
  }
  const terms = loadTerms(root).length;
  if (findings.length === 0) {
    process.stdout.write(`check-sensitive: nothing found in ${scope} (${terms} listed term${terms === 1 ? '' : 's'}).\n`);
    return;
  }
  process.stdout.write(`check-sensitive: ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${scope}:\n`);
  for (const { where, finding } of findings) process.stdout.write(`  ${where}  ${finding.rule}  ${finding.shown}\n`);
  process.stdout.write(
    '\nRemove them, or mark a line that must stay with "sensitive-check: allow".\n' +
      'Values are masked: run it locally and read the file to see them.\n'
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
