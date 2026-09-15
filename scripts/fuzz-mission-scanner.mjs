#!/usr/bin/env node
/**
 * fuzz-mission-scanner.mjs
 *
 * Standalone extraction of the "Fuzz mission scanner" step currently
 * inlined as a `node --input-type=module <<'EOF' ... EOF` heredoc in
 * `.github/workflows/fuzz.yml`. Exercises `scanMissionFile` from
 * `scripts/scanner.mjs` against a fixed set of malformed mission inputs
 * and emits one bounded structured summary line via
 * `scripts/lib/logger.mjs`'s `summary()` helper (matching the
 * `schema-validation-summary` pattern already used by
 * `validate-schema.mjs`) in addition to the existing human-readable
 * console output.
 *
 * This is intentionally a STANDALONE, unit-tested script — it does not
 * modify `.github/workflows/fuzz.yml`. Creating/updating a workflow file
 * requires the GitHub App `workflows` permission, which this repo's
 * telemetry automation does not hold (see PR #3308 for the same
 * constraint). A maintainer with that permission can replace the inline
 * heredoc step with:
 *
 *   - name: Fuzz mission scanner
 *     run: node scripts/fuzz-mission-scanner.mjs
 *
 * No new dependency, no network calls, no exporter — only formats
 * already-computed local counts for the Actions step log / a future
 * $GITHUB_STEP_SUMMARY consumer.
 */
import { scanMissionFile } from './scanner.mjs'
import { createLogger } from './lib/logger.mjs'

const log = createLogger('fuzz-mission-scanner')

/** Fixed, bounded set of malformed mission inputs exercised against the scanner. */
export const MALFORMED_INPUTS = [
  '{"version":"kc-mission-v1"}',
  '{"name":null}',
  '{"steps":[]}',
  `{"metadata":{"tags":["${'a'.repeat(1000)}"]}}`,
]

/**
 * Runs `scanMissionFile` against each of `inputs` and counts how many are
 * "handled gracefully" (an error result, or an invalid-schema result,
 * counts the same as any other completed scan — the scanner must not
 * throw). Returns `{ total, handled }`. Exported for unit testing; does
 * not call process.exit or console.log.
 */
export function fuzzMissionScanner(inputs = MALFORMED_INPUTS) {
  let handled = 0
  for (const input of inputs) {
    scanMissionFile(input)
    handled += 1
  }
  return { total: inputs.length, handled }
}

/**
 * In-process CLI entry point. Runs the fuzz suite, emits the same
 * human-readable console output and structured summary line as the
 * previous inline `main()`, and returns a POSIX exit code (0 = success,
 * 1 = at least one input caused the scanner to throw). Exported so
 * tests can drive the CLI path in-process; the tail `process.exit`
 * guard below is the only caller that turns the return value into
 * a real process exit code.
 *
 * `stdout`/`clock` are injectable so tests can capture console output
 * and produce a deterministic `durationMs`.
 */
export function runCli({
  stdout = console.log,
  clock = Date.now,
} = {}) {
  const startedAt = clock()
  stdout('Fuzzing scanner with malformed inputs...')

  const { total, handled } = fuzzMissionScanner()
  const durationMs = clock() - startedAt

  stdout(`✓ Handled ${handled}/${total} malformed inputs gracefully`)

  log.summary('fuzz-mission-scanner-summary', {
    level: handled === total ? 'info' : 'error',
    total,
    handled,
    durationMs,
  })

  return handled === total ? 0 : 1
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runCli())
}
