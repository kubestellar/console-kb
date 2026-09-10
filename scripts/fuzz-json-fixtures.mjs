#!/usr/bin/env node
/**
 * fuzz-json-fixtures.mjs
 *
 * Standalone extraction of the "Property-based testing for JSON schema"
 * step currently inlined as a `node --input-type=module <<'EOF' ... EOF`
 * heredoc in `.github/workflows/fuzz.yml`. Walks every `fixes/**` mission
 * fixture directory, attempts to `JSON.parse` each `.json` file, and emits
 * one bounded structured summary line via `scripts/lib/logger.mjs`'s
 * `summary()` helper (matching the pattern already used by
 * `validate-schema.mjs`'s `schema-validation-summary` event) in addition
 * to the existing human-readable console output.
 *
 * This is intentionally a STANDALONE, unit-tested script — it does not
 * modify `.github/workflows/fuzz.yml`. Creating/updating a workflow file
 * requires the GitHub App `workflows` permission, which this repo's
 * telemetry automation does not hold (see PR #3308 for the same
 * constraint). A maintainer with that permission can replace the inline
 * heredoc step with:
 *
 *   - name: Property-based testing for JSON schema
 *     run: node scripts/fuzz-json-fixtures.mjs
 *
 * No new dependency, no network calls, no exporter — only formats
 * already-computed local counts for the Actions step log / a future
 * $GITHUB_STEP_SUMMARY consumer.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './lib/logger.mjs'

const log = createLogger('fuzz-json-fixtures')

/** Fixture directories fuzzed for JSON parse errors. */
export const FIXES_DIRS = ['fixes/cncf-generated', 'fixes/cncf-install', 'fixes/llm-d', 'fixes/platform-install']

/**
 * Attempts to JSON.parse every `.json` file under each of `dirs`.
 * Returns `{ scanned, errors, errorFiles }`. Missing directories are
 * skipped silently (smaller checkouts may not include every fixture set).
 * Exported for unit testing; does not call process.exit or console.log.
 */
export function fuzzJsonFixtures(dirs = FIXES_DIRS) {
  let scanned = 0
  let errors = 0
  const errorFiles = []

  for (const dir of dirs) {
    let files
    try {
      files = readdirSync(dir, { recursive: true }).filter(file => file.endsWith('.json'))
    } catch {
      continue
    }
    for (const file of files) {
      scanned += 1
      try {
        JSON.parse(readFileSync(join(dir, file), 'utf-8'))
      } catch (error) {
        errors += 1
        errorFiles.push({ file: join(dir, file), message: error.message })
      }
    }
  }

  return { scanned, errors, errorFiles }
}

function main() {
  const startedAt = Date.now()
  const { scanned, errors, errorFiles } = fuzzJsonFixtures()

  for (const { file, message } of errorFiles) {
    console.error(`Parse error in ${file}:`, message)
  }

  const durationMs = Date.now() - startedAt

  log.summary('fuzz-json-fixtures-summary', {
    level: errors > 0 ? 'error' : 'info',
    scanned,
    errors,
    durationMs,
  })

  if (errors > 0) {
    console.error(`\nFuzzing found ${errors} JSON parsing errors`)
    process.exit(1)
  }

  console.log('✓ All JSON files parsed successfully')
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
