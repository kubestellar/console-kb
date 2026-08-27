import { describe, it, expect } from 'vitest'
import {
  formatScanResultAsMarkdown,
  validateMissionExport,
  fullScan,
  scanMissionFile,
} from '../scanner.mjs'

// Closes two previously-uncovered arms of formatScanResultAsMarkdown
// (scanner.mjs lines 431-433 and 459-465):
//
//   - The `❌ **Schema errors:**` branch, which lists individual
//     validation errors in the PR-comment markdown. Existing tests only
//     covered clean/schema-valid scans plus the top-level parse-error
//     early return, so a regression that dropped the schema-errors
//     rendering (or crashed on the error loop) would leave PR reviewers
//     with a "schema" line that never explains what actually failed.
//
//   - The `🚨 **Security:** N finding(s)` malicious-content branch,
//     which renders a table of matches escaping `\`, `|`, and backticks.
//     Prior tests exercised the sensitive-data table but never the
//     malicious-content one, and never the escaping logic — a regression
//     that skipped the escape step could produce markdown that breaks
//     table rendering when a scanner match contains a pipe or backtick.

function baseMission() {
  return {
    version: 'kc-mission-v1',
    name: 'demo',
    mission: {
      title: 'Demo',
      steps: [{ title: 'S1', description: 'do' }],
    },
  }
}

describe('formatScanResultAsMarkdown — schema-error branch', () => {
  it('lists every validation error under an ❌ Schema errors heading', () => {
    // Schema-invalid but structurally intact so we skip the parse-error
    // early return and reach the schema branch specifically.
    const badMission = { version: 'kc-mission-v2' } // wrong version, no name, no mission
    const result = {
      parsed: badMission,
      schema: validateMissionExport(badMission),
      scan: fullScan(badMission),
      error: null,
    }
    expect(result.schema.valid).toBe(false)
    expect(result.schema.errors.length).toBeGreaterThan(1)

    const md = formatScanResultAsMarkdown('bad-schema.json', result)

    expect(md).toContain('❌ **Schema errors:**')
    for (const err of result.schema.errors) {
      expect(md).toContain(`  - ${err}`)
    }
    // No accidental "Valid kc-mission-v1" line on the invalid branch.
    expect(md).not.toContain('Valid kc-mission-v1')
  })
})

describe('formatScanResultAsMarkdown — malicious-findings branch', () => {
  it('renders findings as an escaped markdown table', () => {
    // fullScan detects XSS-ish content in mission fields; put a script
    // tag AND a metacharacter-heavy payload into the description so the
    // escape logic (backslash, pipe, backtick) is exercised.
    const dangerous = {
      ...baseMission(),
      mission: {
        title: 'Danger',
        steps: [
          {
            title: 'S1',
            description: '<script>alert("x|y`z\\w")</script>',
          },
        ],
      },
    }
    const scan = fullScan(dangerous)
    // Force at least one malicious finding whose value contains all
    // three escape triggers, so the mapping is deterministic regardless
    // of what fullScan happens to detect today.
    const forced = { type: 'test-injection', value: 'a\\b|c`d' }
    scan.malicious.findings.push(forced)

    const result = {
      parsed: dangerous,
      schema: validateMissionExport(dangerous),
      scan,
      error: null,
    }
    const md = formatScanResultAsMarkdown('danger.json', result)

    expect(md).toContain(`🚨 **Security:** ${scan.malicious.findings.length} finding(s)`)
    expect(md).toContain('| Type | Match |')
    expect(md).toContain('|------|-------|')

    // The forced finding must appear with:
    //   \  -> \\    |  -> \|   `  -> \`
    // producing `| test-injection | \`a\\b\|c\\`d\` |`
    const expectedRow = `| test-injection | \`a\\\\b\\|c\\\`d\` |`
    expect(md).toContain(expectedRow)
    // Guard against the "no malicious content" line leaking through.
    expect(md).not.toContain('No malicious content detected')
  })

  it('escapes even when the value contains only one metacharacter', () => {
    // Explicitly cover each escape substitution in isolation so a
    // regression that drops any one of the three .replace() calls fails
    // this test rather than the combined one above.
    const cases = [
      { input: 'has|pipe',       expectedInRow: '\\|' },
      { input: 'has`backtick',   expectedInRow: '\\`' },
      { input: 'has\\backslash', expectedInRow: '\\\\' },
    ]
    for (const { input, expectedInRow } of cases) {
      const mission = baseMission()
      const scan = fullScan(mission)
      scan.malicious.findings.push({ type: 'unit', value: input })
      const md = formatScanResultAsMarkdown('f.json', {
        parsed: mission,
        schema: validateMissionExport(mission),
        scan,
        error: null,
      })
      expect(md).toContain(expectedInRow)
    }
  })
})

describe('scanMissionFile parse-error path already covered, sanity', () => {
  // Sanity guard so an unrelated regression that makes scanMissionFile
  // throw instead of returning { error } would be caught here rather
  // than surprising the two new tests above.
  it('returns an error object for malformed JSON', () => {
    const result = scanMissionFile('{ this is not json')
    expect(result.error).toBeTruthy()
  })
})
