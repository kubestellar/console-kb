#!/usr/bin/env node
/**
 * CLI entry point for the "Merge reports" step of
 * .github/workflows/cncf-install-gen.yml (see kubestellar/console-kb#3164).
 *
 * Prints the average quality score across all generated install missions in
 * fixes/cncf-install, or 0 if none have a recorded score. Missions with no
 * recorded score are excluded so the reported number reflects only missions
 * with a known score — see the `excludeZero` option in
 * `../lib/mission-quality-stats.mjs` and kubestellar/console-kb#3508 for the
 * semantic split against the platform-install variant.
 *
 * Exported helpers (`readMissionsFromDir`, `runCli`) are injected with
 * production defaults when invoked as a CLI and are tested in-process by
 * __tests__/install-gen-average-quality-score.test.mjs so v8 coverage
 * attributes their executed lines correctly — mirroring the refactor
 * `platform/average-quality-score.mjs` already received in #3587
 * (kubestellar/console-kb#3791).
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { averageQualityScore } from '../lib/mission-quality-stats.mjs'
import { createLogger } from '../lib/logger.mjs'

const DEFAULT_DIR = 'fixes/cncf-install'
const log = createLogger('install-gen-average-quality-score')

/**
 * Read and JSON-parse all non-`.gitkeep` `*.json` files from `dir`.
 * Files that fail to parse are treated as `{}` so a corrupt file cannot
 * produce NaN in the aggregate, but a structured warn is emitted first
 * (console-kb's createLogger convention) so a silently-dropped file isn't
 * invisible to CI log tooling.
 *
 * Exported for in-process unit testing.
 *
 * @param {object} options
 * @param {string} options.dir - directory to scan
 * @param {function(string):string[]} options.readdir - e.g. readdirSync
 * @param {function(string,string):string} options.readFile - e.g. readFileSync
 * @returns {object[]} parsed mission objects (empty array if none found)
 */
export function readMissionsFromDir({ dir, readdir, readFile }) {
  const files = readdir(dir).filter((f) => f.endsWith('.json') && f !== '.gitkeep')
  return files.map((f) => {
    try {
      return JSON.parse(readFile(join(dir, f), 'utf-8'))
    } catch (err) {
      log.warn('failed to parse mission file, treating as empty', {
        dir,
        file: f,
        error: err.message,
      })
      return {}
    }
  })
}

/**
 * CLI entry point, exported for in-process testing.
 * Injectables default to real fs and console so runtime behaviour is unchanged.
 *
 * @param {object} [options]
 * @param {string} [options.dir=DEFAULT_DIR]
 * @param {function} [options.readdir=readdirSync]
 * @param {function} [options.readFile=readFileSync]
 * @param {function} [options.stdout=console.log]
 * @returns {number} POSIX exit code (always 0)
 */
export function runCli({
  dir = DEFAULT_DIR,
  readdir = readdirSync,
  readFile = readFileSync,
  stdout = console.log,
} = {}) {
  const missions = readMissionsFromDir({ dir, readdir, readFile })
  stdout(averageQualityScore(missions, { excludeZero: true }))
  return 0
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runCli())
}
