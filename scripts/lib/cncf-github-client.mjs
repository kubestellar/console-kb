/**
 * GitHub API client and issue-mining helpers for the CNCF mission generator.
 *
 * Extracted from generate-cncf-missions.mjs (console-kb#3133 / #3332) so the
 * rate-limited GitHub REST client and high-engagement issue search can be
 * unit-tested independently of the mission-synthesis concerns that remain
 * in the main script.
 *
 * GITHUB_TOKEN and the tuning constants below are imported from the main
 * orchestrator module so there is a single source of truth for the token
 * and a single shared rate-limit budget across the generator run.
 */
import { GITHUB_TOKEN, MIN_REACTIONS, MAX_ISSUES_PER_PROJECT, MAX_RETRIES, BASE_BACKOFF_MS } from '../generate-cncf-missions.mjs'

let rateLimitRemaining = 5000
let rateLimitReset = 0

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForRateLimit() {
  if (rateLimitRemaining < 10) {
    const waitMs = Math.max(0, (rateLimitReset * 1000) - Date.now()) + 1000
    console.log(`  Rate limit low (${rateLimitRemaining} remaining), waiting ${Math.round(waitMs / 1000)}s...`)
    await sleep(waitMs)
  }
}

export async function githubApi(url, options = {}) {
  await waitForRateLimit()

  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'cncf-mission-generator/1.0',
  }
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000) })

      // Track rate limits from response headers
      const remaining = response.headers.get('x-ratelimit-remaining')
      const reset = response.headers.get('x-ratelimit-reset')
      if (remaining != null) rateLimitRemaining = parseInt(remaining, 10)
      if (reset != null) rateLimitReset = parseInt(reset, 10)

      if (response.status === 403 && rateLimitRemaining === 0) {
        const waitMs = Math.max(0, (rateLimitReset * 1000) - Date.now()) + 1000
        console.warn(`  Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry...`)
        await sleep(waitMs)
        continue
      }

      if (response.status === 422) {
        console.warn(`  GitHub API returned 422 for ${url}, skipping.`)
        return null
      }

      if (response.status >= 500) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt)
        console.warn(`  Server error ${response.status}, retrying in ${backoff}ms...`)
        await sleep(backoff)
        continue
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        console.warn(`  GitHub API ${response.status}: ${url} - ${body.slice(0, 200)}`)
        return null
      }

      return response.json()
    } catch (err) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt)
      console.warn(`  GitHub API request error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`)
      if (attempt < MAX_RETRIES - 1) await sleep(backoff)
    }
  }

  console.warn(`  GitHub API failed after ${MAX_RETRIES} retries: ${url}`)
  return null
}

async function findHighEngagementIssues(project) {
  const [owner, repo] = project.repo.split('/')

  /**
   * Filter out issues that are not user-facing and produce garbage missions.
   * These are internal dev tasks, proposals, discussions, meeting scheduling, etc.
   */
  function isNonUserFacingIssue(issue) {
    const title = (issue.title || '').toLowerCase()
    const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase())

    // Proposals, RFCs, design discussions — no actionable user steps
    if (/\b(proposal|rfc|design doc|discussion)\b/.test(title)) return true

    // Meeting scheduling, SIG organization
    if (/\b(meeting time|meeting schedule|sig\b.*\bproposal|community meeting)\b/.test(title)) return true

    // Internal dev tasks: linting, e2e tests, CI, code quality, refactoring
    if (/\b(golangci|lint|revive|e2e test|unit test|test coverage|testing coverage|code quality)\b/.test(title)) return true

    // LFX mentorship tasks — dev mentoring, not user features
    if (/\blfx.mentorship\b/.test(title)) return true

    // Umbrella/tracking issues — meta-issues with no single fix
    if (/\[umbrella\]/.test(title)) return true

    // Label-based filtering
    const nonUserLabels = ['kind/cleanup', 'kind/testing', 'kind/ci', 'kind/refactor',
      'area/testing', 'area/ci', 'sig/', 'lifecycle/stale', 'priority/awaiting-more-evidence']
    if (labels.some(l => nonUserLabels.some(nl => l.includes(nl)))) return true

    return false
  }

  // Maturity-weighted thresholds: graduated projects have more content,
  // so we can be less selective. Sandbox projects need higher bar.
  const maturityMultiplier = {
    graduated: 0.5,    // minReactions * 0.5 (lower threshold = more content)
    incubating: 1.0,   // default threshold
    sandbox: 2.0,      // higher threshold = only the best
  }
  const effectiveMinReactions = Math.max(3, Math.round(
    MIN_REACTIONS * (maturityMultiplier[project.maturity] || 1.0)
  ))

  const query = encodeURIComponent(
    `repo:${project.repo} is:issue is:closed linked:pr sort:reactions-+1`
  )
  const url = `https://api.github.com/search/issues?q=${query}&sort=reactions&order=desc&per_page=${MAX_ISSUES_PER_PROJECT}`

  const data = await githubApi(url)
  if (!data || !data.items) return []

  return data.items.filter(issue => {
    const reactions = issue.reactions?.total_count || 0
    const comments = issue.comments || 0
    if (reactions < effectiveMinReactions && comments < 10) return false
    // Filter out non-user-facing issues that produce garbage missions
    if (isNonUserFacingIssue(issue)) return false
    return true
  })
}

