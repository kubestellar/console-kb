/**
 * install-gen-average-quality-score.test.mjs
 *
 * In-process coverage for `scripts/install-gen/average-quality-score.mjs`.
 *
 * The script was previously at 0% unit-test coverage because all its logic
 * ran unconditionally at top-level on import, making it untestable via
 * direct import and invisible to v8 when spawned as a subprocess (see
 * vitest.config.mjs note on subprocess coverage) — the same shape as
 * `scripts/platform/average-quality-score.mjs` before its #3587 refactor.
 *
 * After the matching refactor (kubestellar/console-kb#3791):
 *   - `readMissionsFromDir` is a pure helper with injectable `readdir` /
 *     `readFile` — all file-fanout branches are testable in-process.
 *   - `runCli` wires the injectables with real fs defaults and an
 *     injectable `stdout`, so the `excludeZero: true` aggregate path
 *     (kubestellar/console-kb#3508) is covered.
 *   - a top-level `import.meta.url` guard prevents execution on import.
 *
 * Refs kubestellar/console-kb#3791.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  readMissionsFromDir,
  runCli,
} from '../install-gen/average-quality-score.mjs'
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
    const { readdir, readFile } = makeFs({ 'fixes/cncf-install': {} })
    const result = readMissionsFromDir({ dir: 'fixes/cncf-install', readdir, readFile })
    expect(result).toEqual([])
  })

  it('filters out .gitkeep and non-.json files, keeps every other *.json', () => {
    const fs = makeFs({
      'fixes/cncf-install': {
        '.gitkeep': '',
        'mission-foo.json': '{"metadata":{"qualityScore":80}}',
        'notes.txt': '{"metadata":{"qualityScore":50}}',
        'mission-bar.json': '{"metadata":{"qualityScore":60}}',
      },
    })
    const result = readMissionsFromDir({ dir: 'fixes/cncf-install', ...fs })
    // only the two *.json files (excluding .gitkeep and the .txt) pass the filter
    expect(result).toHaveLength(2)
    const scores = result.map((m) => m.metadata?.qualityScore).sort((a, b) => a - b)
    expect(scores).toEqual([60, 80])
  })

  it('treats a parse error as {} instead of throwing or returning NaN', () => {
    const fs = makeFs({
      'fixes/cncf-install': {
        'mission-good.json': '{"metadata":{"qualityScore":70}}',
        'mission-bad.json': 'NOT VALID JSON {{{',
      },
    })
    const result = readMissionsFromDir({ dir: 'fixes/cncf-install', ...fs })
    expect(result).toHaveLength(2)
    // The bad file comes back as {} (no score), not a thrown error or NaN
    const hasEmpty = result.some((m) => Object.keys(m).length === 0)
    expect(hasEmpty).toBe(true)
    expect(Number.isNaN(averageQualityScore(result, { excludeZero: true }))).toBe(false)
  })

  it('emits a structured warn log (not silent) when a file fails to parse', () => {
    const fs = makeFs({
      'fixes/cncf-install': {
        'mission-bad.json': 'NOT VALID JSON {{{',
      },
    })
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    readMissionsFromDir({ dir: 'fixes/cncf-install', ...fs })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(writeSpy.mock.calls[0][0])
    expect(logged).toMatchObject({
      level: 'warn',
      component: 'install-gen-average-quality-score',
      file: 'mission-bad.json',
      dir: 'fixes/cncf-install',
    })
    writeSpy.mockRestore()
  })

  it('returns all missions when every file is a valid *.json', () => {
    const missions = [
      { metadata: { qualityScore: 80 } },
      { metadata: { qualityScore: 60 } },
      { metadata: { qualityScore: 100 } },
    ]
    const fs = makeFs({
      'fixes/cncf-install': Object.fromEntries(
        missions.map((m, i) => [`mission-${i}.json`, JSON.stringify(m)])
      ),
    })
    const result = readMissionsFromDir({ dir: 'fixes/cncf-install', ...fs })
    expect(result).toHaveLength(3)
    const scores = result.map((m) => m.metadata?.qualityScore).sort((a, b) => a - b)
    expect(scores).toEqual([60, 80, 100])
  })
})

// ── runCli ─────────────────────────────────────────────────────────────

describe('runCli', () => {
  it('prints 0 and returns 0 for an empty directory', () => {
    const { readdir, readFile } = makeFs({ 'fixes/cncf-install': {} })
    const captured = []
    const code = runCli({
      dir: 'fixes/cncf-install',
      readdir,
      readFile,
      stdout: (v) => captured.push(v),
    })
    expect(code).toBe(0)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toBe(0)
  })

  it('prints the average score across *.json files', () => {
    const fs = makeFs({
      'fixes/cncf-install': {
        'mission-a.json': '{"metadata":{"qualityScore":80}}',
        'mission-b.json': '{"metadata":{"qualityScore":60}}',
      },
    })
    const captured = []
    runCli({ dir: 'fixes/cncf-install', ...fs, stdout: (v) => captured.push(v) })
    expect(captured[0]).toBe(70)
  })

  it('excludes unscored (0) missions from the average (excludeZero: true)', () => {
    // Unlike the platform-install variant, this CLI calls averageQualityScore
    // with excludeZero: true (kubestellar/console-kb#3508) — an unscored
    // mission must not pull the average down to 0.
    const fs = makeFs({
      'fixes/cncf-install': {
        'mission-scored.json': '{"metadata":{"qualityScore":100}}',
        'mission-unscored.json': '{"metadata":{}}',
      },
    })
    const captured = []
    runCli({ dir: 'fixes/cncf-install', ...fs, stdout: (v) => captured.push(v) })
    expect(captured[0]).toBe(100)
  })

  it('ignores .gitkeep when computing the average', () => {
    const fs = makeFs({
      'fixes/cncf-install': {
        'mission-a.json': '{"metadata":{"qualityScore":100}}',
        '.gitkeep': '',
      },
    })
    const captured = []
    runCli({ dir: 'fixes/cncf-install', ...fs, stdout: (v) => captured.push(v) })
    expect(captured[0]).toBe(100)
  })

  it('returns exit code 0 even when all files fail to parse', () => {
    const fs = makeFs({
      'fixes/cncf-install': {
        'mission-broken.json': ':::not json:::',
      },
    })
    const captured = []
    const code = runCli({
      dir: 'fixes/cncf-install',
      ...fs,
      stdout: (v) => captured.push(v),
    })
    expect(code).toBe(0)
    // broken file → {}, excludeZero drops its 0 score → average of nothing = 0
    expect(captured[0]).toBe(0)
    expect(Number.isNaN(captured[0])).toBe(false)
  })
})
