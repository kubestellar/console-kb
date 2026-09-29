/**
 * platform-average-quality-score.test.mjs
 *
 * In-process coverage for `scripts/platform/average-quality-score.mjs`.
 *
 * The script was previously at 0% unit-test coverage because all its logic
 * ran unconditionally at top-level on import (lines 13-23), making it
 * untestable via direct import and invisible to v8 when spawned as a
 * subprocess (see vitest.config.mjs note on subprocess coverage).
 *
 * After the refactor (kubestellar/console-kb#3587):
 *   - `readMissionsFromDir` is a pure helper with injectable `readdir` /
 *     `readFile` — all file-fanout branches are testable in-process.
 *   - `runCli` wires the injectables with real fs defaults and an
 *     injectable `stdout`, so the aggregate console.log path is covered.
 *   - `isMainModule` prevents top-level execution on import.
 *
 * Refs kubestellar/console-kb#3587.
 */
import { describe, it, expect } from 'vitest'
import {
  readMissionsFromDir,
  runCli,
} from '../platform/average-quality-score.mjs'
import { averageQualityScore } from '../lib/mission-quality-stats.mjs'


// ── helpers ────────────────────────────────────────────────────────────

function makeFs(fileMap) {
  return {
    readdir: (dir) => Object.keys(fileMap[dir] ?? {}),
    readFile: (path) => {
      const dir = Object.keys(fileMap).find((d) => path.startsWith(d))
      const filename = path.slice(dir.length + 1)
      const content = fileMap[dir]?.[filename]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
  }
}

// ── readMissionsFromDir ────────────────────────────────────────────────

describe('readMissionsFromDir', () => {
  it('returns [] for an empty directory', () => {
    const { readdir, readFile } = makeFs({ 'fixes/platform-install': {} })
    const result = readMissionsFromDir({ dir: 'fixes/platform-install', readdir, readFile })
    expect(result).toEqual([])
  })

  it('filters out files that do not start with platform- or end with .json', () => {
    const fs = makeFs({
      'fixes/platform-install': {
        'platform-foo.json': '{"metadata":{"qualityScore":80}}',
        'not-platform.json': '{"metadata":{"qualityScore":99}}',
        'platform-bar.txt': '{"metadata":{"qualityScore":50}}',
        'platform-baz.json': '{"metadata":{"qualityScore":60}}',
      },
    })
    const result = readMissionsFromDir({ dir: 'fixes/platform-install', ...fs })
    // only platform-*.json files pass the filter
    expect(result).toHaveLength(2)
    const scores = result.map((m) => m.metadata?.qualityScore).sort((a, b) => a - b)
    expect(scores).toEqual([60, 80])
  })

  it('treats a parse error as {} instead of throwing or returning NaN', () => {
    const fs = makeFs({
      'fixes/platform-install': {
        'platform-good.json': '{"metadata":{"qualityScore":70}}',
        'platform-bad.json': 'NOT VALID JSON {{{',
      },
    })
    const result = readMissionsFromDir({ dir: 'fixes/platform-install', ...fs })
    expect(result).toHaveLength(2)
    // The bad file comes back as {} (no score), not a thrown error or NaN
    const hasEmpty = result.some((m) => Object.keys(m).length === 0)
    expect(hasEmpty).toBe(true)
    // averageQualityScore still works on the list — no NaN
    expect(Number.isNaN(averageQualityScore(result))).toBe(false)
  })

  it('returns all missions when every file is a valid platform-*.json', () => {
    const missions = [
      { metadata: { qualityScore: 80 } },
      { metadata: { qualityScore: 60 } },
      { metadata: { qualityScore: 100 } },
    ]
    const fs = makeFs({
      'fixes/platform-install': Object.fromEntries(
        missions.map((m, i) => [`platform-${i}.json`, JSON.stringify(m)])
      ),
    })
    const result = readMissionsFromDir({ dir: 'fixes/platform-install', ...fs })
    expect(result).toHaveLength(3)
    const scores = result.map((m) => m.metadata?.qualityScore).sort((a, b) => a - b)
    expect(scores).toEqual([60, 80, 100])
  })

  it('average matches averageQualityScore called on the same array', async () => {
    const missions = [
      { metadata: { qualityScore: 70 } },
      { metadata: { qualityScore: 90 } },
    ]
    const fs = makeFs({
      'fixes/platform-install': Object.fromEntries(
        missions.map((m, i) => [`platform-${i}.json`, JSON.stringify(m)])
      ),
    })
    const result = readMissionsFromDir({ dir: 'fixes/platform-install', ...fs })
    expect(averageQualityScore(result)).toBe(80)
  })
})

// ── runCli ─────────────────────────────────────────────────────────────

describe('runCli', () => {
  it('prints 0 and returns 0 for an empty directory', () => {
    const { readdir, readFile } = makeFs({ 'fixes/platform-install': {} })
    const captured = []
    const code = runCli({
      dir: 'fixes/platform-install',
      readdir,
      readFile,
      stdout: (v) => captured.push(v),
    })
    expect(code).toBe(0)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toBe(0)
  })

  it('prints the average score across platform-*.json files', () => {
    const fs = makeFs({
      'fixes/platform-install': {
        'platform-a.json': '{"metadata":{"qualityScore":80}}',
        'platform-b.json': '{"metadata":{"qualityScore":60}}',
      },
    })
    const captured = []
    runCli({ dir: 'fixes/platform-install', ...fs, stdout: (v) => captured.push(v) })
    expect(captured[0]).toBe(70)
  })

  it('ignores non-platform files when computing the average', () => {
    const fs = makeFs({
      'fixes/platform-install': {
        'platform-a.json': '{"metadata":{"qualityScore":100}}',
        'index.json': '{"metadata":{"qualityScore":999}}',
        'other.json': '{"metadata":{"qualityScore":999}}',
      },
    })
    const captured = []
    runCli({ dir: 'fixes/platform-install', ...fs, stdout: (v) => captured.push(v) })
    // Only platform-a.json counted → average 100, not 999
    expect(captured[0]).toBe(100)
  })

  it('returns exit code 0 even when all files fail to parse', () => {
    const fs = makeFs({
      'fixes/platform-install': {
        'platform-broken.json': ':::not json:::',
      },
    })
    const captured = []
    const code = runCli({
      dir: 'fixes/platform-install',
      ...fs,
      stdout: (v) => captured.push(v),
    })
    expect(code).toBe(0)
    // broken file → {}, averageQualityScore([{}]) = 0
    expect(captured[0]).toBe(0)
    expect(Number.isNaN(captured[0])).toBe(false)
  })
})
