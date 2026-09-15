/**
 * render-ci-step-summary-runcli.test.mjs
 *
 * The sibling render-ci-step-summary-cli.test.mjs already exercises the
 * CLI wiring end-to-end via `spawnSync`, but v8 does not attribute
 * subprocess coverage back to the parent process, so `main()` /
 * `runCli()` and the `readStdin()` stream-event callbacks still read as
 * uncovered (baseline 76.31% lines, 44.44% functions).
 *
 * This file drives the exported `runCli({stdout, readStdin})` in-process
 * so those branches are actually measured — same rollout pattern used
 * for fuzz-mission-scanner (#3399), fuzz-json-fixtures (#3400), and
 * render-step-summary (#3401) under console-kb#3398.
 */
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { runCli } from '../render-ci-step-summary.mjs'

function makeStdoutSink() {
  const chunks = []
  return { chunks, fn: (s) => chunks.push(String(s)) }
}

describe('render-ci-step-summary runCli', () => {
  it('renders a schema-validation summary from the injected readStdin (exit 0)', async () => {
    const out = makeStdoutSink()
    const input = JSON.stringify({
      event: 'schema-validation-summary',
      level: 'info',
      trigger: 'changed-files',
      total: 1,
      validCount: 1,
      invalidCount: 0,
      durationMs: 12,
    }) + '\n'

    const code = await runCli({
      stdout: out.fn,
      readStdin: async () => input,
    })

    expect(code).toBe(0)
    const output = out.chunks.join('')
    expect(output).toContain('| Trigger | changed-files |')
    expect(output).toContain('| Total files | 1 |')
    expect(output).toContain('| Result | ✅ info |')
  })

  it('renders a kb-quality-ci-summary from the injected readStdin', async () => {
    const out = makeStdoutSink()
    const input = JSON.stringify({
      event: 'kb-quality-ci-summary',
      total: 3,
      passed: 2,
      failed: 1,
    })

    const code = await runCli({
      stdout: out.fn,
      readStdin: async () => input,
    })

    expect(code).toBe(0)
    const output = out.chunks.join('')
    expect(output).toContain('| Total files | 3 |')
    expect(output).toContain('| Result | ❌ fail |')
  })

  it('emits the neutral placeholder line when readStdin returns no known event (exit 0)', async () => {
    const out = makeStdoutSink()

    const code = await runCli({
      stdout: out.fn,
      readStdin: async () => 'plain log line\nnot json\n',
    })

    expect(code).toBe(0)
    expect(out.chunks.join('')).toContain('No structured CI summary line found')
  })

  it('emits the neutral placeholder line when readStdin returns empty input (if: always() safety)', async () => {
    const out = makeStdoutSink()

    const code = await runCli({
      stdout: out.fn,
      readStdin: async () => '',
    })

    expect(code).toBe(0)
    expect(out.chunks.join('')).toContain('No structured CI summary line found')
  })

  it('default readStdin: concatenates chunked stdin data before parsing', async () => {
    // Directly drive the default readStdin() by replacing process.stdin
    // with a PassThrough for one run, then restoring it. This is the
    // only path that actually exercises the `data`/`end` event handlers
    // in-process.
    const originalStdin = process.stdin
    const fake = new PassThrough()
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true })
    try {
      const out = makeStdoutSink()
      const runPromise = runCli({ stdout: out.fn })

      const half1 = '{"event":"schema-validation-summary",'
      const half2 = '"level":"info","trigger":"all","total":2,"validCount":2,"invalidCount":0,"durationMs":7}'
      fake.write(half1)
      fake.write(half2 + '\n')
      fake.end()

      const code = await runPromise
      expect(code).toBe(0)
      const output = out.chunks.join('')
      expect(output).toContain('| Total files | 2 |')
      expect(output).toContain('| Result | ✅ info |')
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
    }
  })
})
