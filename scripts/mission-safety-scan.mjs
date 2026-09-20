#!/usr/bin/env node
/**
 * mission-safety-scan.mjs
 *
 * Standalone extraction of the dangerous-pattern checks currently inlined
 * as a bash `run:` block in `.github/workflows/mission-safety-scan.yml`.
 * The workflow only emits `::error`/`::warning` annotations per finding
 * and a final pass/fail exit code — unlike `validate-schema.mjs` and
 * `scan-pr.mjs`, it has no structured, parseable outcome (no count of
 * files scanned, no breakdown of errors vs. warnings), so a reviewer has
 * to open the raw log/Annotations tab to see what actually happened.
 *
 * This module ports every check from the inline bash 1:1 (same
 * patterns, same error/warning classification) into a pure, unit-tested
 * function, and additionally emits one bounded structured JSON summary
 * line via the shared `scripts/lib/logger.mjs` `summary()` helper
 * (`mission-safety-scan-summary`: `filesScanned`, `errors`, `warnings`,
 * `durationMs`), matching the convention already used by
 * `validate-schema.mjs` (`schema-validation-summary`) and
 * `fuzz-json-fixtures.mjs` (`fuzz-json-fixtures-summary`).
 *
 * This is intentionally a STANDALONE, unit-tested script — it does not
 * modify `.github/workflows/mission-safety-scan.yml`. Creating/updating a
 * workflow file requires the GitHub App `workflows` permission, which
 * this repo's telemetry automation does not hold (see PR #3311 for the
 * same constraint). A maintainer with that permission can replace the
 * inline bash step with:
 *
 *   - name: Scan for dangerous commands
 *     run: node scripts/mission-safety-scan.mjs "$FILES"
 *
 * No new dependency beyond the `js-yaml` already used by
 * `validate-schema.mjs`, no network calls, no exporter — only formats
 * already-computed local counts for the Actions step log / a future
 * $GITHUB_STEP_SUMMARY consumer.
 */
import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { createLogger } from './lib/logger.mjs'

const log = createLogger('mission-safety-scan')

/**
 * Official curl|bash source hosts allow-listed by the original bash
 * check (only used to decide whether to emit a warning).
 */
// Note on the `raw.githubusercontent.com/...` entry: this host is only
// allow-listed for the specific upstream orgs whose official installers are
// referenced by shipped `fixes/**` today. A bare `raw.githubusercontent.com`
// match would accept scripts from ANY GitHub account (issue #3392), giving
// an attacker who seeds a public discussion source a trivial way to sneak
// `curl … | bash` past the safety scan.
const OFFICIAL_CURL_BASH_HOSTS = new RegExp(
  [
    'get\\.k3s\\.io',
    'aka\\.ms\\/',
    'sdk\\.cloud\\.google',
    'clis\\.cloud\\.ibm',
    'ollama\\.com',
    'get\\.rke2\\.io',
    'raw\\.githubusercontent\\.com\\/(wasmcloud|WasmEdge|kube-burner)\\/',
    'cdn\\.porter\\.sh',
    'istio\\.io',
    'oss\\.kubeclipper\\.io',
  ].join('|'),
  'i',
)

/**
 * Attempts to parse `content` as a kc-mission-v1 document (JSON, falling
 * back to YAML) and returns its parsed steps as an array of strings, or
 * `null` if it cannot be parsed / has no steps. Mirrors the inline
 * Python `load_mission()` helper from the original bash check.
 */
function tryLoadMissionSteps(content) {
  let data
  try {
    data = JSON.parse(content)
  } catch {
    try {
      data = yaml.load(content)
    } catch {
      return null
    }
  }
  if (!data || typeof data !== 'object') return null
  return { missionClass: data.missionClass, steps: data?.mission?.steps ?? [] }
}

/**
 * Runs every dangerous-pattern check from the original
 * `mission-safety-scan.yml` bash block against one file's contents.
 * Returns `{ errors: string[], warnings: string[] }` (human-readable
 * messages, no file path prefix — the caller attaches that). Exported
 * for unit testing; performs no I/O and does not call process.exit.
 */
