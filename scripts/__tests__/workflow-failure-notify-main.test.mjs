/**
 * workflow-failure-notify-main.test.mjs
 *
 * Direct-import unit tests for `main()` and its private helpers
 * (`requireEnv`, `nowUtc`, the `switch (mode)` dispatch) in
 * scripts/workflow-failure-notify.mjs.
 *
 * Before this file, the script was only exercised end-to-end by
 * workflow-failure-notify-cli.test.mjs, which spawns it as a child
 * process. v8/vitest coverage instrumentation does not attribute
 * code executed in a spawned subprocess back to the file under test,
 * so `scripts/workflow-failure-notify.mjs` reported 0% coverage
 * despite being fully exercised by CI. This file calls the exported
 * `main()` in-process (mocking `node:child_process`'s `execFileSync`
 * for the `failed-jobs` mode, following the pattern used in
 * __tests__/mission-executor-non-dryrun-executeMission.test.mjs) so
 * the dispatch logic, env-var validation, and error-swallowing branch
 * are covered directly, independent of the subprocess test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSyncMock = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync: (...args) => execFileSyncMock(...args),
}))

async function loadModule() {
  vi.resetModules()
  return await import('../workflow-failure-notify.mjs')
}

describe('workflow-failure-notify.mjs main() — comment-body', () => {
  let writeSpy
  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the comment body and returns 0 when all required env vars are set', async () => {
    const { main } = await loadModule()
    const env = {
      WORKFLOW_NAME: 'CodeQL Analysis',
      RUN_ID: '123456789',
      RUN_URL: 'https://github.com/kubestellar/console-kb/actions/runs/123456789',
      NOW: '2026-10-06 20:00 UTC',
    }
    const result = main('comment-body', env)
    expect(result).toBe(0)
    const output = writeSpy.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toContain('`CodeQL Analysis` failed again.')
    expect(output).toContain('2026-10-06 20:00 UTC')
  })

  it('includes FAILED_JOBS when provided', async () => {
    const { main } = await loadModule()
    const env = {
      WORKFLOW_NAME: 'CodeQL Analysis',
      RUN_ID: '1',
      RUN_URL: 'https://example.test/runs/1',
      FAILED_JOBS: 'analyze (go), analyze (js)',
      NOW: '2026-10-06 20:00 UTC',
    }
    main('comment-body', env)
    const output = writeSpy.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toContain('analyze (go), analyze (js)')
  })

  it('falls back to the current UTC time when NOW is not set', async () => {
    const { main } = await loadModule()
    const env = {
      WORKFLOW_NAME: 'CodeQL Analysis',
      RUN_ID: '1',
      RUN_URL: 'https://example.test/runs/1',
    }
    main('comment-body', env)
    const output = writeSpy.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/)
  })
})

describe('workflow-failure-notify.mjs main() — issue-body', () => {
  let writeSpy
  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the issue body and returns 0 when all required env vars are set', async () => {
    const { main } = await loadModule()
    const env = {
      WORKFLOW_NAME: 'CodeQL Analysis',
      RUN_ID: '42',
      RUN_URL: 'https://example.test/runs/42',
      WORKFLOW_FILE: '.github/workflows/codeql.yml',
      NOW: '2026-10-06 20:00 UTC',
    }
    const result = main('issue-body', env)
    expect(result).toBe(0)
    const output = writeSpy.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toContain('.github/workflows/codeql.yml')
  })
})

describe('workflow-failure-notify.mjs main() — missing required env vars', () => {
  let writeSpy
  let exitSpy
  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exits 1 and reports the first missing required env var for comment-body', async () => {
    const { main } = await loadModule()
    main('comment-body', {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing required env var WORKFLOW_NAME'),
    )
  })

  it('exits 1 when WORKFLOW_FILE is missing for issue-body', async () => {
    const { main } = await loadModule()
    main('issue-body', {
      WORKFLOW_NAME: 'CodeQL Analysis',
      RUN_ID: '1',
      RUN_URL: 'https://example.test/runs/1',
    })
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing required env var WORKFLOW_FILE'),
    )
  })

  it('exits 1 and prints an unknown-mode error for an unrecognized mode', async () => {
    const { main } = await loadModule()
    main('bogus-mode', {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown mode 'bogus-mode'"),
    )
  })
})

describe('workflow-failure-notify.mjs main() — failed-jobs', () => {
  let writeSpy
  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    execFileSyncMock.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the comma-joined names of failed jobs', async () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        jobs: [
          { name: 'analyze (go)', conclusion: 'failure' },
          { name: 'analyze (js)', conclusion: 'success' },
          { name: 'build', conclusion: 'failure' },
        ],
      }),
    )
    const { main } = await loadModule()
    const result = main('failed-jobs', {
      REPOSITORY: 'kubestellar/console-kb',
      RUN_ID: '999',
    })
    expect(result).toBe(0)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['run', 'view', '999', '--repo', 'kubestellar/console-kb', '--json', 'jobs'],
      expect.any(Object),
    )
    const output = writeSpy.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toBe('analyze (go), build\n')
  })

  it('swallows a `gh run view` failure and prints an empty line, still returning 0', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('gh: command not found')
    })
    const { main } = await loadModule()
    const result = main('failed-jobs', {
      REPOSITORY: 'kubestellar/console-kb',
      RUN_ID: '999',
    })
    expect(result).toBe(0)
    const output = writeSpy.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toBe('\n')
  })

  it('exits 1 when REPOSITORY is missing', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    const { main } = await loadModule()
    main('failed-jobs', { RUN_ID: '1' })
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing required env var REPOSITORY'),
    )
  })
})
