// Resolve paths against the repository root, which is three levels above this
// skill directory (.claude/skills/generate-screenshot/). Everything here is
// addressed that way so the scripts work from any cwd.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Absolute file: URL for a repo-relative path, ready to `import()`. */
export function repoPath(relative) {
  return pathToFileURL(path.join(ROOT, relative)).href;
}

/** Absolute filesystem path for a repo-relative path. */
export function repoFile(relative) {
  return path.join(ROOT, relative);
}
