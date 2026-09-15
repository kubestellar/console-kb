#!/usr/bin/env node
/**
 * render-step-summary.mjs
 *
 * validate-schema.mjs and test-kb-quality-ci.mjs already emit a single
 * bounded JSON summary line (`schema-validation-summary`,
 * `kb-quality-ci-summary`) via the shared scripts/lib/logger.mjs
 * `summary()` helper, but none of the CI workflows that run them surface
 * that data anywhere beyond raw step logs — a reviewer or on-call
 * engineer has to open the raw log and find the JSON line by eye.
 *
 * This CLI reads a log file (or stdin), finds the last line whose JSON
 * `event` field matches the one requested, and renders its fields as a
 * GitHub Flavored Markdown table matching the `$GITHUB_STEP_SUMMARY`
 * convention already used in `.github/workflows/cncf-install-gen.yml`.
 *
 * It is a small, local, additive formatting step: no network calls, no
 * new exporter, no secrets — it only reformats JSON counts/strings the
 * calling script already computed.
 *
 * Usage:
 *   node scripts/render-step-summary.mjs --event schema-validation-summary \
 *     --title "Schema Validation Summary" --log validate-schema-output.log \
 *     >> "$GITHUB_STEP_SUMMARY"
 *
 *   # or pipe stdin instead of --log:
 *   node scripts/validate-schema.mjs --all | tee out.log
 *   node scripts/render-step-summary.mjs --event schema-validation-summary \
 *     --title "Schema Validation Summary" < out.log >> "$GITHUB_STEP_SUMMARY"
 *
 * Exits 0 always (a missing/absent summary line renders a neutral
 * fallback line rather than failing the job) so it is safe to run from
 * an `if: always()` step.
 */

import { readFileSync } from 'fs'

function parseArgs(argv) {
  const args = { event: '', title: '', log: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--event') args.event = argv[++i] ?? ''
    else if (arg === '--title') args.title = argv[++i] ?? ''
    else if (arg === '--log') args.log = argv[++i] ?? ''
  }
  return args
}

/** Finds the last line in `text` whose parsed JSON `event` field equals `event`. */
export function findLastSummaryLine(text, event) {
  const lines = (text || '').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && parsed.event === event) return parsed
    } catch {
      // Not a JSON line (human-readable console output) — skip it.
    }
  }
  return null
}

/** Renders a flat summary object (event + primitive fields) as a GFM markdown table. */
export function renderMarkdownTable(title, summary) {
  const rows = Object.entries(summary || {}).filter(([key]) => key !== 'event')
  const lines = [`### ${title}`, '']
  if (rows.length === 0) {
    lines.push('_No summary data available._')
    return lines.join('\n')
  }
  lines.push('| Metric | Value |', '|--------|-------|')
  for (const [key, value] of rows) {
    lines.push(`| ${key} | ${value} |`)
  }
  return lines.join('\n')
}

/**
 * In-process CLI entry point. Parses argv, reads the requested log (or
 * stdin), finds the last summary line matching `--event`, and writes
 * the rendered markdown table to `stdout`. Returns a POSIX exit code
 * (0 = rendered, either real summary or neutral fallback; 2 = missing
 * required flag). Exported so tests can drive the CLI path in-process;
 * the tail `process.exit(runCli())` guard below is the only caller
 * that turns the return value into a real process exit code.
 *
 * `argv`, `stdout`, `stderr`, `readFile`, and `readStdin` are injectable
 * so tests can drive the CLI deterministically without spawning a
 * subprocess — v8 does not attribute subprocess coverage to the parent
 * process (see console-kb#3398).
 */
export function runCli({
  argv = process.argv.slice(2),
  stdout = console.log,
  stderr = console.error,
  readFile = (path) => readFileSync(path, 'utf-8'),
  readStdin = () => readFileSync(0, 'utf-8'),
} = {}) {
  const { event, title, log } = parseArgs(argv)
  if (!event || !title) {
    stderr('Usage: render-step-summary.mjs --event <name> --title <title> [--log <file>]')
    return 2
  }

  let text
  try {
    text = log ? readFile(log) : readStdin()
  } catch {
    text = ''
  }

  const summary = findLastSummaryLine(text, event)
  stdout(
    summary
      ? renderMarkdownTable(title, summary)
      : renderMarkdownTable(title, null)
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runCli())
}
