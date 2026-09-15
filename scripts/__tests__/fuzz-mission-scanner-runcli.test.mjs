/**
 * fuzz-mission-scanner-runcli.test.mjs
 *
 * Covers the CLI entry point of `scripts/fuzz-mission-scanner.mjs` in-process.
 * The pure `fuzzMissionScanner` helper is already tested in
 * `fuzz-mission-scanner.test.mjs`; this file exercises `runCli` so the
 * summary emission, human-readable output, and success/failure exit-code
 * mapping are actually attributed by v8 (subprocess tests would not be —
 * see console-kb#3398 for the wider pattern).
 */
import { describe, it, expect } from 'vitest'

import { runCli } from '../fuzz-mission-scanner.mjs'

function makeStdout() {
  const lines = []
  return { lines, fn: (line) => lines.push(String(line)) }
}

// Fixed clock: startedAt=1000, second call=1042 → durationMs=42.
function makeClock(values) {
  let i = 0
  return () => values[i++] ?? values[values.length - 1]
}

describe('fuzz-mission-scanner runCli', () => {
  it('returns 0 when every malformed input is handled', () => {
    const { lines, fn } = makeStdout()
    const code = runCli({ stdout: fn, clock: makeClock([1000, 1042]) })
    expect(code).toBe(0)
  })

  it('writes the fuzzing banner and the handled/total tally to stdout', () => {
    const { lines, fn } = makeStdout()
    runCli({ stdout: fn, clock: makeClock([1000, 1042]) })
    expect(lines[0]).toBe('Fuzzing scanner with malformed inputs...')
    expect(lines.some(l => /✓ Handled \d+\/\d+ malformed inputs gracefully/.test(l))).toBe(true)
  })

  it('reports handled === total against the built-in MALFORMED_INPUTS set', async () => {
    const { MALFORMED_INPUTS } = await import('../fuzz-mission-scanner.mjs')
    const { lines, fn } = makeStdout()
    runCli({ stdout: fn, clock: makeClock([0, 1]) })
    const tally = lines.find(l => l.startsWith('✓ Handled'))
    expect(tally).toBe(
      `✓ Handled ${MALFORMED_INPUTS.length}/${MALFORMED_INPUTS.length} malformed inputs gracefully`
    )
  })

  it('emits exactly one fuzz-mission-scanner-summary summary line', () => {
    // logger.summary() writes directly to process.stdout.write, so patch that.
    const originalWrite = process.stdout.write.bind(process.stdout)
    const captured = []
    process.stdout.write = (chunk) => {
      captured.push(String(chunk))
      return true
    }
    try {
      runCli({ stdout: () => {}, clock: makeClock([1000, 1042]) })
    } finally {
      process.stdout.write = originalWrite
    }
    const summaries = captured
      .flatMap(line => line.split('\n'))
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(obj => obj && obj.event === 'fuzz-mission-scanner-summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      event: 'fuzz-mission-scanner-summary',
      level: 'info',
      durationMs: 42,
    })
    expect(summaries[0].handled).toBe(summaries[0].total)
    expect(summaries[0].total).toBeGreaterThan(0)
  })
})
