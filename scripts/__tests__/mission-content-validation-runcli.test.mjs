import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runCli } from '../mission-content-validation.mjs'

// In-process runCli tests for mission-content-validation.mjs. Mirrors the
// convention landed for render-step-summary (PR #3401) and
// render-ci-step-summary (PR #3402) under issue #3398: v8 coverage does not
// attribute subprocess `spawnSync` execution to the parent, so the CLI
// entry point had to be exported as `runCli({...injectables})` and
// exercised in the same worker before its lines could be measured.

function makeLogger() {
  const summaries = []
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
      summary(name, payload) {
        summaries.push({ name, payload })
      },
    },
    summaries,
  }
}

function makeStd() {
  const out = []
  const err = []
  return {
    stdout: (line) => out.push(String(line)),
    stderr: (line) => err.push(String(line)),
    out,
    err,
  }
}

describe('mission-content-validation.mjs runCli (in-process)', () => {
  let workdir
  let cwd

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'mcv-runcli-'))
    cwd = process.cwd()
    process.chdir(workdir)
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(workdir, { recursive: true, force: true })
  })

  function writeMission(relPath, mission) {
    const abs = join(workdir, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, JSON.stringify(mission))
  }

  it('empty argv → exit 0, prints "Content validation passed", emits summary with zero counters', () => {
    const { logger, summaries } = makeLogger()
    const { stdout, stderr, out, err } = makeStd()
    const code = runCli({
      argv: ['node', 'mission-content-validation.mjs'],
      now: () => 1000,
      logger,
      stdout,
      stderr,
    })
    expect(code).toBe(0)
    expect(out).toContain('Content validation passed')
    expect(out).toContain('=== Validation Summary ===')
    expect(out).toContain('Errors: 0')
    expect(out).toContain('Warnings: 0')
    expect(err).toEqual([])
    expect(summaries).toHaveLength(1)
    expect(summaries[0].name).toBe('mission-content-validation-summary')
    expect(summaries[0].payload).toMatchObject({
      level: 'info',
      filesValidated: 0,
      errors: 0,
      warnings: 0,
      durationMs: 0,
    })
  })

  it('splits whitespace-joined argv (matches workflow `run: node ... "$FILES"` convention)', () => {
    const goodPath = 'fixes/cncf-install/install-good.json'
    writeMission(goodPath, {
      mission: {
        steps: [{ title: 'Install', description: '```\nhelm install foo bar\n```' }],
      },
    })
    const { logger } = makeLogger()
    const { stdout, stderr, out } = makeStd()
    // A single positional arg with embedded whitespace mirrors how the
    // workflow expands "$FILES" into one process.argv[2] entry.
    const code = runCli({
      argv: ['node', 'mission-content-validation.mjs', `${goodPath}  \t  ${goodPath}`],
      now: () => 0,
      logger,
      stdout,
      stderr,
      checkUrl: () => '200',
      checkImage: () => true,
    })
    expect(code).toBe(0)
    expect(out).toContain('Errors: 0')
  })

  it('errors → exit 1 and stderr::error line (skeleton install-*.json step)', () => {
    const badPath = 'fixes/cncf-install/install-bad.json'
    writeMission(badPath, {
      mission: {
        steps: [{ title: 'Install', description: 'Do the thing manually.' }],
      },
    })
    const { logger, summaries } = makeLogger()
    const { stdout, stderr, out, err } = makeStd()
    // Time monotonically advances 0 → 42 so durationMs is deterministic.
    const times = [0, 42]
    const code = runCli({
      argv: ['node', 'mission-content-validation.mjs', badPath],
      now: () => times.shift() ?? 42,
      logger,
      stdout,
      stderr,
      checkUrl: () => '200',
      checkImage: () => true,
    })
    expect(code).toBe(1)
    // Per-finding annotation on stdout.
    expect(out.some(l => l.startsWith('::error file='))).toBe(true)
    expect(out).toContain('Errors: 1')
    // Summary line on stderr.
    expect(err.length).toBe(1)
    expect(err[0]).toMatch(/::error::Found 1 validation errors/)
    // Structured summary carries the error count and durationMs delta.
    expect(summaries[0].payload).toMatchObject({
      level: 'error',
      filesValidated: 1,
      errors: 1,
      warnings: 0,
      durationMs: 42,
    })
  })

  it('warnings only → exit 0, stderr empty, warning appears on stdout', () => {
    const goodPath = 'fixes/cncf-install/install-warn.json'
    writeMission(goodPath, {
      mission: {
        steps: [{ title: 'Install', description: '```\nhelm install foo bar\n```' }],
      },
      metadata: {
        containerImages: ['ghcr.io/kubestellar/does-not-exist:v0'],
      },
    })
    const { logger, summaries } = makeLogger()
    const { stdout, stderr, out, err } = makeStd()
    const code = runCli({
      argv: ['node', 'mission-content-validation.mjs', goodPath],
      now: () => 0,
      logger,
      stdout,
      stderr,
      checkUrl: () => '200',
      // Force the image-check branch to fail (a warning, not an error).
      checkImage: () => false,
    })
    expect(code).toBe(0)
    expect(out).toContain('Warnings: 1')
    expect(out).toContain('Errors: 0')
    expect(out.some(l => l.startsWith('::warning file='))).toBe(true)
    expect(err).toEqual([])
    expect(summaries[0].payload).toMatchObject({
      level: 'info',
      filesValidated: 1,
      errors: 0,
      warnings: 1,
    })
  })

  it('unloadable file (non-existent path) is silently skipped, filesValidated stays 0', () => {
    const { logger, summaries } = makeLogger()
    const { stdout, stderr, out } = makeStd()
    const code = runCli({
      argv: ['node', 'mission-content-validation.mjs', 'does/not/exist.json'],
      now: () => 0,
      logger,
      stdout,
      stderr,
    })
    expect(code).toBe(0)
    expect(out).toContain('Content validation passed')
    expect(summaries[0].payload.filesValidated).toBe(0)
  })
})
