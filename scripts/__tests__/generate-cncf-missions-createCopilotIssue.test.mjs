// Unit tests for createCopilotIssue() in scripts/generate-cncf-missions.mjs.
//
// createCopilotIssue() drives the branch-create / file-write / PR-create /
// label / assignee GitHub API sequence used to hand a synthesized CNCF
// mission off to Copilot. It previously reported ~0% coverage: every path
// (dry run, missing token, ref lookup failure, "branch already exists",
// file-write failure, PR-create failure, label/assignee soft-failures, and
// the top-level catch) was only exercised by live runs, never by __tests__.
//
// githubApi() (the shared retrying read client) is mocked directly via
// vi.mock with importOriginal so githubHeaders/sleep/etc. keep their real
// implementations — only the ref-lookup read goes through the mock. The
// non-idempotent POST/PUT calls inside createCopilotIssue intentionally use
// raw fetch (see the comment at its call site), so those are stubbed via
// vi.stubGlobal('fetch', ...), mirroring the pattern already used in
// lib-cncf-github-client.test.mjs and generate-cncf-install-missions-fetch-helpers.test.mjs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const githubApiMock = vi.fn()

vi.mock('../lib/cncf-github-client.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, githubApi: (...args) => githubApiMock(...args) }
})

// ISSUE_TOKEN is captured into a module-level const from process.env at
// import time (not re-read per call), so it must be set before this import.
const originalIssueTokenForImport = process.env.ISSUE_TOKEN
process.env.ISSUE_TOKEN = 'test-token'
const { createCopilotIssue } = await import('../generate-cncf-missions.mjs')
if (originalIssueTokenForImport === undefined) delete process.env.ISSUE_TOKEN
else process.env.ISSUE_TOKEN = originalIssueTokenForImport

