#!/usr/bin/env node
/**
 * render-ci-step-summary.mjs
 *
 * Reads a CI script's mixed stdout (its normal human-readable output
 * plus one bounded structured summary JSON line emitted via
 * scripts/lib/logger.mjs's `summary()` helper — e.g.
 * `schema-validation-summary` from validate-schema.mjs,
 * `kb-quality-ci-summary` from test-kb-quality-ci.mjs,
 * `fuzz-json-fixtures-summary` from fuzz-json-fixtures.mjs,
 * `fuzz-mission-scanner-summary` from fuzz-mission-scanner.mjs, and
 * `mission-safety-scan-summary` from mission-safety-scan.mjs) from
 * stdin, and renders that summary as a GitHub Actions job-summary
 * markdown table on stdout.
 *
 * This is the SINGLE, STANDALONE, unit-tested renderer for every
 * workflow that posts a structured `$GITHUB_STEP_SUMMARY` table (see
 * console-kb#3630, which folded the formerly-separate
 * render-step-summary.mjs into this file so the four callers below
 * share one schema and one CLI shape):
 *
 *   # .github/workflows/fuzz.yml (see console-kb#3383) — auto-detects
 *   # the known event, no --event/--title needed:
 *   - name: Post fuzz summary
 *     if: always()
 *     run: |
 *       node scripts/render-ci-step-summary.mjs \
 *         < fuzz-json-fixtures-output.log >> $GITHUB_STEP_SUMMARY
 *
 *   # .github/workflows/validate-schema.yml, after each existing
 *   # "Validate schema" run step (piped through `tee
 *   # validate-schema-output.log` so this script can read it):
 *   - name: Write schema validation summary
 *     if: always()
 *     run: |
 *       node scripts/render-ci-step-summary.mjs \
 *         --event schema-validation-summary \
 *         --title "Schema Validation Summary" \
 *         < validate-schema-output.log >> "$GITHUB_STEP_SUMMARY"
 *
 *   # .github/workflows/kb-quality-enforcement.yml, after the existing
 *   # "Run Quality Scorer" step (piped through `tee
 *   # kb-quality-ci-output.log`):
 *   - name: Write KB quality summary
 *     if: always()
 *     run: |
 *       node scripts/render-ci-step-summary.mjs \
 *         --event kb-quality-ci-summary \
 *         --title "KB Quality Enforcement Summary" \
 *         < kb-quality-ci-output.log >> "$GITHUB_STEP_SUMMARY"
 *
 *   # .github/workflows/mission-safety-scan.yml, after the existing
 *   # "Scan for dangerous commands" step (piped through `tee
 *   # mission-safety-scan-output.log`):
 *   - name: Write mission safety scan summary
 *     if: always()
 *     run: |
 *       node scripts/render-ci-step-summary.mjs \
 *         --event mission-safety-scan-summary \
 *         --title "Mission Safety Scan Summary" \
 *         < mission-safety-scan-output.log >> "$GITHUB_STEP_SUMMARY"
 *
 * `--event` narrows rendering to just that summary line (ignoring any
 * other JSON lines present); `--title`, when given, prepends a
 * `### <title>` heading to the rendered output. Both flags are
 * optional — omitting them keeps the original auto-detect-every-known-
 * event behaviour `fuzz.yml` relies on.
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
  'fuzz-json-fixtures-summary': {
    fields: [
      ['scanned', 'Files scanned'],
      ['errors', 'Parse errors'],
      ['durationMs', 'Duration (ms)'],
    ],
    result: s => ((s.errors ?? 0) > 0 ? '❌ fail' : '✅ pass'),
  },
  'fuzz-mission-scanner-summary': {
    fields: [
      ['total', 'Malformed inputs'],
      ['handled', 'Rejected by scanner'],
      ['durationMs', 'Duration (ms)'],
    ],
    result: s => (s.handled === s.total ? '✅ pass' : '❌ fail'),
  },
  'mission-safety-scan-summary': {
    fields: [
      ['filesScanned', 'Files scanned'],
      ['errors', 'Errors'],
      ['warnings', 'Warnings'],
      ['durationMs', 'Duration (ms)'],
    ],
    result: s => ((s.errors ?? 0) > 0 ? '❌ fail' : '✅ pass'),
  },
}

/**
 * Scans `input` line by line for JSON lines whose `event` field matches a
 * known summary event. Returns a map of event name -> parsed summary
 * object, keeping the LAST occurrence of each event (matching how the
 * scripts always emit their summary as the final stdout line).
 *
 * When `targetEvent` is given, only that event is tracked (and only if
 * it is itself a known event) — this is how single-event callers (the
 * three `--event`-passing workflow steps) narrow the scan to just the
 * summary line they care about, ignoring any other JSON lines present.
 */
function parseSummaryLines(input, targetEvent) {
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
    if (!parsed || typeof parsed.event !== 'string') continue
    if (targetEvent) {
      if (parsed.event === targetEvent && KNOWN_EVENTS[targetEvent]) {
        found[targetEvent] = parsed
      }
    } else if (KNOWN_EVENTS[parsed.event]) {
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
 *
 * `event`, when given, narrows rendering to just that summary event
 * (see `parseSummaryLines`). `title`, when given, is prepended as a
 * `### <title>` markdown heading — this lets single-event callers drop
 * their own `echo "### …" >> $GITHUB_STEP_SUMMARY` line.
 */
export function renderSummary(input, { event, title } = {}) {
  const heading = title ? `### ${title}\n\n` : ''
  const found = parseSummaryLines(input || '', event)
  const events = Object.keys(found)
  if (events.length === 0) {
    return `${heading}_No structured CI summary line found in the step output._\n`
  }

  const lines = []
  for (const ev of events) {
    const summary = found[ev]
    const spec = KNOWN_EVENTS[ev]
    lines.push('| Metric | Value |')
    lines.push('|--------|-------|')
    for (const [key, label] of spec.fields) {
      lines.push(`| ${label} | ${summary[key]} |`)
    }
    lines.push(`| Result | ${spec.result(summary)} |`)
    lines.push('')
  }
  return heading + lines.join('\n')
}

/** Parses `--event <name>` and `--title <title>`, both optional (auto-detect/no-heading when absent). */
function parseArgs(argv) {
  const args = { event: '', title: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--event') args.event = argv[++i] ?? ''
    else if (arg === '--title') args.title = argv[++i] ?? ''
  }
  return args
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

/**
 * In-process CLI entry point. Parses optional `--event`/`--title` from
 * `argv`, reads CI stdout from `readStdin`, renders the (optionally
 * narrowed/titled) summary as markdown, writes it to `stdout`, and
 * returns a POSIX exit code (always 0 — an unrecognised or empty input
 * is a placeholder, not an error, so an `if: always()` step keeps
 * working when the upstream script was skipped).
 *
 * Injectables are exposed so tests can drive the CLI in-process — v8
 * does not attribute subprocess `spawnSync` coverage back to the parent
 * process, which is why the sibling render-ci-step-summary-cli.test.mjs
 * spawn tests leave `main()` and `readStdin()` reading as uncovered
 * (see console-kb#3398).
 */
export async function runCli({
  argv = process.argv.slice(2),
  stdout = (s) => process.stdout.write(s),
  readStdin: readStdinFn = readStdin,
} = {}) {
  const { event, title } = parseArgs(argv)
  const input = await readStdinFn()
  stdout(renderSummary(input, { event: event || undefined, title: title || undefined }))
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => process.exit(code))
}
