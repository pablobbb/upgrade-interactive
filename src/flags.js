// Resolve a boolean toggle from flags > env var > package.json config > default(true).
// Precedence, highest first:
//   1. --no-<x> command-line flag  -> false
//   2. --<x> command-line flag     -> true
//   3. NUI_<X> environment variable (0/false/no/off = false, anything else = true)
//   4. package.json "upgrade-interactive" config boolean
//   5. default -> true
export function resolveToggle({ args, env, config, onFlag, offFlag, envVar, configKey }) {
  if (args.includes(offFlag)) return false;
  if (args.includes(onFlag)) return true;
  const envVal = env[envVar];
  if (envVal != null && envVal !== '') {
    return !/^(0|false|no|off)$/i.test(envVal.trim());
  }
  if (config && typeof config[configKey] === 'boolean') return config[configKey];
  return true;
}

// Every boolean toggle the CLI exposes, defined once so they all behave
// identically. The key is the name used in code; each spec is the flag / env
// var / config key it reads. Keeping these in one table is what guarantees
// --install, --audit and --section share the same precedence rules.
export const TOGGLES = {
  install: { onFlag: '--install', offFlag: '--no-install', envVar: 'NUI_INSTALL', configKey: 'install' },
  audit: { onFlag: '--audit', offFlag: '--no-audit', envVar: 'NUI_AUDIT', configKey: 'audit' },
  section: { onFlag: '--section', offFlag: '--no-section', envVar: 'NUI_SECTION', configKey: 'section' },
};

// Resolve all CLI toggles at once, e.g. { install, audit, section }.
export function resolveToggles({ args, env, config }) {
  const out = {};
  for (const [name, spec] of Object.entries(TOGGLES)) {
    out[name] = resolveToggle({ args, env, config, ...spec });
  }
  return out;
}

// Parse the workspace-scoping flags: `--no-workspaces` (root manifest only) and
// a repeatable `-w`/`--workspace <name>` filter (`-w=x` / `--workspace=x` too).
// Returns { workspaces: boolean, filter: string[] }.
export function parseWorkspaceOptions(args) {
  const workspaces = !args.includes('--no-workspaces');
  const filter = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-w' || a === '--workspace') {
      const val = args[i + 1];
      if (val && !val.startsWith('-')) {
        filter.push(val);
        i++;
      }
    } else if (a.startsWith('--workspace=')) {
      filter.push(a.slice('--workspace='.length));
    } else if (a.startsWith('-w=')) {
      filter.push(a.slice('-w='.length));
    }
  }
  return { workspaces, filter };
}
