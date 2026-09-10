/**
 * render-step-summary.test.mjs
 *
 * render-step-summary.mjs is the shared formatter workflows use to turn
 * the structured JSON summary lines already emitted by validate-schema.mjs
 * (`schema-validation-summary`) and test-kb-quality-ci.mjs
 * (`kb-quality-ci-summary`) into a `$GITHUB_STEP_SUMMARY` markdown table,
 * matching the convention already used in
 * `.github/workflows/cncf-install-gen.yml`. Covers both the unit-level
 * helpers (findLastSummaryLine, renderMarkdownTable) and the CLI entry
 * point end-to-end via subprocess (it reads argv/stdin/files and calls
 * process.exit, so the CLI path can't be exercised by import alone).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { findLastSummaryLine, renderMarkdownTable } from '../render-step-summary.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'render-step-summary.mjs')

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'render-step-summary-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('findLastSummaryLine', () => {
  it('finds the matching JSON line among mixed human-readable output', () => {
    const text = [
      'Discovered 3 mission files to validate.',
      '✅ fixes/a.json: Valid kc-mission-v1',
      '{"event":"schema-validation-summary","trigger":"all","total":3,"validCount":3,"invalidCount":0,"durationMs":42}',
      '',
    ].join('\n')

    expect(findLastSummaryLine(text, 'schema-validation-summary')).toEqual({
      event: 'schema-validation-summary',
      trigger: 'all',
      total: 3,
      validCount: 3,
      invalidCount: 0,
      durationMs: 42,
    })
  })

  it('returns the last matching line when several are present', () => {
    const text = [
      '{"event":"kb-quality-ci-summary","total":1,"passed":0,"failed":1}',
      '{"event":"kb-quality-ci-summary","total":2,"passed":2,"failed":0}',
    ].join('\n')

    expect(findLastSummaryLine(text, 'kb-quality-ci-summary').total).toBe(2)
  })

  it('returns null when no matching event is present', () => {
    const text = '{"event":"some-other-event","foo":1}\n'
    expect(findLastSummaryLine(text, 'schema-validation-summary')).toBeNull()
  })

  it('returns null for empty or missing input', () => {
    expect(findLastSummaryLine('', 'schema-validation-summary')).toBeNull()
    expect(findLastSummaryLine(undefined, 'schema-validation-summary')).toBeNull()
  })
})

describe('renderMarkdownTable', () => {
  it('renders a markdown table with the title and each field as a row', () => {
    const out = renderMarkdownTable('Schema Validation Summary', {
      event: 'schema-validation-summary',
      trigger: 'all',
      total: 3,
    })
    expect(out).toContain('### Schema Validation Summary')
    expect(out).toContain('| Metric | Value |')
    expect(out).toContain('| trigger | all |')
    expect(out).toContain('| total | 3 |')
    expect(out).not.toContain('| event |')
  })

  it('renders a neutral fallback when there is no summary data', () => {
    const out = renderMarkdownTable('KB Quality Enforcement Summary', null)
    expect(out).toContain('### KB Quality Enforcement Summary')
    expect(out).toContain('_No summary data available._')
  })
})

describe('render-step-summary.mjs CLI', () => {
  it('renders a table from a --log file', () => {
    withTempDir(dir => {
      const logFile = join(dir, 'out.log')
      writeFileSync(
        logFile,
        '{"event":"kb-quality-ci-summary","total":2,"passed":2,"failed":0}\n'
      )
      const result = spawnSync(process.execPath, [
        SCRIPT,
        '--event',
        'kb-quality-ci-summary',
        '--title',
        'KB Quality Enforcement Summary',
        '--log',
        logFile,
      ], { encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('### KB Quality Enforcement Summary')
      expect(result.stdout).toContain('| total | 2 |')
    })
  })

  it('renders a table from stdin when --log is omitted', () => {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--event',
      'schema-validation-summary',
      '--title',
      'Schema Validation Summary',
    ], {
      encoding: 'utf8',
      input: '{"event":"schema-validation-summary","trigger":"all","total":5,"validCount":5,"invalidCount":0,"durationMs":10}\n',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('| trigger | all |')
    expect(result.stdout).toContain('| durationMs | 10 |')
  })

  it('renders a neutral fallback (exit 0) when the log has no matching event', () => {
    withTempDir(dir => {
      const logFile = join(dir, 'empty.log')
      writeFileSync(logFile, 'No files to validate.\n')
      const result = spawnSync(process.execPath, [
        SCRIPT,
        '--event',
        'schema-validation-summary',
        '--title',
        'Schema Validation Summary',
        '--log',
        logFile,
      ], { encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('_No summary data available._')
    })
  })

  it('renders a neutral fallback (exit 0) when the log file does not exist', () => {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--event',
      'schema-validation-summary',
      '--title',
      'Schema Validation Summary',
      '--log',
      '/nonexistent/path/does-not-exist.log',
    ], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('_No summary data available._')
  })

  it('exits 2 with a usage message when --event or --title is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--event', 'foo'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })
})
