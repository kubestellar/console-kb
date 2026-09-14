/**
 * render-ci-step-summary-cli.test.mjs
 *
 * The existing render-ci-step-summary.test.mjs exercises the exported
 * `renderSummary()` in-process. That leaves the tiny CLI wrapper —
 * `main()`, `readStdin()` and its three stream-event callbacks — as
 * dead-to-coverage (44.4% functions, 76.3% lines) even though it is
 * the entry point the workflows in render-ci-step-summary.mjs's file
 * header will call from `$GITHUB_STEP_SUMMARY`.
 *
 * These tests drive the script the same way CI does — spawn `node
 * render-ci-step-summary.mjs` and feed the mixed stdout to its stdin —
 * so a regression in the CLI wiring (wrong stdout encoding, missing
 * `end` handler, non-zero exit on empty input) trips a real test
 * rather than being caught by a workflow engineer at 2 AM.
 *
 * Mirrors the sibling render-step-summary.test.mjs's spawnSync pattern.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'render-ci-step-summary.mjs')

function runScript(input) {
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', input })
}

describe('render-ci-step-summary.mjs CLI', () => {
  it('reads mixed stdout from stdin and writes a schema-validation table to stdout', () => {
    const input = [
      '✅ fixes/foo.json: Valid kc-mission-v1',
      JSON.stringify({
        event: 'schema-validation-summary',
        level: 'info',
        trigger: 'changed-files',
        total: 1,
        validCount: 1,
        invalidCount: 0,
        durationMs: 12,
      }),
      '',
    ].join('\n')

    const result = runScript(input)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('| Trigger | changed-files |')
    expect(result.stdout).toContain('| Total files | 1 |')
    expect(result.stdout).toContain('| Result | ✅ info |')
  })

  it('renders a kb-quality-ci-summary from stdin', () => {
    const input = JSON.stringify({
      event: 'kb-quality-ci-summary',
      total: 3,
      passed: 3,
      failed: 0,
    })

    const result = runScript(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('| Total files | 3 |')
    expect(result.stdout).toContain('| Result | ✅ pass |')
  })

  it('exits 0 and emits the placeholder line when stdin has no known summary event', () => {
    const result = runScript('just a plain log line\nno json here\n')

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('No structured CI summary line found')
  })

  it('exits 0 and emits the placeholder line when stdin is empty (if: always() safety)', () => {
    const result = runScript('')

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('No structured CI summary line found')
  })

  it('accumulates stdin across chunk boundaries — multi-line input is parsed as one document', () => {
    // The three chunks below deliberately break the JSON summary line at
    // a non-newline point, which would only reassemble correctly if
    // readStdin() concatenates every 'data' event before parsing.
    const half1 = '{"event":"schema-validation-summary",'
    const half2 = '"level":"info","trigger":"all","total":2,"validCount":2,"invalidCount":0,"durationMs":7}'
    const input = `noise line 1\n${half1}${half2}\nnoise line 2\n`

    const result = runScript(input)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('| Total files | 2 |')
    expect(result.stdout).toContain('| Result | ✅ info |')
  })
})
