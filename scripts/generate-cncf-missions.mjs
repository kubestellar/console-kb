#!/usr/bin/env node
/**
 * Crawls CNCF project repos for high-engagement issues and generates
 * kc-mission-v1 formatted missions from them.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { CNCF_PROJECTS, CATEGORY_TO_DIR } from './cncf-projects.mjs'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const MIN_REACTIONS = parseInt(process.env.MIN_REACTIONS || '10', 10)
const TARGET_PROJECTS = process.env.TARGET_PROJECTS
  ? process.env.TARGET_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
  : null
const DRY_RUN = process.env.DRY_RUN === 'true'
const SOLUTIONS_DIR = join(process.cwd(), 'solutions', 'cncf-generated')
const MAX_ISSUES_PER_PROJECT = 20
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 2000

let rateLimitRemaining = 5000
let rateLimitReset = 0

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForRateLimit() {
  if (rateLimitRemaining < 10) {
    const waitMs = Math.max(0, (rateLimitReset * 1000) - Date.now()) + 1000
    console.log(`  Rate limit low (${rateLimitRemaining} remaining), waiting ${Math.round(waitMs / 1000)}s...`)
    await sleep(waitMs)
  }
}

async function githubApi(url, options = {}) {
  await waitForRateLimit()

  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'cncf-mission-generator/1.0',
  }
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })

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
      throw new Error(`GitHub API ${response.status}: ${url} - ${body.slice(0, 200)}`)
    }

    return response.json()
  }

  throw new Error(`GitHub API failed after ${MAX_RETRIES} retries: ${url}`)
}

async function findHighEngagementIssues(project) {
  const [owner, repo] = project.repo.split('/')
  const query = encodeURIComponent(
    `repo:${project.repo} is:issue is:closed linked:pr sort:reactions-+1`
  )
  const url = `https://api.github.com/search/issues?q=${query}&sort=reactions&order=desc&per_page=${MAX_ISSUES_PER_PROJECT}`

  const data = await githubApi(url)
  if (!data || !data.items) return []

  return data.items.filter(issue => {
    const reactions = issue.reactions?.total_count || 0
    const comments = issue.comments || 0
    return reactions >= MIN_REACTIONS || comments >= 10
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
  let linkedPR = null
  try {
    const events = await githubApi(eventsUrl)
    if (events && Array.isArray(events)) {
      const crossRef = events.find(
        e => e.event === 'cross-referenced' && e.source?.issue?.pull_request
      )
      if (crossRef) {
        const prUrl = crossRef.source.issue.pull_request.url
        linkedPR = await githubApi(prUrl)
      }
    }
  } catch {
    // Timeline API may not be available; proceed without linked PR
  }

  return { issue, comments: comments || [], linkedPR }
}

function extractResolutionFromIssue(issue, comments, linkedPR) {
  const resolution = {
    problem: '',
    solution: '',
    yamlSnippets: [],
    steps: [],
  }

  // Extract problem from issue body
  const body = issue.body || ''
  const problemMatch = body.match(/## (?:Problem|Description|Bug Report|Issue)\s*\n([\s\S]*?)(?=\n## |\n---|\Z)/i)
  resolution.problem = problemMatch
    ? cleanText(problemMatch[1]).slice(0, 1000)
    : cleanText(body).slice(0, 1000)

  // Extract solution from linked PR body first, then fallback to comments
  if (linkedPR?.body) {
    const prBody = linkedPR.body
    const solutionMatch = prBody.match(/## (?:Solution|Fix|Changes|Description)\s*\n([\s\S]*?)(?=\n## |\n---|\Z)/i)
    resolution.solution = solutionMatch
      ? cleanText(solutionMatch[1]).slice(0, 1500)
      : cleanText(prBody).slice(0, 1500)
  }

  // If no PR-based solution, look for resolution in comments (from maintainers or closing comments)
  if (!resolution.solution && comments.length > 0) {
    const resolutionComment = comments.find(c =>
      c.author_association === 'MEMBER' ||
      c.author_association === 'COLLABORATOR' ||
      c.author_association === 'OWNER' ||
      c.body?.toLowerCase().includes('fixed in') ||
      c.body?.toLowerCase().includes('resolved by') ||
      c.body?.toLowerCase().includes('the fix')
    )
    if (resolutionComment) {
      resolution.solution = cleanText(resolutionComment.body).slice(0, 1500)
    } else {
      // Use last comment as fallback
      resolution.solution = cleanText(comments[0].body || '').slice(0, 1500)
    }
  }

  // Extract YAML/code blocks from all sources
  const allText = [body, linkedPR?.body || '', ...comments.map(c => c.body || '')].join('\n')
  const codeBlocks = allText.matchAll(/```(?:ya?ml|json|bash|shell|sh)?\s*\n([\s\S]*?)```/g)
  for (const match of codeBlocks) {
    const snippet = match[1].trim()
    if (snippet.length > 10 && snippet.length < 5000) {
      resolution.yamlSnippets.push(snippet)
    }
    if (resolution.yamlSnippets.length >= 5) break
  }

  // Extract numbered steps from resolution text
  const stepsSource = resolution.solution || resolution.problem
  const stepsMatch = stepsSource.match(/(?:^|\n)\s*\d+[\.\)]\s+.+/g)
  if (stepsMatch) {
    resolution.steps = stepsMatch
      .map(s => s.replace(/^\s*\d+[\.\)]\s+/, '').trim())
      .filter(s => s.length > 5)
      .slice(0, 10)
  }

  return resolution
}

function cleanText(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function detectMissionType(issue) {
  const text = `${issue.title} ${(issue.labels || []).map(l => l.name).join(' ')}`.toLowerCase()
  if (text.includes('bug') || text.includes('crash') || text.includes('error') || text.includes('fix')) return 'troubleshoot'
  if (text.includes('upgrade') || text.includes('migration') || text.includes('breaking') || text.includes('deprecat')) return 'upgrade'
  if (text.includes('deploy') || text.includes('install') || text.includes('setup') || text.includes('helm')) return 'deploy'
  if (text.includes('performance') || text.includes('slow') || text.includes('memory') || text.includes('cpu') || text.includes('leak')) return 'analyze'
  if (text.includes('security') || text.includes('cve') || text.includes('vulnerab')) return 'troubleshoot'
  return 'troubleshoot'
}

function extractLabels(issue) {
  return (issue.labels || [])
    .map(l => (typeof l === 'string' ? l : l.name))
    .filter(Boolean)
    .map(l => l.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
    .slice(0, 10)
}

function extractResourceKinds(issue) {
  const text = `${issue.title} ${issue.body || ''}`.toLowerCase()
  const kinds = []
  const k8sResources = [
    'pod', 'deployment', 'service', 'ingress', 'configmap', 'secret',
    'statefulset', 'daemonset', 'job', 'cronjob', 'namespace',
    'persistentvolumeclaim', 'persistentvolume', 'storageclass',
    'serviceaccount', 'clusterrole', 'clusterrolebinding',
    'role', 'rolebinding', 'networkpolicy', 'node',
    'replicaset', 'horizontalpodautoscaler', 'poddisruptionbudget',
    'customresourcedefinition', 'mutatingwebhookconfiguration',
    'validatingwebhookconfiguration',
  ]
  for (const kind of k8sResources) {
    if (text.includes(kind)) {
      kinds.push(kind.charAt(0).toUpperCase() + kind.slice(1))
    }
  }
  return [...new Set(kinds)].slice(0, 8)
}

function estimateDifficulty(issue) {
  const body = (issue.body || '').toLowerCase()
  const title = issue.title.toLowerCase()
  const text = `${title} ${body}`
  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || '')).join(' ').toLowerCase()
  const commentCount = issue.comments || 0

  let score = 0

  // Long discussion = harder
  if (commentCount > 30) score += 3
  else if (commentCount > 15) score += 2
  else if (commentCount > 5) score += 1

  // Labels hint at complexity
  if (labels.includes('priority/critical') || labels.includes('severity/critical')) score += 2
  if (labels.includes('kind/cleanup') || labels.includes('good first issue')) score -= 2

  // Content complexity
  if (text.includes('race condition') || text.includes('deadlock') || text.includes('data loss')) score += 3
  if (text.includes('upgrade') || text.includes('migration')) score += 2
  if (text.includes('config') || text.includes('flag') || text.includes('env var')) score -= 1

  if (score <= 0) return 'beginner'
  if (score <= 2) return 'intermediate'
  if (score <= 4) return 'advanced'
  return 'expert'
}

function generateMission(project, issue, resolution) {
  const mission = {
    format: 'kc-mission-v1',
    exportedAt: new Date().toISOString(),
    exportedBy: 'cncf-mission-generator',
    consoleVersion: 'auto-generated',
    mission: {
      title: `${project.name}: ${issue.title}`,
      description: resolution.problem || issue.body?.slice(0, 500) || issue.title,
      type: detectMissionType(issue),
      status: 'completed',
      resolution: {
        summary: resolution.solution || 'See linked PR for details.',
        steps: resolution.steps.length > 0
          ? resolution.steps
          : ['Review the issue discussion for context', 'Apply the fix from the linked pull request'],
      },
    },
    metadata: {
      tags: [
        project.name,
        project.maturity,
        project.category,
        ...extractLabels(issue),
      ].filter((v, i, a) => a.indexOf(v) === i),
      category: CATEGORY_TO_DIR[project.category] || 'troubleshooting',
      cncfProjects: [project.name],
      targetResourceKinds: extractResourceKinds(issue),
      difficulty: estimateDifficulty(issue),
      sourceIssue: issue.html_url,
      sourceRepo: project.repo,
      reactions: issue.reactions?.total_count || 0,
      comments: issue.comments || 0,
    },
    security: {
      scannedAt: new Date().toISOString(),
      scannerVersion: 'cncf-gen-1.0.0',
      sanitized: true,
      findings: [],
    },
  }

  // Include code snippets if available
  if (resolution.yamlSnippets.length > 0) {
    mission.mission.resolution.codeSnippets = resolution.yamlSnippets.slice(0, 3)
  }

  return mission
}

function deduplicateAgainstExisting(slug, projectDir) {
  if (!existsSync(projectDir)) return false
  const existing = readdirSync(projectDir)
  return existing.some(f => f.replace(/\.json$/, '') === slug)
}

function formatReport(report) {
  const lines = [
    '# CNCF Mission Generation Report',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Total generated:** ${report.generated}`,
    `**Skipped (duplicates):** ${report.skipped}`,
    `**Errors:** ${report.errors}`,
    '',
    '## Projects Processed',
    '',
    '| Project | Maturity | Issues Found | Missions Generated | Errors |',
    '|---------|----------|-------------|-------------------|--------|',
  ]

  for (const p of report.projects) {
    lines.push(
      `| ${p.name} | ${p.maturity} | ${p.issuesFound} | ${p.generated} | ${p.errors} |`
    )
  }

  if (report.generated > 0) {
    lines.push('', '## Generated Missions', '')
    for (const m of report.missions || []) {
      lines.push(`- **${m.title}** (${m.difficulty}) — [source](${m.sourceIssue})`)
    }
  }

  return lines.join('\n')
}

async function main() {
  if (!GITHUB_TOKEN) {
    console.warn('Warning: GITHUB_TOKEN not set. API rate limits will be very low.')
  }

  const projects = TARGET_PROJECTS
    ? CNCF_PROJECTS.filter(p => TARGET_PROJECTS.includes(p.name))
    : CNCF_PROJECTS

  if (projects.length === 0) {
    console.error('No matching projects found for:', TARGET_PROJECTS)
    process.exit(1)
  }

  console.log(`Processing ${projects.length} CNCF projects (min_reactions=${MIN_REACTIONS}, dry_run=${DRY_RUN})`)

  mkdirSync(SOLUTIONS_DIR, { recursive: true })

  const report = { generated: 0, skipped: 0, errors: 0, projects: [], missions: [] }

  for (const project of projects) {
    const [owner, repo] = project.repo.split('/')
    const projectReport = { name: project.name, maturity: project.maturity, issuesFound: 0, generated: 0, errors: 0 }
    console.log(`\nProcessing ${project.name} (${project.repo})...`)

    try {
      const issues = await findHighEngagementIssues(project)
      projectReport.issuesFound = issues.length
      console.log(`  Found ${issues.length} high-engagement issues`)

      const projectDir = join(SOLUTIONS_DIR, project.name)
      mkdirSync(projectDir, { recursive: true })

      for (const issue of issues) {
        const slug = slugify(`${project.name}-${issue.number}-${issue.title}`)

        if (deduplicateAgainstExisting(slug, projectDir)) {
          console.log(`  Skipping duplicate: ${slug}`)
          report.skipped++
          continue
        }

        try {
          console.log(`  Processing issue #${issue.number}: ${issue.title.slice(0, 60)}...`)
          const details = await getIssueDetails(owner, repo, issue.number)
          if (!details) {
            console.warn(`  Could not fetch details for #${issue.number}, skipping.`)
            continue
          }

          const resolution = extractResolutionFromIssue(
            details.issue,
            details.comments,
            details.linkedPR
          )

          const mission = generateMission(project, details.issue, resolution)
          const filePath = join(projectDir, `${slug}.json`)

          if (DRY_RUN) {
            console.log(`  [DRY RUN] Would write: ${filePath}`)
          } else {
            writeFileSync(filePath, JSON.stringify(mission, null, 2) + '\n')
            console.log(`  Written: ${slug}.json`)
          }

          report.generated++
          projectReport.generated++
          report.missions.push({
            title: mission.mission.title,
            difficulty: mission.metadata.difficulty,
            sourceIssue: mission.metadata.sourceIssue,
          })

          // Small delay between issue fetches to be a good API citizen
          await sleep(200)
        } catch (err) {
          console.error(`  Error processing issue #${issue.number}: ${err.message}`)
          projectReport.errors++
          report.errors++
        }
      }
    } catch (err) {
      console.error(`Error processing ${project.name}: ${err.message}`)
      projectReport.errors++
      report.errors++
    }

    report.projects.push(projectReport)

    // Brief pause between projects
    await sleep(500)
  }

  // Write generation report for PR body
  const reportPath = join(process.cwd(), 'generation-report.md')
  writeFileSync(reportPath, formatReport(report))
  console.log(`\nReport written to: ${reportPath}`)
  console.log(`Done: ${report.generated} generated, ${report.skipped} skipped, ${report.errors} errors`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
