#!/usr/bin/env node
/**
 * CLI entry point for the AVG_SCORE step of
 * .github/workflows/platform-install-gen.yml (see kubestellar/console-kb#3197).
 *
 * Prints the average quality score across all generated platform-install
 * missions in fixes/platform-install, or 0 if none have a recorded score.
 *
 * Exported helpers (`readMissionsFromDir`, `runCli`) are injected with
 * production defaults when invoked as a CLI and are tested in-process
 * by __tests__/platform-average-quality-score.test.mjs so v8 coverage
 * attributes their executed lines correctly (kubestellar/console-kb#3587).
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { averageQualityScore } from '../lib/mission-quality-stats.mjs'
import { createLogger } from '../lib/logger.mjs'

const DEFAULT_DIR = 'fixes/platform-install'
const log = createLogger('platform-average-quality-score')

/**
 * Read and JSON-parse all `platform-*.json` files from `dir`.
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
  const files = readdir(dir).filter((f) => f.startsWith('platform-') && f.endsWith('.json'))
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
  stdout(averageQualityScore(missions))
  return 0
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runCli())
}