async function getIssueDetails(owner, repo, issueNumber) {
  const issueUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`
  const commentsUrl = `${issueUrl}/comments?per_page=30&sort=created&direction=desc`
  const eventsUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=50`

  const [issue, comments] = await Promise.all([
    githubApi(issueUrl),
    githubApi(commentsUrl),
  ])

  if (!issue) return null

  // Try to find linked PR from timeline events
  // Only accept PRs from the SAME repo — forks/other projects produce wrong resolutions
  let linkedPR = null
  try {
    const events = await githubApi(eventsUrl)
    if (events && Array.isArray(events)) {
      const crossRef = events.find(
        e => e.event === 'cross-referenced' && e.source?.issue?.pull_request
      )
      if (crossRef) {
        const prUrl = crossRef.source.issue.pull_request.url
        // Verify the PR is from the same repo (not a fork or different project)
        const expectedPrefix = `https://api.github.com/repos/${owner}/${repo}/pulls/`
        if (prUrl.startsWith(expectedPrefix)) {
          linkedPR = await githubApi(prUrl)
        } else {
          console.log(`    [SKIP PR] Cross-repo PR ignored: ${prUrl} (expected ${owner}/${repo})`)
        }
      }
    }
  } catch {
    // Timeline API may not be available; proceed without linked PR
  }

  // Verify linked PR was actually merged — closed-without-merging PRs
  // should not be used as resolution sources
  if (linkedPR && !linkedPR.merged) {
    console.log(`    [SKIP PR] Linked PR #${linkedPR.number} was closed without merging — skipping as resolution source`)
    linkedPR = null
  }

  return { issue, comments: comments || [], linkedPR }
}

/**
 * Fetch a summary of PR changes (file names + key diff lines).
 * Returns a compact string suitable for LLM context.
 */
async function fetchPRDiffSummary(owner, repo, prNumber) {
  try {
    const filesUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=10`
    const files = await githubApi(filesUrl)
    if (!files || !Array.isArray(files)) return null

    const lines = files.map(f => {
      let summary = `${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`
      // Include a snippet of the patch for key files
      if (f.patch && (f.filename.endsWith('.yaml') || f.filename.endsWith('.yml') ||
          f.filename.endsWith('.go') || f.filename.endsWith('.py') ||
          f.filename.endsWith('.ts') || f.filename.endsWith('.js'))) {
        const patchLines = f.patch.split('\n').filter(l => l.startsWith('+')).slice(0, 10)
        if (patchLines.length > 0) {
          summary += '\n' + patchLines.join('\n')
        }
      }
      return summary
    })

    return lines.join('\n\n')
  } catch {
    return null
  }
}

export { findHighEngagementIssues, getIssueDetails, fetchPRDiffSummary }
