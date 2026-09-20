/**
 * score-and-merge-mission-prs-main-inprocess.test.mjs
 *
 * In-process orchestration coverage for `main()` in
 * scripts/score-and-merge-mission-prs.mjs.
 *
 * The companion score-and-merge-mission-prs.test.mjs drives main() as a
 * *subprocess* with a shell-script `gh` shim. That is a legitimate and
 * necessary end-to-end check (see its own header comment) but it hits a
 * v8 coverage blind spot noted in scripts/vitest.config.mjs: v8 does not
 * instrument code executed inside a spawned subprocess, so every branch
 * of main() past the trivial "no recent PRs" early return — the merge
 * path, the blocked-by-required-checks path, the below-threshold path,
 * and the per-PR error-recovery path — reports as uncovered even though
 * it is exercised end-to-end (kubestellar/console-kb#3481).
 *
 * This file closes that gap by importing the module directly and calling
 * `main()` in-process, with `child_process.execFileSync` (the `gh()`
 * helper's only dependency) and `./quality-scorer.mjs` mocked via
 * `vi.mock`. That lets v8 attribute coverage to main()'s own frame while
 * still exercising every orchestration branch deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scoreMissionMock = vi.fn()

vi.mock('child_process', () => ({
  execFileSync: (...args) => execFileSyncMock(...args),
}))
vi.mock('../quality-scorer.mjs', () => ({
  scoreMission: (...args) => scoreMissionMock(...args),
}))

let execFileSyncMock

/** Base64-encode a mission object the way `gh api .../contents` would. */
function encodeMission(mission) {
  return Buffer.from(JSON.stringify(mission), 'utf8').toString('base64')
}

