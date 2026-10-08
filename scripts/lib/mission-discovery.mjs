import { readdirSync } from 'fs';
import { join } from 'path';

/** Valid mission file extensions */
export const MISSION_EXTENSIONS = new Set(['.json', '.yaml', '.yml']);

/** Files to skip when discovering all missions */
export const SKIP_FILENAMES = new Set(['index.json']);

/**
 * Recursively discovers all mission files under the given directory.
 * Returns an array of relative file paths.
 *
 * Silently returns [] when `dir` does not exist. A --all scan enumerates
 * every configured mission root (fixes/, runbooks/, solutions/), and a
 * working tree that only carries one of them (e.g. a partial checkout, a
 * fresh clone of the scripts/ subpackage, or a temp-dir test that
 * populates only fixes/) must not crash the whole scan on ENOENT of the
 * other root.
 *
 * Previously duplicated byte-for-byte in scan-pr.mjs and
 * validate-schema.mjs, with this ENOENT guard present only in the
 * scan-pr.mjs copy — validate-schema.mjs's copy worked around the gap
 * only because its one caller happened to pre-filter with existsSync()
 * before the top-level call, never because the function itself was safe.
 */
export function discoverMissionFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return results;
    throw err;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverMissionFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = entry.name.substring(entry.name.lastIndexOf('.'));
      if (MISSION_EXTENSIONS.has(ext) && !SKIP_FILENAMES.has(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}
