/**
 * render-ci-step-summary.test.mjs
 *
 * render-ci-step-summary.mjs is a standalone CLI that turns the
 * bounded `summary()` JSON line already emitted by validate-schema.mjs
 * (`schema-validation-summary`) and test-kb-quality-ci.mjs
 * (`kb-quality-ci-summary`) into a GitHub-flavored markdown table
 * suitable for `$GITHUB_STEP_SUMMARY`. It exists because neither
 * validate-schema.yml nor kb-quality-enforcement.yml surfaces that
 * already-computed structured data to the job summary today — a
 * reviewer has to open raw step logs to find the JSON line by eye.
 *
 * These tests exercise the exported `renderSummary()` directly against
 * realistic mixed stdout (human-readable lines + the JSON summary
 * line), plus the "no summary present" fallback path so the CLI is
 * safe to call unconditionally from an `if: always()` step.
 */
import { describe, it, expect } from 'vitest'
import { renderSummary } from '../render-ci-step-summary.mjs'

describe('render-ci-step-summary.mjs renderSummary', () => {
  it('renders a passing schema-validation-summary as a markdown table', () => {
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
      '✅ All files passed schema validation.',
    ].join('\n')

    const out = renderSummary(input)

    expect(out).toContain('| Trigger | changed-files |')
    expect(out).toContain('| Total files | 1 |')
    expect(out).toContain('| Valid | 1 |')
    expect(out).toContain('| Invalid | 0 |')
    expect(out).toContain('| Duration (ms) | 12 |')
    expect(out).toContain('| Result | ✅ info |')
  })

  it('renders a failing schema-validation-summary with the error icon', () => {
    const input = JSON.stringify({
      event: 'schema-validation-summary',
      level: 'error',
      trigger: 'all',
      total: 2,
      validCount: 1,
      invalidCount: 1,
      durationMs: 30,
    })

    const out = renderSummary(input)

    expect(out).toContain('| Result | ❌ error |')
    expect(out).toContain('| Invalid | 1 |')
  })

  it('renders a passing kb-quality-ci-summary as a markdown table', () => {
    const input = JSON.stringify({ event: 'kb-quality-ci-summary', total: 3, passed: 3, failed: 0 })

    const out = renderSummary(input)

    expect(out).toContain('| Total files | 3 |')
    expect(out).toContain('| Passed | 3 |')
    expect(out).toContain('| Failed | 0 |')
    expect(out).toContain('| Result | ✅ pass |')
  })

  it('renders a failing kb-quality-ci-summary with the fail icon', () => {
    const input = JSON.stringify({ event: 'kb-quality-ci-summary', total: 2, passed: 1, failed: 1 })

    const out = renderSummary(input)

    expect(out).toContain('| Result | ❌ fail |')
  })

  it('uses the LAST matching summary line when more than one is present', () => {
    const input = [
      JSON.stringify({ event: 'kb-quality-ci-summary', total: 1, passed: 0, failed: 1 }),
      JSON.stringify({ event: 'kb-quality-ci-summary', total: 5, passed: 5, failed: 0 }),
    ].join('\n')

    const out = renderSummary(input)

    expect(out).toContain('| Total files | 5 |')
    expect(out).toContain('| Result | ✅ pass |')
    expect(out).not.toContain('| Total files | 1 |')
  })

  it('ignores unrelated JSON lines and non-JSON log noise', () => {
    const input = [
      'plain text line',
      JSON.stringify({ event: 'some-other-event', foo: 'bar' }),
      '{not valid json',
      JSON.stringify({ event: 'schema-validation-summary', level: 'info', trigger: 'all', total: 0, validCount: 0, invalidCount: 0, durationMs: 1 }),
    ].join('\n')

    const out = renderSummary(input)

    expect(out).toContain('| Total files | 0 |')
    expect(out).not.toContain('foo')
  })

  it('returns a placeholder message and does not throw when no summary line is present', () => {
    expect(() => renderSummary('nothing structured here\njust logs')).not.toThrow()
    expect(renderSummary('nothing structured here')).toContain('No structured CI summary line found')
  })

  it('returns the placeholder message for empty or undefined input', () => {
    expect(renderSummary('')).toContain('No structured CI summary line found')
    expect(renderSummary(undefined)).toContain('No structured CI summary line found')
  })
})