function makePr(overrides = {}) {
  return {
    number: 101,
    headRefName: 'cncf-mission-gen/example',
    title: 'Add example: fix mission',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/**
 * Build an execFileSync stub keyed on the `gh` subcommand. Each handler
 * receives the full argv (minus the leading 'gh') and returns the stdout
 * string, or throws an object shaped like the error execFileSync raises
 * on non-zero exit (with a `.stdout` property main() falls back to).
 */
function makeGhStub(handlers) {
  return (binary, args) => {
    expect(binary).toBe('gh')
    const [sub, action] = args
    const key = `${sub} ${action}`
    const handler = handlers[key]
    if (!handler) {
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`)
    }
    return handler(args)
  }
}

describe('score-and-merge-mission-prs.mjs main() — in-process orchestration', () => {
  let calls
  let consoleLogSpy
  let consoleErrorSpy

  beforeEach(() => {
    vi.resetModules()
    calls = []
    scoreMissionMock.mockReset()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function loadMain() {
    const mod = await import('../score-and-merge-mission-prs.mjs')
    return mod.main
  }

  it('merges a PR that passes both the quality score and required checks', async () => {
    const pr = makePr({ number: 201 })
    const mission = { mission: { title: 'T' } }
    execFileSyncMock = makeGhStub({
      'pr list': (args) => {
        calls.push(args.join(' '))
        return JSON.stringify([pr])
      },
      'pr diff': (args) => {
        calls.push(args.join(' '))
        return 'fixes/cncf-generated/example/fix.json\n'
      },
      'pr checks': (args) => {
        calls.push(args.join(' '))
        return JSON.stringify([
          { name: 'Mission Safety Scan', state: 'SUCCESS', bucket: 'pass' },
          { name: 'Validate Mission Schema', state: 'SUCCESS', bucket: 'pass' },
        ])
      },
      'pr comment': (args) => {
        calls.push(args.join(' '))
        return ''
      },
      'pr merge': (args) => {
        calls.push(args.join(' '))
        return ''
      },
      'api repos/{owner}/{repo}/contents/fixes%2Fcncf-generated%2Fexample%2Ffix.json?ref=cncf-mission-gen/example': (args) => {
        calls.push(args.join(' '))
        return encodeMission(mission)
      },
    })
    scoreMissionMock.mockReturnValue({ score: 92, pass: true, breakdown: { total: 92 } })

    const main = await loadMain()
    await main()

    expect(scoreMissionMock).toHaveBeenCalledWith(mission, 70)
    const mergeCall = calls.find((c) => c.startsWith('pr merge'))
    expect(mergeCall).toBe('pr merge 201 --squash --admin --delete-branch')
    const commentCall = calls.find((c) => c.startsWith('pr comment'))
    expect(commentCall).toContain('Auto-merge: quality score 92/100')
    expect(consoleLogSpy).toHaveBeenCalledWith('  -> Merged PR #201')
    expect(consoleLogSpy).toHaveBeenCalledWith('\nDone: 1 merged, 0 left for review')
  })

  it('blocks the merge and comments when a required check has not passed', async () => {
    const pr = makePr({ number: 202 })
    const mission = { mission: { title: 'T' } }
    execFileSyncMock = makeGhStub({
      'pr list': () => JSON.stringify([pr]),
      'pr diff': () => 'fixes/cncf-generated/example/fix.json\n',
      'pr checks': () =>
        JSON.stringify([
          { name: 'Mission Safety Scan', state: 'FAILURE', bucket: 'fail' },
          { name: 'Validate Mission Schema', state: 'SUCCESS', bucket: 'pass' },
        ]),
      'pr comment': (args) => {
        calls.push(args.join(' '))
        return ''
      },
      'api repos/{owner}/{repo}/contents/fixes%2Fcncf-generated%2Fexample%2Ffix.json?ref=cncf-mission-gen/example': () =>
        encodeMission(mission),
    })
    scoreMissionMock.mockReturnValue({ score: 88, pass: true, breakdown: {} })

    const main = await loadMain()
    await main()

    const commentCall = calls.find((c) => c.startsWith('pr comment'))
    expect(commentCall).toContain(
      "Auto-merge blocked: quality score 88/100 passed, but required check 'Mission Safety Scan' has not passed (state: FAILURE)",
    )
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "  -> Blocked: required check 'Mission Safety Scan' not passed (state: FAILURE)",
    )
    expect(consoleLogSpy).toHaveBeenCalledWith('\nDone: 0 merged, 1 left for review')
  })

  it('leaves a below-threshold PR open with an explanatory comment', async () => {
    const pr = makePr({ number: 203 })
    const mission = { mission: { title: 'T' } }
    execFileSyncMock = makeGhStub({
      'pr list': () => JSON.stringify([pr]),
      'pr diff': () => 'fixes/cncf-generated/example/fix.json\n',
      'pr comment': (args) => {
        calls.push(args.join(' '))
        return ''
      },
      'api repos/{owner}/{repo}/contents/fixes%2Fcncf-generated%2Fexample%2Ffix.json?ref=cncf-mission-gen/example': () =>
        encodeMission(mission),
    })
    scoreMissionMock.mockReturnValue({ score: 40, pass: false, breakdown: { total: 40 } })

    const main = await loadMain()
    await main()

    const commentCall = calls.find((c) => c.startsWith('pr comment'))
    expect(commentCall).toContain('Quality score 40/100 — below threshold (70)')
    expect(consoleLogSpy).toHaveBeenCalledWith('  -> Below threshold, left open for review')
    expect(consoleLogSpy).toHaveBeenCalledWith('\nDone: 0 merged, 1 left for review')
    // pr checks must never be consulted for a PR that fails scoring.
    expect(calls.some((c) => c.startsWith('pr checks'))).toBe(false)
  })

  it('skips a PR with no mission JSON changed and continues without scoring it', async () => {
    const pr = makePr({ number: 204 })
    execFileSyncMock = makeGhStub({
      'pr list': () => JSON.stringify([pr]),
      'pr diff': () => 'README.md\nfixes/index.json\n',
    })

    const main = await loadMain()
    await main()

    expect(scoreMissionMock).not.toHaveBeenCalled()
    expect(consoleLogSpy).toHaveBeenCalledWith('PR #204: no mission JSON found, skipping')
    expect(consoleLogSpy).toHaveBeenCalledWith('\nDone: 0 merged, 0 left for review')
  })

  it('recovers from a per-PR error and still reports it as failed instead of throwing', async () => {
    const pr = makePr({ number: 205 })
    execFileSyncMock = makeGhStub({
      'pr list': () => JSON.stringify([pr]),
      'pr diff': () => {
        throw new Error('network timeout talking to gh')
      },
    })

    const main = await loadMain()
    await expect(main()).resolves.toBeUndefined()

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'PR #205: error - network timeout talking to gh',
    )
    expect(consoleLogSpy).toHaveBeenCalledWith('\nDone: 0 merged, 1 left for review')
  })

  it('returns early and never calls gh again when there are no recent PRs', async () => {
    execFileSyncMock = makeGhStub({
      'pr list': (args) => {
        calls.push(args.join(' '))
        return '[]'
      },
    })

    const main = await loadMain()
    await main()

    expect(calls).toEqual(['pr list --label cncf-mission-gen --state open --json number,headRefName,title,createdAt --limit 50'])
    expect(consoleLogSpy).toHaveBeenCalledWith('Found 0 recent mission PRs (last 6h)')
    // The early-return branch does not print the "Done: ..." summary.
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Done:'))
  })
})
