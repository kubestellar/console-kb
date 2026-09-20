#!/usr/bin/env node
/**
 * mission-content-validation.mjs
 *
 * Standalone extraction of the two inline bash/python `run:` blocks in
 * `.github/workflows/mission-content-validation.yml` ("Validate mission
 * quality" and "Validate mission content"). Like
 * `.github/workflows/mission-safety-scan.yml` before PR #3374, this
 * workflow only prints `::error`/`::warning` annotations plus a final
 * "Errors: N / Warnings: N" text block to the raw step log — no
 * structured, parseable outcome, unlike `validate-schema.mjs` and
 * `mission-safety-scan.mjs`.
 *
 * This module ports every check from the inline bash/python 1:1 (same
 * regex patterns, same skip-list domains, same error/warning
 * classification) into pure, unit-tested functions, and additionally
 * emits one bounded structured JSON summary line via the shared
 * `scripts/lib/logger.mjs` `summary()` helper
 * (`mission-content-validation-summary`: `filesValidated`, `errors`,
 * `warnings`, `durationMs`), matching the convention already used by
 * `validate-schema.mjs` and `mission-safety-scan.mjs`.
 *
 * This is intentionally a STANDALONE, unit-tested script — it does not
 * modify `.github/workflows/mission-content-validation.yml`. Creating/
 * updating a workflow file requires the GitHub App `workflows`
 * permission, which this repo's telemetry automation does not hold
 * (see PR #3311/#3374 for the same constraint). A maintainer with that
 * permission can replace both inline `run:` blocks with a single:
 *
 *   - name: Validate mission content
 *     run: node scripts/mission-content-validation.mjs "$FILES"
 *
 * The network calls this module makes (Helm repo `index.yaml` HEAD/GET,
 * `crane digest` for container images, HTTP HEAD for doc URLs) are not
 * new — they are the same checks the workflow already performs today,
 * only ported so their outcome can be summarized. No new dependency, no
 * exporter, no secrets — only formats already-computed local counts for
 * the Actions step log / a future `$GITHUB_STEP_SUMMARY` consumer.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as yaml from 'js-yaml'
import { createLogger } from './lib/logger.mjs'

const log = createLogger('mission-content-validation')

/** Domains that are always considered reachable/known-good and skipped by URL checks. */
const SKIP_URL_SUBSTRINGS = ['github.com/kubestellar', 'kubernetes.io/docs', 'helm.sh/docs']

/** Domains excluded from the "only check non-standard hosts" URL filter. */
const KNOWN_HOST_SUBSTRINGS = [
  'github.com',
  'kubernetes.io',
  'google.com',
  'microsoft.com',
  'cloudflare.com',
  'docker.com',
  'docker.io',
  'quay.io',
  'ghcr.io',
  'gcr.io',
  'registry.k8s.io',
  'elastic.co',
  'grafana.com',
  'bitnami.com',
]

/** Maximum number of non-standard URLs spot-checked per file (matches original bash `head -10`). */
const MAX_URLS_PER_FILE = 10

/** Loads a mission file (JSON or YAML) into a plain object. */
export function loadMission(path) {
  const raw = readFileSync(path, 'utf8')
  if (path.endsWith('.yaml') || path.endsWith('.yml')) {
    return yaml.load(raw)
  }
  return JSON.parse(raw)
}

/**
 * Checks step-level content quality for an install mission (ported from
 * the "Validate mission quality" bash+python block, which only runs
 * against `fixes/cncf-install/install-*.{json,yaml,yml}`).
 */
export function checkMissionQuality(mission) {
  const errors = []
  const warnings = []
  const steps = mission?.mission?.steps ?? []

  steps.forEach((step, i) => {
    const desc = step?.description ?? ''
    const title = step?.title ?? '?'

    if (!desc.includes('```')) {
      errors.push(`Step ${i} ("${title}") has no code blocks — skeleton step`)
    }

    if (desc.includes('kubectl edit deployment')) {
      const hasOtherCommand = /kubectl\s+(apply|create|set|patch|rollout|scale)|helm\s+(install|upgrade)|docker\s+run|kustomize/.test(
        desc
      )
      if (!hasOtherCommand) {
        errors.push(`Step ${i} ("${title}") contains only kubectl edit deployment placeholder`)
      }
    }

    const localApplies = [...desc.matchAll(/kubectl apply -f\s+(\S+)/g)].map(m => m[1])
    for (const target of localApplies) {
      if (target.startsWith('http') || target === '-') continue
      if (desc.includes('<<') && desc.includes('EOF')) continue
      if (target.startsWith('$')) continue
      warnings.push(`Step ${i}: kubectl apply -f ${target} — local file not provided inline`)
    }
  })

  return { errors, warnings }
}

