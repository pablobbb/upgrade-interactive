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
