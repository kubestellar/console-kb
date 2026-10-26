/**
 * jscpd-ratchet.cli.test.mjs
 *
 * End-to-end tests for `scripts/jscpd-ratchet.mjs`, the duplication ratchet
 * gate wired into `.github/workflows/scripts-tests.yml` (`duplication-check`
 * job). The script is top-level-side-effecting (reads `jscpd-baseline.json`
 * from cwd, shells out to `npx jscpd`, calls `process.exit`), so like the
 * other CLI scripts in this directory it can't be unit-tested by import —
 * it is spawned as a subprocess instead.
 *
 * A fake `npx` is placed first on PATH so these tests never depend on the
 * real jscpd binary or network access; it writes a `jscpd-report.json` whose
 * clone count is controlled by the FAKE_CLONES env var, exactly like the real
 * `npx jscpd --reporters console,json --output <dir>` would.
 *
 * Previously nothing in `__tests__/` covered this file (0% statements before
 * this test); a regression that inverted the `clones > baseline` comparison,
 * dropped the nonzero exit on regression, or stopped reading
 * `jscpd-baseline.json` would land past CI unnoticed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'jscpd-ratchet.mjs')
const JSCPD_CONFIG = resolve(__dirname, '..', '.jscpd.json')

let fakeBinDir

beforeAll(() => {
  // A fake `npx` that just writes a jscpd-style report.json containing
  // FAKE_CLONES clones into whatever --output dir it was given, instead of
  // actually running jscpd.
  fakeBinDir = mkdtempSync(join(tmpdir(), 'jscpd-fake-npx-'))
  const fakeNpx = join(fakeBinDir, 'npx')
  writeFileSync(
    fakeNpx,
    `#!/usr/bin/env node
const { writeFileSync } = require('fs')
const { join } = require('path')
const args = process.argv.slice(2)
const outDir = args[args.indexOf('--output') + 1]
const clones = Number(process.env.FAKE_CLONES || '0')
console.log(\`fake jscpd: emitting \${clones} clone(s)\`)
writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({ statistics: { total: { clones } } }))
`,
  )
  chmodSync(fakeNpx, 0o755)
})

afterAll(() => {
  rmSync(fakeBinDir, { recursive: true, force: true })
})

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jscpd-ratchet-cli-'))
  try {
    // The script reads '.jscpd.json' and 'jscpd-baseline.json' relative to cwd.
    writeFileSync(join(dir, '.jscpd.json'), readFileSync(JSCPD_CONFIG, 'utf8'))
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runScript(cwd, { baselineClones, fakeClones }) {
  writeFileSync(join(cwd, 'jscpd-baseline.json'), JSON.stringify({ clones: baselineClones }))
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      FAKE_CLONES: String(fakeClones),
      NO_COLOR: '1',
    },
  })
}

describe('jscpd-ratchet.mjs CLI', () => {
  it('exits 0 and reports the clone count when clones stay at the baseline', () => {
    withTempRepo(dir => {
      const result = runScript(dir, { baselineClones: 5, fakeClones: 5 })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('jscpd ratchet: 5 clone(s) found, baseline 5')
      expect(result.stdout).not.toContain('::notice::')
    })
  })

  it('exits 1 and prints an ::error:: annotation when clones exceed the baseline', () => {
    withTempRepo(dir => {
      const result = runScript(dir, { baselineClones: 5, fakeClones: 8 })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('::error::Duplication increased: 8 clones > baseline 5')
    })
  })

  it('exits 0 and prints a ::notice:: hint to ratchet down when clones drop below the baseline', () => {
    withTempRepo(dir => {
      const result = runScript(dir, { baselineClones: 5, fakeClones: 2 })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('jscpd ratchet: 2 clone(s) found, baseline 5')
      expect(result.stdout).toContain('::notice::Duplication decreased; lower "clones" in jscpd-baseline.json to 2 in this PR to ratchet.')
    })
  })

  it('exits non-zero when jscpd-baseline.json is missing from cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jscpd-ratchet-cli-nobaseline-'))
    try {
      writeFileSync(join(dir, '.jscpd.json'), readFileSync(JSCPD_CONFIG, 'utf8'))
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, FAKE_CLONES: '0' },
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/ENOENT|no such file/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
