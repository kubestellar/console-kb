/**
 * render-step-summary-runcli.test.mjs
 *
 * Covers the CLI entry point of `scripts/render-step-summary.mjs` in-process.
 * The pure helpers (findLastSummaryLine, renderMarkdownTable) and the CLI
 * end-to-end paths are already exercised by the sibling
 * `render-step-summary.test.mjs` — but those CLI cases go through
 * `spawnSync`, and v8 does not attribute subprocess coverage to the
 * parent process (see console-kb#3398, PRs #3399 and #3400 for the
 * fuzz-* siblings). This file drives the argv/stdin/log-file plumbing
 * in-process so those branches are actually measured.
 */
import { describe, it, expect } from 'vitest'
import { runCli } from '../render-step-summary.mjs'

function makeSink() {
  const lines = []
  return { lines, fn: (...args) => lines.push(args.map(String).join(' ')) }
}

describe('render-step-summary runCli', () => {
  it('renders a real summary from the injected log file path (exit 0)', () => {
    const out = makeSink()
    const err = makeSink()
    const code = runCli({
      argv: ['--event', 'kb-quality-ci-summary', '--title', 'KB Quality Enforcement Summary', '--log', '/dummy/path.log'],
      stdout: out.fn,
      stderr: err.fn,
      readFile: () => '{"event":"kb-quality-ci-summary","total":2,"passed":2,"failed":0}\n',
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    expect(out.lines.join('\n')).toContain('### KB Quality Enforcement Summary')
    expect(out.lines.join('\n')).toContain('| total | 2 |')
    expect(out.lines.join('\n')).toContain('| passed | 2 |')
  })

  it('falls back to stdin when --log is omitted (exit 0)', () => {
    const out = makeSink()
    const code = runCli({
      argv: ['--event', 'schema-validation-summary', '--title', 'Schema Validation Summary'],
      stdout: out.fn,
      stderr: () => {},
      readStdin: () => '{"event":"schema-validation-summary","trigger":"all","total":5}\n',
    })

    expect(code).toBe(0)
    expect(out.lines.join('\n')).toContain('| trigger | all |')
    expect(out.lines.join('\n')).toContain('| total | 5 |')
  })

  it('renders the neutral fallback when readFile throws (missing log file)', () => {
    const out = makeSink()
    const code = runCli({
      argv: ['--event', 'schema-validation-summary', '--title', 'Schema Validation Summary', '--log', '/nope.log'],
      stdout: out.fn,
      stderr: () => {},
      readFile: () => { throw new Error('ENOENT') },
    })

    expect(code).toBe(0)
    expect(out.lines.join('\n')).toContain('_No summary data available._')
  })

  it('renders the neutral fallback when the log has no matching event line', () => {
    const out = makeSink()
    const code = runCli({
      argv: ['--event', 'schema-validation-summary', '--title', 'Schema Validation Summary', '--log', '/x.log'],
      stdout: out.fn,
      stderr: () => {},
      readFile: () => 'plain human line\n{"event":"other","total":9}\n',
    })

    expect(code).toBe(0)
    expect(out.lines.join('\n')).toContain('_No summary data available._')
  })

  it('exits 2 with a usage message on stderr when --event is missing', () => {
    const out = makeSink()
    const err = makeSink()
    const code = runCli({
      argv: ['--title', 'X'],
      stdout: out.fn,
      stderr: err.fn,
    })

    expect(code).toBe(2)
    expect(err.lines.join('\n')).toContain('Usage:')
    expect(out.lines).toEqual([])
  })

  it('exits 2 with a usage message on stderr when --title is missing', () => {
    const err = makeSink()
    const code = runCli({
      argv: ['--event', 'x'],
      stdout: () => {},
      stderr: err.fn,
    })

    expect(code).toBe(2)
    expect(err.lines.join('\n')).toContain('Usage:')
  })

  it('exits 2 with a usage message when argv is empty', () => {
    const err = makeSink()
    const code = runCli({
      argv: [],
      stdout: () => {},
      stderr: err.fn,
    })

    expect(code).toBe(2)
    expect(err.lines.join('\n')).toContain('Usage:')
  })
})
