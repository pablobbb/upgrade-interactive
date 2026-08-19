// Pure helpers for the CLI's post-submit output and project shape. Kept out of
// cli.js because that module runs `main()` on import — these need to be
// importable from tests without launching the tool.

import path from 'node:path';

import { TOGGLES } from './flags.js';
import { INFO, CHILD, BECOMES } from './icons.js';

/**
 * Does this project have manifests beyond the root? Derived from the descriptors
 * exactly as buildDisplayRows does, so a `workspaces` field that expands to
 * nothing can't print a "root" heading for a run whose TUI showed no workspace
 * header.
 */
export function isMonorepoProject(project) {
  return project.descriptors.some((d) => d.relPath !== '.' || d.workspace != null);
}

/**
 * Lockfile-style keys for the project's own manifests: "" for the root, plus one
 * per workspace. Lockfile keys are always POSIX, and so is `relPath` — see
 * `expandWorkspaces`, which normalizes it once at the source — so it is used
 * as-is.
 *
 * The audit needs this to tell a workspace apart from an ordinary `file:`
 * dependency: npm implements workspaces as file: links, so both appear in the
 * lockfile as a top-level relative-path entry and no path-shape test can
 * separate them.
 *
 * Reads `project.discovered`, not `project.workspaces`, so `--no-workspaces`
 * still gets the true tree — that flag scopes what the user edits, not what is
 * installed, and scoping it here would silently disable the cross-manifest
 * conflict check.
 *
 * `lockfileDir` is the directory whose package-lock.json will be read, and is
 * required: the keys are relative to *that* directory, so a discovery rooted
 * anywhere else (running under `--no-workspaces` from inside a workspace, where
 * the root manifest is that workspace's own) describes a different tree and must
 * not be used. Omitting it throws rather than defaulting, because the wrong
 * answer here is silent — it re-enables the very bug this argument prevents.
 */
export function manifestPathsOf(project, lockfileDir) {
  if (typeof lockfileDir !== 'string') {
    throw new TypeError('manifestPathsOf requires the directory the lockfile is read from');
  }
  const tree = project.discovered || [];
  const root = tree[0];
  if (!root || path.resolve(root.dir) !== path.resolve(lockfileDir)) return [''];
  return ['', ...tree.filter((w) => w.relPath !== '.').map((w) => w.relPath)];
}

/**
 * The note naming workspace manifests whose own `upgrade-interactive` block was
 * ignored, as a string, or '' when there is nothing to say.
 *
 * Config is read from the root manifest alone, and that rule is not a shortcut:
 * every toggle it holds describes the *run*, not a package. One run performs one
 * `npm install` (workspaces share the root lockfile), one audit (of one installed
 * tree) and one rendering, so a per-workspace value has nothing to apply to.
 * Resolving it from the nearest manifest instead would be worse — the run's scope
 * no longer depends on cwd, so its settings must not either, or the same repo
 * behaves differently depending on which directory you stand in.
 *
 * What the rule leaves behind is a file that used to matter and silently stopped,
 * which is worth naming even though nothing is broken. Only keys that would
 * actually have changed this run are reported: a workspace repeating a value the
 * run already resolved to — from the root block, an env var or a flag — lost
 * nothing, and reporting it would be noise.
 *
 * `--no-workspaces` loads a single manifest as the root, so this is silent there,
 * exactly as it is for a standalone project.
 */
export function formatIgnoredConfigNote(project, resolved = {}) {
  const ignored = [];
  for (const manifest of project.manifests || []) {
    if (manifest === project.root) continue;
    const config = manifest.json && manifest.json['upgrade-interactive'];
    if (!config || typeof config !== 'object') continue;
    const keys = Object.keys(TOGGLES).filter(
      (key) => typeof config[key] === 'boolean' && config[key] !== resolved[key]
    );
    if (keys.length === 0) continue;
    ignored.push({ relPath: manifest.relPath || '', keys });
  }
  if (ignored.length === 0) return '';

  // One manifest is the common case and gets the exact file to open; naming each
  // of several that way buries the keys, and the trailing clause already says
  // which file these are.
  const single = ignored.length === 1;
  const list = ignored
    .map((m) => `${single ? `${m.relPath}/package.json` : m.relPath} (${m.keys.join(', ')})`)
    .join(', ');
  return `${INFO} ignoring "upgrade-interactive" in ${list} — settings come from the root package.json\n`;
}

/**
 * The post-submit summary, as a string. Upgrades group by workspace (root first,
 * in the order applyProject wrote them), then by field. A standalone project has
 * a single (root) group and `isMonorepo` false, so it renders exactly the
 * pre-workspaces output: no workspace heading, field headers flush-left.
 */
export function formatSummary({ applied = [], overrides = [], removed = [], isMonorepo = false } = {}) {
  let out = '';
  const groups = new Map(); // label -> { dependencies: [], devDependencies: [] }
  for (const change of applied) {
    // A workspace may declare no `name` — npm accepts that and infers one from
    // the directory. Falling straight back to 'root' would file its upgrades
    // under a heading for a manifest they don't belong to, and the TUI's
    // WorkspaceHeader already shows the path in that case, so the two displays
    // would disagree within one run.
    const label = change.workspace || (change.relPath && change.relPath !== '.' ? change.relPath : 'root');
    if (!groups.has(label)) groups.set(label, { dependencies: [], devDependencies: [] });
    groups.get(label)[change.field].push(change);
  }
  const pad = isMonorepo ? '  ' : '';
  for (const [label, byField] of groups) {
    if (isMonorepo) out += `${label}\n`;
    for (const field of ['dependencies', 'devDependencies']) {
      if (byField[field].length === 0) continue;
      out += `${pad}${field}\n`;
      for (const change of byField[field]) {
        out += `${pad}  ${change.name}  ${change.from} ${BECOMES} ${change.to}\n`;
      }
    }
  }

  if (overrides.length > 0 || removed.length > 0) {
    out += 'overrides\n';
    for (const change of overrides) {
      const target = change.parent ? `${change.parent} ${CHILD} ${change.name}` : change.name;
      out += `  ${target}  ${BECOMES} ${change.to}\n`;
    }
    for (const change of removed) {
      out += `  ${change.name}  removed\n`;
    }
  }
  return out;
}