export function scanFileForSafetyIssues(filePath, content) {
  const errors = []
  const warnings = []

  if (/kubectl delete (namespace|ns|all)\b.*--all/.test(content)) {
    errors.push('Dangerous: kubectl delete all/namespace --all')
  }

  if (/rm\s+-rf?\s+(\/|\/\*|~|\$HOME)/.test(content)) {
    errors.push('Dangerous: rm -rf with root/home path')
  }

  if (/kubectl delete.*(kube-system|kube-public|kube-node-lease|default)\b/i.test(content)) {
    errors.push('Dangerous: kubectl delete targeting protected namespace')
  }

  if (/registry\/org\/image:tag|registry\/[a-z]|your-docker-registry\//.test(content)) {
    errors.push('Placeholder container image not replaced')
  }

  const mission = tryLoadMissionSteps(content)
  if (mission && mission.missionClass === 'install') {
    const hasCmd = mission.steps.some(step =>
      /kubectl|helm|curl|apt|pip/.test(String(step))
    )
    if (!hasCmd) {
      errors.push('Install mission has no actual install commands')
    }
  }

  if (/curl.*\|\s*(ba)?sh/.test(content) && !OFFICIAL_CURL_BASH_HOSTS.test(content)) {
    warnings.push('curl piped to shell from non-standard source — verify URL is official')
  }

  if (/--force.*grace-period=0/.test(content)) {
    warnings.push('Force delete with grace-period=0 — ensure this is intentional')
  }

  if (/hereby agree to the terms of the CLA|I hereby agree.*cla/i.test(content)) {
    errors.push('Resolution contains CLA boilerplate instead of actual content')
  }

  if (
    /What is the problem you.re trying to solve\?|Pre-Submission checklist|Does this PR introduce a user-facing change/.test(
      content
    )
  ) {
    errors.push('Resolution contains unfilled PR template')
  }

  // Extended grace-period pattern (allows a space before "=0"), kept as
  // a second, independently-firing check to match the original bash's
  // two overlapping checks.
  if (/--force.*grace-period[= ]*0/.test(content)) {
    warnings.push('Contains --force --grace-period=0 pattern')
  }

  if (/pip install (kubectl|helm)\b/.test(content)) {
    errors.push('Uses pip install kubectl/helm — these are not the real tools')
  }

  if (/v1\.(3[4-9]|[4-9][0-9])/.test(content)) {
    errors.push('References nonexistent Kubernetes version')
  }

  if (filePath.includes('install') && /image:.*:latest/.test(content)) {
    warnings.push('Uses :latest tag — pin to specific version')
  }

  if (
    /"(password|token|secret|apiKey|api_key|admin_password)":\s*"(?!<[A-Z_]+>|changeme|CHANGE_ME|your-|YOUR_|xxx|placeholder)[^"]{3,}"/.test(
      content
    )
  ) {
    warnings.push("Possible hardcoded credential detected — verify it's a safe example value")
  }

  if (
    /\b(ip-\d+-\d+-\d+-\d+\.\w+-\w+-\d+\.compute\.internal|ec2-\d+-\d+-\d+-\d+\.\w+\.compute\.amazonaws\.com|compute\.googleapis\.com|\.cloudapp\.azure\.com)\b/.test(
      content
    )
  ) {
    errors.push('Leaked cloud provider hostname detected — must be anonymized')
  }

  if (/k8s\.gcr\.io\//.test(content)) {
    warnings.push('Uses deprecated k8s.gcr.io registry — should use registry.k8s.io')
  }

  return { errors, warnings }
}

/**
 * Scans every file in `files` (paths, as produced by the workflow's
 * `git diff --name-only` step) and aggregates findings. Missing/unreadable
 * files are skipped (matching the original bash's `[ -f "$f" ] || continue`
 * guard). Exported for unit testing; does not call process.exit or
 * console.log/error.
 */
export function runSafetyScan(files) {
  let errorCount = 0
  let warningCount = 0
  let filesScanned = 0
  const findings = []

  for (const filePath of files) {
    let content
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    filesScanned += 1
    const { errors, warnings } = scanFileForSafetyIssues(filePath, content)
    errorCount += errors.length
    warningCount += warnings.length
    for (const message of errors) findings.push({ level: 'error', filePath, message })
    for (const message of warnings) findings.push({ level: 'warning', filePath, message })
  }

  return { filesScanned, errorCount, warningCount, findings }
}

/**
 * Splits the CLI arg vector into an array of paths.
 *
 * The upstream workflow (`.github/workflows/mission-safety-scan.yml`) passes
 * paths as a single quoted argument produced by `git diff --name-only …`,
 * which is newline-separated. Splitting on any whitespace (`/\s+/`) would
 * silently break a mission whose path contains a space or tab into two
 * nonexistent paths — the loop's `readFileSync` catch then skips them
 * without emitting a finding, so the scanner reports "Safety scan passed"
 * on a file it never actually opened (issue #3470, same class as the
 * `scan-pr.mjs` bypass fixed in #3280). Split on newline only so
 * whitespace-in-path is preserved end-to-end.
 */
export function parseCliFiles(rawArgs) {
  return rawArgs.flatMap(a => a.split(/\r?\n/)).filter(Boolean)
}

function main() {
  const startedAt = Date.now()
  const files = parseCliFiles(process.argv.slice(2))

  const { filesScanned, errorCount, warningCount, findings } = runSafetyScan(files)

  for (const { level, filePath, message } of findings) {
    console.log(`::${level} file=${filePath}::${message}`)
  }

  const durationMs = Date.now() - startedAt

  log.summary('mission-safety-scan-summary', {
    level: errorCount > 0 ? 'error' : 'info',
    filesScanned,
    errors: errorCount,
    warnings: warningCount,
    durationMs,
  })

  if (errorCount > 0) {
    console.error(`::error::Found ${errorCount} safety issues. Fix before merging.`)
    process.exit(1)
  }

  console.log('Safety scan passed')
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