function jsonResponse({ status = 200, body = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

const sampleProject = {
  name: 'kubernetes',
  repo: 'kubernetes/kubernetes',
  maturity: 'graduated',
  category: 'orchestration',
}

function mockIssue(overrides = {}) {
  return {
    title: 'Pods stuck in Terminating state',
    body: 'Some issue body text',
    labels: [],
    comments: 2,
    reactions: { total_count: 15 },
    html_url: 'https://github.com/kubernetes/kubernetes/issues/1',
    number: 1,
    ...overrides,
  }
}

const resolution = { summary: 'Restart the kubelet', steps: ['Step 1'] }

// createCopilotIssue() logs its warn/error paths via the shared structured
// logger (scripts/lib/logger.mjs), which writes JSON lines directly to
// process.stderr rather than calling console.warn — see #3596. Spy on
// stderr and match against the JSON-embedded message text, mirroring
// enrich-install-missions-callLLM.test.mjs's pattern.
let warnSpy
let logSpy

function stderrContaining(substring) {
  return expect.stringContaining(JSON.stringify(substring).slice(1, -1))
}

beforeEach(() => {
  githubApiMock.mockReset()
  warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
  logSpy.mockRestore()
})

describe('createCopilotIssue', () => {
  it('returns dryRun result without calling the GitHub API when DRY_RUN=true', async () => {
    const originalDryRun = process.env.DRY_RUN
    process.env.DRY_RUN = 'true'
    vi.resetModules()
    const { createCopilotIssue: createCopilotIssueDryRun } = await import('../generate-cncf-missions.mjs')
    const result = await createCopilotIssueDryRun(sampleProject, mockIssue(), resolution, null)
    expect(result).toEqual({ dryRun: true, slug: expect.any(String) })
    expect(githubApiMock).not.toHaveBeenCalled()
    if (originalDryRun === undefined) delete process.env.DRY_RUN
    else process.env.DRY_RUN = originalDryRun
    vi.resetModules()
  })

  it('returns null when no ISSUE_TOKEN is available', async () => {
    // ISSUE_TOKEN is also a module-level const captured at import time, so
    // exercising the "no token" branch needs a fresh module instance too.
    const originalIssueToken = process.env.ISSUE_TOKEN
    const originalGithubToken = process.env.GITHUB_TOKEN
    delete process.env.ISSUE_TOKEN
    delete process.env.GITHUB_TOKEN
    vi.resetModules()
    const { createCopilotIssue: createCopilotIssueNoToken } = await import('../generate-cncf-missions.mjs')
    const result = await createCopilotIssueNoToken(sampleProject, mockIssue(), resolution, null)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('No ISSUE_TOKEN'))
    if (originalIssueToken === undefined) delete process.env.ISSUE_TOKEN
    else process.env.ISSUE_TOKEN = originalIssueToken
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalGithubToken
    vi.resetModules()
  })

  it('returns null when the master ref lookup fails', async () => {
    githubApiMock.mockResolvedValue({})
    const result = await createCopilotIssue(sampleProject, mockIssue(), resolution, null)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('Could not get master ref'))
  })

  it('returns null when branch creation fails with an unexpected error', async () => {
    githubApiMock.mockResolvedValue({ object: { sha: 'abc123' } })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 500, body: 'boom' })))
    const result = await createCopilotIssue(sampleProject, mockIssue(), resolution, null)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('Branch creation failed'))
  })

  it('continues past a "Reference already exists" branch error', async () => {
    githubApiMock.mockResolvedValue({ object: { sha: 'abc123' } })
    const fetchMock = vi.fn(async (url, init) => {
      if (url.endsWith('/git/refs')) {
        return jsonResponse({ status: 422, body: 'Reference already exists' })
      }
      if (url.includes('/contents/')) {
        return jsonResponse({ status: 500, body: 'file write failed' })
      }
      return jsonResponse({ status: 200, body: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await createCopilotIssue(sampleProject, mockIssue(), resolution, null)
    // Branch-exists is tolerated, so the flow proceeds to the file write,
    // which we fail here to confirm execution didn't stop at the branch step.
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('File creation failed'))
  })

  it('returns null when the mission file write fails', async () => {
    githubApiMock.mockResolvedValue({ object: { sha: 'abc123' } })
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/git/refs')) return jsonResponse({ status: 201, body: {} })
      if (url.includes('/contents/')) return jsonResponse({ status: 500, body: 'nope' })
      return jsonResponse({ status: 200, body: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await createCopilotIssue(sampleProject, mockIssue(), resolution, null)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('File creation failed'))
  })

  it('returns null when PR creation fails', async () => {
    githubApiMock.mockResolvedValue({ object: { sha: 'abc123' } })
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/git/refs')) return jsonResponse({ status: 201, body: {} })
      if (url.includes('/contents/')) return jsonResponse({ status: 201, body: {} })
      if (url.endsWith('/pulls')) return jsonResponse({ status: 422, body: 'validation failed' })
      return jsonResponse({ status: 200, body: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await createCopilotIssue(sampleProject, mockIssue(), resolution, null)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('PR creation failed'))
  })

  it('succeeds end-to-end and tolerates label/assignee failures', async () => {
    githubApiMock.mockResolvedValue({ object: { sha: 'abc123' } })
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/git/refs')) return jsonResponse({ status: 201, body: {} })
      if (url.includes('/contents/')) return jsonResponse({ status: 201, body: {} })
      if (url.endsWith('/pulls')) {
        return jsonResponse({ status: 201, body: { number: 42, html_url: 'https://github.com/kubestellar/console-kb/pull/42' } })
      }
      if (url.includes('/labels')) throw new Error('labels unavailable')
      if (url.includes('/assignees')) throw new Error('assignee unavailable')
      return jsonResponse({ status: 200, body: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await createCopilotIssue(sampleProject, mockIssue(), resolution, null)
    expect(result).toEqual({
      prNumber: 42,
      slug: expect.any(String),
      url: 'https://github.com/kubestellar/console-kb/pull/42',
    })
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('Could not add labels'))
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('Could not assign Copilot'))
  })

  it('returns null and logs when an unexpected exception is thrown mid-flow', async () => {
    githubApiMock.mockRejectedValue(new Error('network down'))
    const result = await createCopilotIssue(sampleProject, mockIssue(), resolution, null)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(stderrContaining('PR creation error'))
  })
})
