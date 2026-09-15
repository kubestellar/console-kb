/**
 * fuzz-json-fixtures-runcli.test.mjs
 *
 * Covers the CLI entry point of `scripts/fuzz-json-fixtures.mjs` in-process.
 * The pure `fuzzJsonFixtures` helper is already tested in
 * `fuzz-json-fixtures.test.mjs`; this file exercises `runCli` so the
 * summary emission, human-readable output, error printing, and
 * success/failure exit-code mapping are actually attributed by v8
 * (subprocess tests would not be — see console-kb#3398 for the wider
 * pattern, and PR #3399 for the sibling `fuzz-mission-scanner` rollout).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { runCli } from '../fuzz-json-fixtures.mjs'

function makeSink() {
  const lines = []
  return { lines, fn: (...args) => lines.push(args.map(String).join(' ')) }
}

// Fixed clock: first call = startedAt, second call = end.
function makeClock(values) {
  let i = 0
  return () => values[i++] ?? values[values.length - 1]
}

describe('fuzz-json-fixtures runCli', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fuzz-json-fixtures-runcli-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 0 and prints the success banner when every fixture parses', () => {
    const sub = join(dir, 'cncf-generated')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(sub, 'b.json'), JSON.stringify({ ok: true }))

    const out = makeSink()
    const err = makeSink()
    const code = runCli({
      dirs: [sub],
      stdout: out.fn,
      stderr: err.fn,
      clock: makeClock([1000, 1042]),
    })

    expect(code).toBe(0)
    expect(out.lines).toContain('✓ All JSON files parsed successfully')
    expect(err.lines).toEqual([])
  })

  it('returns 1, prints each parse error, and prints the error tally when a fixture is malformed', () => {
    const sub = join(dir, 'cncf-install')
    mkdirSync(sub)
    writeFileSync(join(sub, 'good.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(sub, 'bad.json'), '{not valid json')

    const out = makeSink()
    const err = makeSink()
    const code = runCli({
      dirs: [sub],
      stdout: out.fn,
      stderr: err.fn,
      clock: makeClock([2000, 2050]),
    })

    expect(code).toBe(1)
    // The success banner MUST NOT print when errors > 0.
    expect(out.lines).not.toContain('✓ All JSON files parsed successfully')
    // Each malformed fixture is reported with its path.
    expect(err.lines.some(l => l.includes('Parse error in') && l.includes('bad.json'))).toBe(true)
    // And the final "Fuzzing found N JSON parsing errors" tally is emitted.
    expect(err.lines.some(l => /Fuzzing found 1 JSON parsing errors/.test(l))).toBe(true)
  })

  it('emits exactly one fuzz-json-fixtures-summary summary line with the injected duration', () => {
    // logger.summary() writes directly to process.stdout.write, so patch that.
    const originalWrite = process.stdout.write.bind(process.stdout)
    const captured = []
    process.stdout.write = (chunk) => {
      captured.push(String(chunk))
      return true
    }
    try {
      runCli({
        dirs: [join(dir, 'missing-dir')],
        stdout: () => {},
        stderr: () => {},
        clock: makeClock([500, 542]),
      })
    } finally {
      process.stdout.write = originalWrite
    }
    const summaries = captured
      .flatMap(line => line.split('\n'))
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(obj => obj && obj.event === 'fuzz-json-fixtures-summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      event: 'fuzz-json-fixtures-summary',
      level: 'info',
      scanned: 0,
      errors: 0,
      durationMs: 42,
    })
  })

  it('marks the summary level as "error" when at least one fixture is malformed', () => {
    const sub = join(dir, 'llm-d')
    mkdirSync(sub)
    writeFileSync(join(sub, 'bad.json'), '{oops')

    const originalWrite = process.stdout.write.bind(process.stdout)
    const captured = []
    process.stdout.write = (chunk) => {
      captured.push(String(chunk))
      return true
    }
    try {
      runCli({
        dirs: [sub],
        stdout: () => {},
        stderr: () => {},
        clock: makeClock([0, 1]),
      })
    } finally {
      process.stdout.write = originalWrite
    }
    const summary = captured
      .flatMap(line => line.split('\n'))
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .find(obj => obj && obj.event === 'fuzz-json-fixtures-summary')
    expect(summary).toBeTruthy()
    expect(summary.level).toBe('error')
    expect(summary.errors).toBe(1)
    expect(summary.scanned).toBe(1)
  })
})
