#!/usr/bin/env node
// probe-audit.mjs — print the tool's audit verdicts for a project, without the TUI.
//
//   node scripts/probe-audit.mjs <project-dir> [pkg…] [--tool <checkout>]
//
// Makes the same calls cli.js and App.js make — loadProject, manifestPathsOf,
// computeVulnerabilities — so a capture can be re-read by any version of the
// tool: point `--tool` at another checkout (or a `git archive` of a tag) to see
// what that version decided. Names after the project limit the output to those
// packages. Needs network access for the registry and advisory endpoints.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--tool');
const tool = at === -1 ? path.join(path.dirname(fileURLToPath(import.meta.url)), '..') : args[at + 1];
if (at !== -1) args.splice(at, 2);
const [project, ...only] = args;
if (!project || !tool) {
  process.stderr.write('usage: probe-audit.mjs <project-dir> [pkg…] [--tool <checkout>]\n');
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
