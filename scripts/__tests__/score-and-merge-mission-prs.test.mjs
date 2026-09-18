/**
 * score-and-merge-mission-prs.test.mjs
 *
 * Structural / CLI-orchestration coverage for
 * scripts/score-and-merge-mission-prs.mjs, the entry point invoked by the
 * "Score and auto-merge passing mission PRs" step of
 * .github/workflows/cncf-mission-gen.yml.
 *
 * Previously nothing under __tests__/ imported or spawned this file. Its
 * helper library (lib/mission-auto-merge.mjs) is well-covered, but the CLI
 * that wires those helpers to `gh` had zero direct regression tests, so:
 *   - a silent removal of the LOOKBACK_HOURS filter,
 *   - a broken `gh pr list` argv (label / state / json fields),
 *   - or an accidental unguarded top-level main() call that would run on
 *     any bare `import '../score-and-merge-mission-prs.mjs'`
 * would all land past CI unnoticed.
 *
 * We drive main() end-to-end as a subprocess with a stub `gh` on PATH that
 * returns an empty PR list, which is the only branch we can exercise
 * hermetically without a live GitHub API. That is enough to lock in:
 *   1. The script actually invokes `gh pr list ...` and parses its JSON.
 *   2. The "no recent PRs" early-return path prints the expected header
 *      line and exits 0 without touching any other `gh` subcommand.
 *   3. The `import.meta.url === file://...` guard: `import`ing the module
 *      by URL from a helper script must NOT trigger main() (i.e. must not
 *      shell out to `gh` at all).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'score-and-merge-mission-prs.mjs')

/**
 * Write an executable shell shim named `gh` into `dir` that logs every
 * invocation to `logPath` (one JSON line per call: {args}) and returns
 * `stdout` on argv matching `match` (a shell test), otherwise exits 1.
 */
function writeGhShim(dir, { logPath, stdoutForListPrs }) {
  const script = `#!/usr/bin/env bash
echo "{\\"args\\": \\"$*\\"}" >> ${JSON.stringify(logPath)}
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  cat <<'JSON'
${stdoutForListPrs}
JSON
  exit 0
fi
echo "unexpected gh invocation: $*" 1>&2
exit 1
`
  const p = join(dir, 'gh')
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return p
}

function runScript({ shimDir, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    ...extraEnv,
  }
  return spawnSync(process.execPath, [SCRIPT], {
    env,
    encoding: 'utf-8',
  })
}

describe('score-and-merge-mission-prs.mjs (CLI)', () => {
  let workDir
  let logPath

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'score-and-merge-cli-'))
    logPath = join(workDir, 'gh-calls.log')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('prints "Found 0 recent mission PRs" and exits 0 when gh returns []', () => {
    writeGhShim(workDir, { logPath, stdoutForListPrs: '[]' })
    const res = runScript({ shimDir: workDir })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/Found 0 recent mission PRs \(last 6h\)/)
    // No other gh subcommands should be invoked on the empty branch.
    const calls = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).args)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^pr list /)
    expect(calls[0]).toMatch(/--label cncf-mission-gen/)
    expect(calls[0]).toMatch(/--state open/)
    expect(calls[0]).toMatch(/--json number,headRefName,title,createdAt/)
  })

  it('filters out PRs older than LOOKBACK_HOURS (6h) and still exits 0', () => {
    // A single PR with a createdAt 24h ago must be filtered out by
    // filterRecentPRs. The stub `gh` is only wired for `pr list`, so if
    // filtering were broken the script would attempt `pr diff` next and
    // the stub would exit 1, failing the test.
    const oldTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const prs = JSON.stringify([
      {
        number: 999,
        headRefName: 'cncf-mission-gen/old',
        title: 'stale PR',
        createdAt: oldTimestamp,
      },
    ])
    writeGhShim(workDir, { logPath, stdoutForListPrs: prs })
    const res = runScript({ shimDir: workDir })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/Found 0 recent mission PRs/)
  })

  it('does NOT execute main() when the module is only imported', () => {
    // Regression guard for the `import.meta.url === file://${argv[1]}`
    // check: importing the module by URL from a probe script must not
    // spawn `gh` at all. If the guard is removed or inverted, the shim
    // log would gain a `pr list` entry and this test would fail.
    writeGhShim(workDir, { logPath, stdoutForListPrs: '[]' })
    const probe = join(workDir, 'probe.mjs')
    writeFileSync(
      probe,
      `import(${JSON.stringify(SCRIPT)}).then((m) => { console.log('LOADED:' + typeof m.main) })\n`,
    )
    const res = spawnSync(process.execPath, [probe], {
      env: {
        ...process.env,
        PATH: `${workDir}:${process.env.PATH}`,
      },
      encoding: 'utf-8',
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/LOADED:function/)
    // The gh log must not exist (never invoked) or be empty.
    let logged = ''
    try {
      logged = readFileSync(logPath, 'utf-8')
    } catch {
      logged = ''
    }
    expect(logged).toBe('')
  })
})