/** Extracts non-oci:// Helm repo URLs referenced by a mission (ported from the python block). */
export function extractHelmRepos(mission) {
  const text = JSON.stringify(mission ?? {})
  const urls = new Set()
  for (const m of text.matchAll(/helm repo add \S+ (https?:\/\/[^\s"\\]+)/g)) {
    const url = m[1].replace(/[.,;)]+$/, '')
    if (!url.startsWith('oci://')) urls.add(url)
  }
  const repo = mission?.metadata?.helmRepoUrl ?? ''
  if (repo && !repo.startsWith('oci://')) urls.add(repo)
  return [...urls]
}

/** Extracts container images referenced by mission metadata, skipping known placeholders. */
export function extractContainerImages(mission) {
  const images = mission?.metadata?.containerImages ?? []
  return images.filter(img => img && !img.includes('registry/org') && !img.includes('your-docker'))
}

/** Extracts non-standard-host URLs from a mission, up to `MAX_URLS_PER_FILE` (ported from the python block). */
export function extractUrls(mission) {
  const text = JSON.stringify(mission ?? {})
  const urls = []
  for (const m of text.matchAll(/https?:\/\/[^\s"\\]+/g)) {
    const url = m[0].replace(/[.,;)]+$/, '')
    if (SKIP_URL_SUBSTRINGS.some(skip => url.includes(skip))) continue
    const isKnownHost = KNOWN_HOST_SUBSTRINGS.some(known => url.includes(known))
    if (url.includes('raw.githubusercontent.com') || !isKnownHost) {
      urls.push(url)
      if (urls.length >= MAX_URLS_PER_FILE) break
    }
  }
  return urls
}

/** Default HTTP HEAD-style check (via `curl`) matching the original bash's connect/timeout options. */
function defaultCheckUrl(url) {
  try {
    const code = execFileSync(
      'curl',
      ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '5', '--max-time', '10', url],
      { encoding: 'utf8' }
    ).trim()
    return code
  } catch {
    return '000'
  }
}

/** Default container image existence check (via `crane digest`), matching the original bash. */
function defaultCheckImage(img) {
  try {
    execFileSync('crane', ['digest', img], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Validates the content of `files` (paths as produced by the workflow's
 * `git diff --name-only` step). `installFiles` should be the subset
 * matching `fixes/cncf-install/install-*.{json,yaml,yml}` (step-quality
 * checks only apply there, matching the original workflow's separate
 * glob). `checkUrl`/`checkImage` are injectable for unit testing without
 * real network calls; they default to the same `curl`/`crane` behavior
 * as the original bash.
 *
 * Exported for unit testing; does not call process.exit or console.log.
 */
export function runContentValidation(
  files,
  installFiles,
  { checkUrl = defaultCheckUrl, checkImage = defaultCheckImage } = {}
) {
  let errors = 0
  let warnings = 0
  let filesValidated = 0
  const findings = []

  const installSet = new Set(installFiles ?? [])

  for (const filePath of files) {
    let mission
    try {
      mission = loadMission(filePath)
    } catch {
      continue
    }
    filesValidated += 1

    if (installSet.has(filePath)) {
      const quality = checkMissionQuality(mission)
      for (const message of quality.errors) findings.push({ level: 'error', filePath, message })
      for (const message of quality.warnings) findings.push({ level: 'warning', filePath, message })
      errors += quality.errors.length
      warnings += quality.warnings.length
    }

    for (const repo of extractHelmRepos(mission)) {
      const code = checkUrl(`${repo}/index.yaml`)
      if (code !== '200') {
        findings.push({ level: 'error', filePath, message: `Helm repo URL unreachable or invalid: ${repo} (HTTP ${code})` })
        errors += 1
      }
    }

    for (const img of extractContainerImages(mission)) {
      if (!checkImage(img)) {
        findings.push({ level: 'warning', filePath, message: `Container image not found in registry: ${img}` })
        warnings += 1
      }
    }

    for (const url of extractUrls(mission)) {
      const code = checkUrl(url)
      if (code === '000' || code === '404') {
        findings.push({ level: 'warning', filePath, message: `URL unreachable or 404: ${url}` })
        warnings += 1
      }
    }
  }

  return { filesValidated, errors, warnings, findings }
}

/**
 * CLI entry, exported for in-process testing (matches the runCli convention
 * of the sibling scripts refactored in PRs #3401 and #3402). Returns a POSIX
 * exit code; does not call process.exit directly. Every side-effect (argv,
 * clock, logger, stdout/stderr, network probes) is injectable.
 */
export function runCli({
  argv = process.argv,
  now = () => Date.now(),
  logger = log,
  stdout = console.log,
  stderr = console.error,
  checkUrl = defaultCheckUrl,
  checkImage = defaultCheckImage,
} = {}) {
  const startedAt = now()
  // Same wire as `scripts/mission-safety-scan.mjs`: the (planned) workflow
  // will pass `git diff --name-only` output as a single quoted argument, so
  // paths arrive newline-separated. Splitting on any whitespace (`/\s+/`)
  // silently breaks a mission path containing a space or tab into two
  // nonexistent paths, and the runContentValidation loop's readFile catch
  // then skips them without emitting a finding — same bypass class as
  // console-kb#3470 (safety scanner) and the earlier scan-pr.mjs fix in
  // #3280. Split on newline only so whitespace-in-path is preserved.
  const files = argv
    .slice(2)
    .flatMap(a => a.split(/\r?\n/))
    .filter(Boolean)
  const installFiles = files.filter(f => /fixes\/cncf-install\/install-.*\.(json|yaml|yml)$/.test(f))

  const { filesValidated, errors, warnings, findings } = runContentValidation(
    files,
    installFiles,
    { checkUrl, checkImage }
  )

  for (const { level, filePath, message } of findings) {
    stdout(`::${level} file=${filePath}::${message}`)
  }

  const durationMs = now() - startedAt

  logger.summary('mission-content-validation-summary', {
    level: errors > 0 ? 'error' : 'info',
    filesValidated,
    errors,
    warnings,
    durationMs,
  })

  stdout('')
  stdout('=== Validation Summary ===')
  stdout(`Errors: ${errors}`)
  stdout(`Warnings: ${warnings}`)

  if (errors > 0) {
    stderr(`::error::Found ${errors} validation errors. Fix before merging.`)
    return 1
  }

  stdout('Content validation passed')
  return 0
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runCli())
}
