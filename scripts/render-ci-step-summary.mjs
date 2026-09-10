#!/usr/bin/env node
/**
 * render-ci-step-summary.mjs
 *
 * Reads a CI script's mixed stdout (its normal human-readable output
 * plus one bounded structured summary JSON line emitted via
 * scripts/lib/logger.mjs's `summary()` helper — e.g.
 * `schema-validation-summary` from validate-schema.mjs,
 * `kb-quality-ci-summary` from test-kb-quality-ci.mjs) from stdin, and
 * renders that summary as a GitHub Actions job-summary markdown table
 * on stdout.
 *
 * This is a STANDALONE, unit-tested script. It intentionally does not
 * modify any `.github/workflows/*.yml` file — creating/updating a
 * workflow file requires the GitHub App `workflows` permission, which
 * this repo's telemetry automation does not hold. A maintainer with
 * that permission can wire this in with a small `if: always()` step:
 *
 *   # .github/workflows/validate-schema.yml, after each existing
 *   # "Validate schema" run step (piped through `tee
 *   # validate-schema-output.log` so this script can read it):
 *   - name: Post schema validation summary
 *     if: always()
 *     run: |
 *       echo "### 📋 Mission Schema Validation" >> $GITHUB_STEP_SUMMARY
 *       [ -f validate-schema-output.log ] && \
 *         node scripts/render-ci-step-summary.mjs \
 *           < validate-schema-output.log >> $GITHUB_STEP_SUMMARY
 *
 *   # .github/workflows/kb-quality-enforcement.yml, after the existing
 *   # "Run Quality Scorer" step (piped through `tee
 *   # kb-quality-ci-output.log`):
 *   - name: Post KB quality summary
 *     if: always()
 *     run: |
 *       echo "### 📋 KB Quality Enforcement" >> $GITHUB_STEP_SUMMARY
 *       [ -f kb-quality-ci-output.log ] && \
 *         node scripts/render-ci-step-summary.mjs \
 *           < kb-quality-ci-output.log >> $GITHUB_STEP_SUMMARY
 *
 * Only the small, already-bounded set of fields each script's
 * summary() call emits is ever rendered — no free-form or
 * caller-controlled labels, keeping cardinality bounded.
 */

/** Known summary events this renderer understands, and how to format them. */
const KNOWN_EVENTS = {
  'schema-validation-summary': {
    fields: [
      ['trigger', 'Trigger'],
      ['total', 'Total files'],
      ['validCount', 'Valid'],
      ['invalidCount', 'Invalid'],
      ['durationMs', 'Duration (ms)'],
    ],
    result: s => (s.level === 'error' ? '❌ error' : '✅ info'),
  },
  'kb-quality-ci-summary': {
    fields: [
      ['total', 'Total files'],
      ['passed', 'Passed'],
      ['failed', 'Failed'],
    ],
    result: s => ((s.failed ?? 0) > 0 ? '❌ fail' : '✅ pass'),
  },
}

/**
 * Scans `input` line by line for JSON lines whose `event` field matches a
 * known summary event. Returns a map of event name -> parsed summary
 * object, keeping the LAST occurrence of each event (matching how the
 * scripts always emit their summary as the final stdout line).
 */
function parseSummaryLines(input) {
  const found = {}
  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed && typeof parsed.event === 'string' && KNOWN_EVENTS[parsed.event]) {
      found[parsed.event] = parsed
    }
  }
  return found
}

/**
 * Renders any known structured summary line(s) found in `input` as
 * GitHub-flavored markdown table(s). Returns a placeholder message
 * (never throws, never exits non-zero) when no known summary line is
 * present, so this is always safe to call from an `if: always()` step
 * even when the upstream script was skipped or produced no output.
 */
export function renderSummary(input) {
  const found = parseSummaryLines(input || '')
  const events = Object.keys(found)
  if (events.length === 0) {
    return '_No structured CI summary line found in the step output._\n'
  }

  const lines = []
  for (const event of events) {
    const summary = found[event]
    const spec = KNOWN_EVENTS[event]
    lines.push('| Metric | Value |')
    lines.push('|--------|-------|')
    for (const [key, label] of spec.fields) {
      lines.push(`| ${label} | ${summary[key]} |`)
    }
    lines.push(`| Result | ${spec.result(summary)} |`)
    lines.push('')
  }
  return lines.join('\n')
}

function readStdin() {
  return new Promise(resolve => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
  })
}

async function main() {
  const input = await readStdin()
  process.stdout.write(renderSummary(input))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
