#!/usr/bin/env node
// probe-audit.mjs — print the tool's audit verdicts for a project, without the TUI.
//
//   node scripts/probe-audit.mjs <project-dir> [pkg…] [--tool <checkout>]
//   node scripts/probe-audit.mjs <pre-project> --after <post-project>
//
// Makes the same calls cli.js and App.js make — loadProject, manifestPathsOf,
// computeVulnerabilities — so a capture can be re-read by any version of the
// tool: point `--tool` at another checkout (or a `git archive` of a tag) to see
// what that version decided. Names after the project limit the output to those
// packages. Needs network access for the registry and advisory endpoints.
//
// `--after` prints instead what the CLI says once the run's `npm install` is done:
// the pre project's audit, re-tested against the post project's lockfile, with
// the run's pins taken to be the overrides that differ between the two root
// manifests. Needs a checkout that has checkInstall.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
/** @param {string} flag */
const option = (flag) => {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  const [, value] = args.splice(at, 2);
  return value ?? '';
};
const tool = option('--tool') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const after = option('--after');
const [project, ...only] = args;
if (!project || !tool || after === '') {
  process.stderr.write('usage: probe-audit.mjs <project-dir> [pkg…] [--tool <checkout>] [--after <post-project>]\n');
  process.exit(1);
}

/** @param {string} file */
const imp = (file) => import(pathToFileURL(path.join(path.resolve(tool), 'src', file)).href);
const { loadProject } = await imp('package-file.js');
const { manifestPathsOf } = await imp('summary.js');
const { loadInstalledVersions } = await imp('lockfile.js');
const { computeVulnerabilities } = await imp('vulnerabilities.js');
const select = await imp('override-select.js');

const proj = await loadProject(path.resolve(project), { workspaces: true, filter: null });
const rootDir = path.dirname(proj.root.filePath);
const manifestPaths = manifestPathsOf(proj, rootDir);
const installed = await loadInstalledVersions(rootDir);
const overrides = proj.root.json.overrides || {};
const result = await computeVulnerabilities({ descriptors: proj.descriptors, installed, overrides, manifestPaths });

if (after) {
  const { checkInstall } = await imp('vulnerabilities.js');
  const { formatInstallCheck } = await imp('summary.js');
  const post = await loadProject(path.resolve(after), { workspaces: true, filter: null });
  const postInstalled = await loadInstalledVersions(path.dirname(post.root.filePath));
  const before = overrides;
  const now = post.root.json.overrides || {};
  // The writer's shape: a string or "." is a top-level pin, a child a scoped one.
  const pins = [];
  for (const [key, value] of Object.entries(now)) {
    const was = before[key];
    if (typeof value === 'string') {
      if (value !== was) pins.push({ name: key, to: value });
      continue;
    }
    for (const [child, pin] of Object.entries(value || {})) {
      if (typeof pin !== 'string') continue;
      const prior = was && typeof was === 'object' ? was[child] : child === '.' ? was : undefined;
      if (pin === prior) continue;
      pins.push(child === '.' ? { name: key, to: pin } : { name: child, to: pin, parent: key });
    }
  }
  const check = checkInstall(postInstalled && postInstalled.packages, now, pins, result.vulns);
  process.stdout.write(`pins this run: ${pins.length}\n\n${formatInstallCheck(check) || '(nothing to report)\n'}`);
  process.exit(0);
}

const out = [];
const short = (p) => p.replace(/node_modules\//g, '') || '<root>';
out.push(`offline=${result.offline} manifests=${manifestPaths.length} descriptors=${proj.descriptors.length} vulns=${result.vulns.size}`);
for (const [name, v] of [...result.vulns].sort(([a], [b]) => a.localeCompare(b))) {
  if (only.length > 0 && !only.includes(name)) continue;
  const instances = v.instances || [];
  out.push('');
  out.push(
    `${name}  ${v.severity}  ${v.current} → ${v.firstPatched ?? '?'}  strategy=${v.pinStrategy}` +
      ` blocked=${select.isPinBlocked(v)} scoped=${select.shouldScope(v)} inRangeFix=${v.inRangeFix}` +
      ` heldBy=${JSON.stringify(v.heldBy)}`
  );
  out.push(`  safeVersions: ${(v.safeVersions || []).join(' ') || '(none)'}`);
  out.push(`  o stages: ${JSON.stringify(select.defaultOverrideSelection(v))}`);
  for (const i of instances) {
    out.push(
      `    ${i.vulnerable ? 'VULN' : 'safe'} ${i.parentName ?? '(direct)'}@${i.parentVersion ?? ''}` +
        ` [${short(i.parentPath)}] declares ${i.declaredRange}, has ${i.installedVersion}` +
        `, in-range safe: ${(i.safeCandidates || []).slice(-3).join(' ') || '-'}` +
        (i.pinRefusal ? `, refused: ${JSON.stringify(i.pinRefusal)}` : '')
    );
  }
}
out.push('', 'Overrides not in effect:');
for (const [key, info] of result.unappliedOverrides) {
  for (const m of info.mandates) {
    out.push(`  ${key}: ${m.name} pinned ${m.mandated}; lockfile has ${m.found.map((f) => `${short(f.path)}@${f.installedVersion}`).join(', ')}`);
  }
}
out.push('Unused overrides:');
for (const [key, info] of result.removableOverrides) out.push(`  ${key}: ${info.pin} (${info.reason})`);
process.stdout.write(out.join('\n') + '\n');
