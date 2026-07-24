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
