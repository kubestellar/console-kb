#!/usr/bin/env node

/**
 * generate-cncf-outreach-issues.mjs
 *
 * Generates parameterized GitHub issue bodies for filing in each CNCF project's
 * repository. Each issue links to the KubeStellar Console, the project's AI mission,
 * and an "Improve this AI Mission" call-to-action.
 *
 * Usage:
 *   node scripts/generate-cncf-outreach-issues.mjs [--project=NAME] [--dry-run] [--output=DIR]
 *
 * Options:
 *   --project=NAME   Generate only for a specific project
 *   --dry-run        Print issues without writing files
 *   --output=DIR     Output directory (default: outreach-issues/)
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { CNCF_PROJECTS } from './cncf-projects.mjs'
import { runOutreachGenerator } from './lib/outreach-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_FIXES_DIR = join(__dirname, '..', 'fixes', 'cncf-install')

export { runOutreachGenerator }

/**
 * CLI entrypoint, exported for in-process testing.
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {Object} [overrides={}]
 * @returns {number} POSIX exit code
 */
export function runCli(argv = process.argv.slice(2), overrides = {}) {
  const result = runOutreachGenerator({
    argv,
    projects: CNCF_PROJECTS,
    env: process.env,
    fs: { existsSync, mkdirSync, writeFileSync },
    out: console,
    fixesDir: DEFAULT_FIXES_DIR,
    ...overrides,
  })
  return result.exitCode
}

const isMainModule = Boolean(
  process.argv[1] && (
    import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  )
)

if (isMainModule) {
  process.exit(runCli())
}

