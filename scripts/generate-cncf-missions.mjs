#!/usr/bin/env node
/**
 * Crawls CNCF project repos for high-engagement issues and creates
 * GitHub issues for Copilot coding agent to synthesize into kc-mission-v1 missions.
 *
 * Flow: discover CNCF issues → create console-kb issues → Copilot generates mission PRs.
 *
 * Supports multiple knowledge sources (GitHub issues, Reddit, Stack Overflow,
 * GitHub Discussions) configured via knowledge-sources.yaml.
 * Tracks processed items in search-state.json for incremental runs.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CNCF_PROJECTS, CATEGORY_TO_DIR } from './cncf-projects.mjs'
import { OTHER_PROJECTS } from './other-projects.mjs'
import { loadSearchState, saveSearchState, getSourceState, updateSourceState, isProcessed } from './sources/search-state.mjs'
import { slugify as baseSlugify } from './sources/base-source.mjs'
import { RedditSource } from './sources/reddit.mjs'
import { StackOverflowSource } from './sources/stackoverflow.mjs'
import { GitHubDiscussionsSource } from './sources/github-discussions.mjs'
import { validateMissionExport } from './scanner.mjs'
import { scoreMission } from './quality-scorer.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
// PAT for issue creation — events from PATs trigger workflows (GITHUB_TOKEN events don't)
const ISSUE_TOKEN = process.env.ISSUE_TOKEN || process.env.GITHUB_TOKEN
const MIN_REACTIONS = parseInt(process.env.MIN_REACTIONS || '10', 10)
const TARGET_PROJECTS = process.env.TARGET_PROJECTS
  ? process.env.TARGET_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
  : null
const DRY_RUN = process.env.DRY_RUN === 'true'
const BATCH_INDEX = process.env.BATCH_INDEX != null ? parseInt(process.env.BATCH_INDEX, 10) : null
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '20', 10)
const FORCE_RESCAN = process.env.FORCE_RESCAN === 'true'
const ENABLED_SOURCES = process.env.ENABLED_SOURCES
  ? process.env.ENABLED_SOURCES.split(',').map(s => s.trim()).filter(Boolean)
  : null // null = use config file
const SOLUTIONS_DIR = join(process.cwd(), 'solutions', 'cncf-generated')
const MAX_ISSUES_PER_PROJECT = 20
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 2000
const MAX_COPILOT_ISSUES_PER_RUN = parseInt(process.env.MAX_COPILOT_ISSUES || '5', 10)
const ISSUE_LABEL_PREFIX = '[Mission Gen]'
const COPILOT_REPO_OWNER = process.env.COPILOT_REPO_OWNER || 'kubestellar'
const COPILOT_REPO_NAME = process.env.COPILOT_REPO_NAME || 'console-kb'

/**
 * Load knowledge-sources.yaml config. Falls back to defaults if missing.
 */
function loadSourcesConfig() {
  const configPath = join(__dirname, 'knowledge-sources.yaml')
  if (!existsSync(configPath)) {
    console.warn('Warning: knowledge-sources.yaml not found, using defaults')
    return { sources: { 'github-issues': { enabled: true, minReactions: 10, maxPerProject: 20, searchWindow: '90d' } } }
  }
  // Simple YAML parser for our flat structure (avoids needing js-yaml dependency)
  const raw = readFileSync(configPath, 'utf-8')
  return parseSimpleYaml(raw)
}

/**
 * Minimal YAML parser for our config format (no nested objects beyond 2 levels).
 */
function parseSimpleYaml(yaml) {
  const config = { sources: {} }
  let currentSource = null
  let lastArrayKey = null
  for (const line of yaml.split('\n')) {
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim().replace(/#.*$/, '').trimEnd()
    if (!trimmed) continue

    if (indent === 0 && trimmed === 'sources:') continue

    // Source name at 2-space indent
    if (indent === 2 && trimmed.endsWith(':') && !trimmed.includes(' ')) {
      currentSource = trimmed.replace(/:$/, '')
      config.sources[currentSource] = {}
      lastArrayKey = null
      continue
    }

    // Key-value pair at 4-space indent
    if (indent === 4 && currentSource) {
      // Bare key for array below (e.g. subreddits:)
      if (trimmed.endsWith(':') && !trimmed.includes(' ')) {
        lastArrayKey = trimmed.replace(/:$/, '')
        config.sources[currentSource][lastArrayKey] = []
        continue
      }

      const colonIdx = trimmed.indexOf(':')
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim()
        let val = trimmed.slice(colonIdx + 1).trim()
        lastArrayKey = null

        if (val === 'true') config.sources[currentSource][key] = true
        else if (val === 'false') config.sources[currentSource][key] = false
        else if (/^\d+$/.test(val)) config.sources[currentSource][key] = parseInt(val, 10)
        else if (val.startsWith('[') && val.endsWith(']')) {
          config.sources[currentSource][key] = val.slice(1, -1).split(',').map(s => s.trim())
        } else {
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
          }
          config.sources[currentSource][key] = val
        }
      }
    }

    // Array items at 6-space indent
    if (indent === 6 && trimmed.startsWith('- ') && currentSource && lastArrayKey) {
      config.sources[currentSource][lastArrayKey].push(trimmed.replace(/^- /, '').trim())
    }
  }
  return config
}

/**
 * Initialize source modules based on config.
 */
function initializeSources(config) {
  const sources = []

  for (const [id, sourceConfig] of Object.entries(config.sources)) {
    if (!sourceConfig.enabled) continue
    if (ENABLED_SOURCES && !ENABLED_SOURCES.includes(id)) continue

    switch (id) {
      case 'github-issues':
        // Built-in — handled by existing findHighEngagementIssues()
        sources.push({ id, builtin: true, config: sourceConfig })
        break
      case 'reddit':
        sources.push({ id, builtin: false, instance: new RedditSource(sourceConfig), config: sourceConfig })
        break
      case 'stackoverflow':
        sources.push({ id, builtin: false, instance: new StackOverflowSource(sourceConfig), config: sourceConfig })
        break
      case 'github-discussions':
        sources.push({ id, builtin: false, instance: new GitHubDiscussionsSource(sourceConfig), config: sourceConfig })
        break
      default:
        console.log(`  Unknown source: ${id}, skipping`)
    }
  }

  return sources
}

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
    return reactions >= effectiveMinReactions || comments >= 10
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

function extractResolutionFromIssue(issue, comments, linkedPR) {
  const resolution = {
    problem: '',
    solution: '',
    yamlSnippets: [],
    steps: [],
  }

  // Extract problem from issue body using flexible header matching
  const body = issue.body || ''
  const problemMatch = body.match(/#{1,4}\s*(?:problem|description|bug\s*report|issue|context|summary|background)\s*\n([\s\S]*?)(?=\n#{1,4}\s|\n---|\Z)/i)
  resolution.problem = problemMatch
    ? truncateAtWordBoundary(cleanText(problemMatch[1]), 1000)
    : truncateAtWordBoundary(cleanText(body), 1000)

  // Extract solution from linked PR body first, then fallback to comments
  if (linkedPR?.body) {
    const prBody = linkedPR.body
    const solutionMatch = prBody.match(/#{1,4}\s*(?:solution|fix|changes|description|approach|implementation|what\s+this\s+pr\s+does)\s*\n([\s\S]*?)(?=\n#{1,4}\s|\n---|\Z)/i)
    if (solutionMatch) {
      resolution.solution = truncateAtWordBoundary(cleanText(solutionMatch[1]), 1500)
    } else {
      // Try extracting from numbered template format (### 1. Why is this PR needed?)
      let extracted = extractFromNumberedTemplate(prBody)
      // Try extracting from bold-header template (**What type of PR is this?**)
      if (extracted === prBody) {
        extracted = extractFromBoldTemplate(prBody)
      }
      resolution.solution = truncateAtWordBoundary(cleanText(extracted), 1500)
    }
  }

  // If no PR-based solution, score comments and pick the best resolution
  if (!resolution.solution && comments.length > 0) {
    const scoredComments = comments
      .filter(c => c.body && c.body.length > 20)
      .map(c => {
        let score = 0
        const bodyLower = (c.body || '').toLowerCase()
        // Author authority
        if (c.author_association === 'OWNER') score += 10
        else if (c.author_association === 'MEMBER') score += 8
        else if (c.author_association === 'COLLABORATOR') score += 6
        else if (c.author_association === 'CONTRIBUTOR') score += 3
        // Resolution keywords
        if (bodyLower.includes('fixed in')) score += 5
        if (bodyLower.includes('resolved by')) score += 5
        if (bodyLower.includes('the fix')) score += 4
        if (bodyLower.includes('solution')) score += 3
        if (bodyLower.includes('workaround')) score += 3
        // Contains code = more actionable
        if (c.body.includes('```')) score += 4
        // Length bonus (more detail = better)
        if (c.body.length > 200) score += 2
        if (c.body.length > 500) score += 2
        return { comment: c, score }
      })
      .sort((a, b) => b.score - a.score)

    if (scoredComments.length > 0 && scoredComments[0].score > 0) {
      resolution.solution = truncateAtWordBoundary(cleanText(scoredComments[0].comment.body), 1500)
    }
  }

  // Extract YAML/code blocks from all sources, filtering out CI/bot garbage
  const allText = [body, linkedPR?.body || '', ...comments.map(c => c.body || '')].join('\n')
  const codeBlocks = allText.matchAll(/```(?:ya?ml|json|bash|shell|sh)?\s*\n([\s\S]*?)```/g)
  for (const match of codeBlocks) {
    const snippet = match[1].trim().replace(/\r\n/g, '\n')
    if (snippet.length > 10 && snippet.length < 5000 && !isGarbageSnippet(snippet)) {
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
    // Strip Codecov report blocks
    .replace(/# \[?Codecov\]?[\s\S]*?(?=\n#{1,4}\s|\n---|\n\n\n|$)/gi, '')
    // Strip image markdown that's just screenshots/badges (not content)
    .replace(/!\[.*?\]\(https?:\/\/[^)]+\)/g, '')
    // Strip Codecov table rows
    .replace(/\|[^|]*codecov[^|]*\|[^|]*\|[^|]*\|/gi, '')
    // Strip "Checklist:" sections and everything after (PR template boilerplate)
    .replace(/\n\s*Checklist:?\s*\n[\s\S]*$/gi, '')
    // Strip "Note on DCO:" sections
    .replace(/\n\s*Note on DCO:?\s*\n[\s\S]*?(?=\n#{1,4}\s|\n\n[A-Z]|\n---|\s*$)/gi, '')
    // Strip checkbox lines (DCO, PR template checklists)
    .replace(/^\s*[-*]\s*\[[ x]\]\s*.*/gm, '')
    // Strip "Please ensure your pull request adheres to the following guidelines" boilerplate
    .replace(/Please ensure your pull request adheres[\s\S]*?(?=\n#{1,4}\s|\n\n[A-Z]|\n---|\s*$)/gi, '')
    // Strip "For first time contributors" boilerplate
    .replace(/For first.time contributors[\s\S]*?(?=\n#{1,4}\s|\n\n[A-Z]|\n---|\s*$)/gi, '')
    // Strip orphaned "cc @user" and standalone "cc"
    .replace(/\bcc\s+@[a-zA-Z0-9_-]+/g, '')
    .replace(/\bcc\s*$/gm, '')
    // Strip numbered PR template headers
    .replace(/#{1,4}\s*\d+\.\s+(?:Why is this|Which issue|Which documentation|Does this introduce|Special notes|If applicable|Release note|What type|How has this|Additional context)[^\n]*/gi, '')
    // Strip bold-header PR template questions
    .replace(/\*\*(?:What type of PR|Any specific area|What this PR does|Which issue|Does this introduce|Additional context)[^*]*\*\*/gi, '')
    // Strip /kind, /area, /sig bot commands
    .replace(/^\s*>?\s*\/(?:kind|area|sig)\s+\w+.*$/gm, '')
    .replace(/^\s*>\s*Uncomment\s+.*/gm, '')
    // Strip common empty PR template section headers (Kyverno, Falco, etc.)
    .replace(/^\s*#{1,4}\s*(?:Checklist|Further Comments?|Milestone|Related issue|Proposed Changes?|Explanation)\s*$/gim, '')
    .replace(/^\s*#{1,4}\s*Milestone of this PR.*$/gim, '')
    // Strip bare issue references (e.g., "#6661") and "Closes: #N" lines
    .replace(/^\s*#\d+\s*$/gm, '')
    .replace(/^\s*(?:closes?|fixes?|resolves?):?\s+(?:#\d+|https:\/\/github\.com\/[^\s]+).*$/gim, '')
    // Strip GitHub asset URLs
    .replace(/https:\/\/github\.com\/[^/]+\/[^/]+\/assets\/\S+/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Detects garbage snippets that shouldn't be used as mission content.
 * Catches Codecov tables, CI bot messages, git diffs, image references, etc.
 */
function isGarbageSnippet(snippet) {
  const lower = snippet.toLowerCase()

  // Codecov coverage tables
  if (lower.includes('codecov') || lower.includes('coverage δ') || lower.includes('impacted files')) return true

  // Git diff output (not actionable YAML/config)
  if (snippet.startsWith('diff --git') || /^[+-]{3} [ab]\//.test(snippet)) return true

  // GitHub image references (not config)
  if ((snippet.match(/!\[.*?\]\(https?:\/\//g) || []).length > 2) return true

  // CI bot messages
  if (lower.includes('invalid pr title') || lower.includes('has been automatically marked as stale')) return true

  // Casual GitHub comment text (not code)
  if (lower.includes('yay thanks') || lower.includes('sorry about') || lower.includes('lgtm') || lower.includes('btw ')) return true

  // @mentions in snippet content (raw GitHub comments, not actual code)
  if ((snippet.match(/@[a-zA-Z0-9_-]+/g) || []).length >= 2) return true

  // Sentence fragments that aren't code (no special chars like =, {, }, :, $)
  const codeChars = /[={}$:;|><\[\]()]/
  if (!codeChars.test(snippet) && snippet.length < 200) return true

  // PR contribution guidelines
  if (lower.includes('for first time contributors') || lower.includes('please ensure your pull request')) return true

  // Benchmark/performance tables without actionable content
  if (lower.includes('query performance') && lower.includes('![image]')) return true

  // GitHub API JSON responses (not actionable config)
  if (lower.includes('"tag_name"') || lower.includes('"html_url"') || lower.includes('"created_at"')) return true
  if (lower.includes('api.github.com')) return true

  // Prose paragraphs pretending to be code — high ratio of English words to code tokens
  const words = snippet.split(/\s+/)
  const englishWords = words.filter(w => ENGLISH_STOPWORDS.has(w.toLowerCase()))
  const PROSE_THRESHOLD = 0.25 // if >25% of words are English stopwords, it's prose
  if (words.length > 10 && (englishWords.length / words.length) > PROSE_THRESHOLD) return true

  // Pure comment quoting (starts with >) without actionable content
  const lines = snippet.split('\n')
  const quotedLines = lines.filter(l => l.trim().startsWith('>')).length
  if (quotedLines > lines.length * 0.7 && lines.length > 3) return true

  return false
}

/**
 * Check if a project is Kubernetes-native (runs on or extends K8s).
 * Non-K8s projects (databases, web servers, etc.) should not get K8s prerequisites.
 */
const K8S_NATIVE_CATEGORIES = new Set([
  'orchestration', 'networking', 'security', 'observability',
  'runtime', 'storage', 'app-definition', 'ai-agents', 'llm-serving',
])

const NON_K8S_PROJECTS = new Set([
  'clickhouse', 'caddy', 'gitea', 'surrealdb', 'valkey', 'vault',
  'milvus', 'netdata', 'ollama', 'langflow', 'grpc', 'vllm',
  'podman-container-tools', 'lima', 'buildpacks', 'spin', 'cedar',
])

function isKubernetesNative(project) {
  if (NON_K8S_PROJECTS.has(project.name)) return false
  if (project.category && K8S_NATIVE_CATEGORIES.has(project.category)) return true
  // Projects with k8sVersions field are K8s-related
  if (project.k8sVersions && project.k8sVersions.length > 0) return true
  return true // default to true for CNCF projects
}

/**
 * Generate project-aware prerequisites instead of hardcoding K8s.
 */
function generatePrerequisites(project) {
  if (isKubernetesNative(project)) {
    return {
      kubernetes: '>=1.24',
      tools: ['kubectl'],
      description: `A running Kubernetes cluster with ${project.name} installed or the issue environment reproducible.`,
    }
  }

  // Non-K8s project — tailor prerequisites
  const tools = []
  if (project.type === 'ai-platform') tools.push('python', 'pip')
  else if (project.category === 'analytics-db') tools.push(project.name)
  else if (project.category === 'git-hosting') tools.push('docker', 'git')
  else tools.push(project.name)

  return {
    tools: tools.length > 0 ? tools : [project.name],
    description: `A working ${project.displayName || project.name} installation or development environment.`,
  }
}

/**
 * Truncate a string at the last word boundary before maxLen.
 * Avoids cutting words mid-character (e.g., "clea" instead of "clean up code").
 */
function truncateAtWordBoundary(text, maxLen) {
  if (!text || text.length <= maxLen) return text || ''
  const truncated = text.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(' ')
  // If no space found within first 20 chars, just use the hard cutoff
  const MIN_TRUNCATION_POINT = 20
  if (lastSpace < MIN_TRUNCATION_POINT) return truncated
  return truncated.slice(0, lastSpace)
}

/**
 * Truncate at the last sentence boundary (period followed by space or end)
 * within maxLen. Falls back to word boundary if no sentence break found.
 */
const MIN_SENTENCE_TRUNCATION_POINT = 50
function truncateAtSentenceBoundary(text, maxLen) {
  if (!text || text.length <= maxLen) return text || ''
  const truncated = text.slice(0, maxLen)
  // Find last sentence-ending punctuation followed by space or end
  const sentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('.\n'),
  )
  if (sentenceEnd >= MIN_SENTENCE_TRUNCATION_POINT) {
    return truncated.slice(0, sentenceEnd + 1) // include the period
  }
  // Fall back to word boundary
  return truncateAtWordBoundary(text, maxLen)
}

/**
 * Extract useful content from numbered PR templates.
 * Handles formats like "### 1. Why is this PR needed?\n...content...\n### 2. Which issues..."
 * Returns just the content paragraphs, stripping template question headers.
 */
function extractFromNumberedTemplate(text) {
  if (!text) return ''
  // Detect numbered template format: ### N. Question text
  const numberedSections = text.match(/#{1,4}\s*\d+\.\s+.+/g)
  if (!numberedSections || numberedSections.length < 2) return text // not a numbered template

  // Extract content between numbered headers
  const parts = text.split(/#{1,4}\s*\d+\.\s+.+\n?/)
  const contentParts = parts
    .map(p => p.trim())
    .filter(p => {
      if (p.length < 20) return false
      // Skip sections that are just issue references
      if (/^#\d+\s*$/.test(p) || /^https:\/\/github\.com/.test(p)) return false
      // Skip "Yes/No" answers to template questions
      if (/^(yes|no|none|n\/a)\.?\s*$/i.test(p)) return false
      // Skip conversational one-liners that aren't technical content
      if (p.length < 80 && /^(not that|i think|i believe|possibly|maybe|probably|sure|thanks|thank you)/i.test(p)) return false
      // Skip lines that are just issue/PR references
      if (/^#\d+[\s\n]*(?:#\d+[\s\n]*)*$/.test(p)) return false
      return true
    })

  return contentParts.join('\n\n')
}

/**
 * Extract content from bold-header PR templates (Falco, KEDA, etc).
 * Handles: "**What type of PR is this?**\n> Uncomment...\n**What this PR does:**\n..."
 * Returns only the content answers, not the template questions or uncomment instructions.
 */
function extractFromBoldTemplate(text) {
  if (!text) return ''
  const boldHeaders = text.match(/\*\*[^*]+\*\*/g)
  if (!boldHeaders || boldHeaders.length < 2) return text // not a bold-header template

  // Split on bold headers and extract content between them
  const parts = text.split(/\*\*[^*]+\*\*\s*\n?/)
  const contentParts = parts
    .map(p => p.trim())
    .filter(p => {
      if (p.length < 20) return false
      // Skip template instructions ("> Uncomment one...", "> /kind bug")
      if (/^>\s*(?:Uncomment|\/kind|\/area|\/sig)/m.test(p)) return false
      // Skip lines that are only /kind or /area commands
      if (/^(?:>\s*)?\/(?:kind|area|sig)\s+\w+$/gm.test(p) && p.length < 100) return false
      return true
    })

  return contentParts.join('\n\n')
}

/** Strip PR template boilerplate and return useful content only */
function stripPRTemplate(text) {
  if (!text) return ''
  let cleaned = text
  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '')
  // Remove PR template sections
  const templateHeaders = [
    /#{1,4}\s*What type of PR[\s\S]*?(?=\n#{1,4}\s|\n---|\Z)/gi,
    /#{1,4}\s*What this PR does[\s\S]*?(?=\n#{1,4}\s|\n---|\Z)/gi,
    /#{1,4}\s*Which issue.*?fixes[\s\S]*?(?=\n#{1,4}\s|\n---|\Z)/gi,
    /#{1,4}\s*Special notes for.*?reviewer[\s\S]*?(?=\n#{1,4}\s|\n---|\Z)/gi,
    /#{1,4}\s*If applicable[\s\S]*?(?=\n#{1,4}\s|\n---|\Z)/gi,
    /#{1,4}\s*Release note[\s\S]*?(?=\n#{1,4}\s|\n---|\Z)/gi,
    /#{1,4}\s*Does this PR introduce a user-facing[\s\S]*?(?=\n#{1,4}\s|\n---|\Z)/gi,
    /```release-note[\s\S]*?```/gi,
  ]
  for (const re of templateHeaders) {
    cleaned = cleaned.replace(re, '')
  }
  // Remove checkbox lines (including DCO checklists like "* [x] Either (a) I've created...")
  cleaned = cleaned.replace(/^\s*[-*]\s*\[[ x]\]\s*.*/gm, '')
  // Remove "Checklist:" header and everything after it (common PR template section)
  cleaned = cleaned.replace(/\n\s*Checklist:?\s*\n[\s\S]*$/gi, '')
  // Remove "Note on DCO:" blocks
  cleaned = cleaned.replace(/\n\s*Note on DCO:?\s*\n[\s\S]*?(?=\n#{1,4}\s|\n\n[A-Z]|\n---|\s*$)/gi, '')
  // Remove PR contribution guidelines boilerplate
  cleaned = cleaned.replace(/Please ensure your pull request adheres[\s\S]*?(?=\n#{1,4}\s|\n\n[A-Z]|\n---|\s*$)/gi, '')
  cleaned = cleaned.replace(/For first.time contributors[\s\S]*?(?=\n#{1,4}\s|\n\n[A-Z]|\n---|\s*$)/gi, '')
  // Remove "Please provide a description of this PR:" boilerplate
  cleaned = cleaned.replace(/^\s*Please provide a description of this PR:?\s*$/gm, '')
  // Remove bold-header PR template questions (**What type of PR is this?**, etc.)
  cleaned = cleaned.replace(/\*\*(?:What type of PR|Any specific area|What this PR does|Which issue|Does this introduce|Additional context)[^*]*\*\*/gi, '')
  // Remove /kind, /area, /sig lines (Prow/bot commands in PR templates)
  cleaned = cleaned.replace(/^\s*>?\s*\/(?:kind|area|sig)\s+\w+.*$/gm, '')
  // Remove "> Uncomment one" instruction lines
  cleaned = cleaned.replace(/^\s*>\s*Uncomment\s+.*/gm, '')
  // Remove "Closes #N" / "Fixes #N" / "Closes: #N" lines (with or without colon)
  cleaned = cleaned.replace(/^\s*(?:closes?|fixes?|resolves?):?\s+(?:#\d+|https:\/\/github\.com\/[^\s]+).*$/gim, '')
  // Remove Signed-off-by
  cleaned = cleaned.replace(/^\s*Signed-off-by:.*$/gm, '')
  // Remove /kind /lgtm /approve bot commands
  cleaned = cleaned.replace(/^\s*\/\w+.*$/gm, '')
  // Remove GitHub asset URLs (screenshots uploaded to github — not useful in text)
  cleaned = cleaned.replace(/https:\/\/github\.com\/[^/]+\/[^/]+\/assets\/\S+/g, '')
  // Remove @username mentions and orphaned "cc" prefixes (e.g., "cc @user" → "cc " → "")
  cleaned = cleaned.replace(/\bcc\s+@[a-zA-Z0-9_-]+/g, '')
  cleaned = cleaned.replace(/@[a-zA-Z0-9_-]+/g, '')
  // Remove standalone orphaned "cc" left after mention stripping
  cleaned = cleaned.replace(/\bcc\s*$/gm, '')
  // Remove "Credit where credit is due:" attribution lines
  cleaned = cleaned.replace(/^\s*Credit where credit is due:.*$/gm, '')
  // Remove "Demo:" lines with GitHub URLs
  cleaned = cleaned.replace(/^\s*Demo:.*github\.com.*$/gm, '')
  // Strip numbered PR template headers (### 1. Why is this PR needed?, ### 2. Which issues?, etc.)
  cleaned = cleaned.replace(/#{1,4}\s*\d+\.\s+(?:Why is this|Which issue|Which documentation|Does this introduce|Special notes|If applicable|Release note|What type|How has this|Additional context)[^\n]*/gi, '')
  // Strip bare issue references left over from template sections (e.g., "#6661\n#6638")
  cleaned = cleaned.replace(/^\s*#\d+\s*$/gm, '')
  // Collapse whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  return cleaned
}

/**
 * Basic heuristic to detect non-English text.
 * Checks for common English stopwords — if fewer than 10% of words are English
 * stopwords, the text is likely non-English.
 */
const ENGLISH_STOPWORDS = new Set([
  'the', 'is', 'in', 'it', 'of', 'and', 'to', 'a', 'for', 'that', 'this',
  'with', 'on', 'are', 'was', 'be', 'as', 'by', 'or', 'an', 'not', 'but',
  'from', 'at', 'have', 'has', 'had', 'will', 'can', 'do', 'if', 'when',
  'which', 'their', 'would', 'been', 'were', 'there', 'should', 'we', 'you',
])
const MIN_ENGLISH_STOPWORD_RATIO = 0.08
function isLikelyEnglish(text) {
  if (!text || text.length < 50) return true // too short to judge
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (words.length < 10) return true // too few words to judge
  const stopwordCount = words.filter(w => ENGLISH_STOPWORDS.has(w)).length
  return (stopwordCount / words.length) >= MIN_ENGLISH_STOPWORD_RATIO
}

/** Check if a mission has enough quality to be useful */
function passesQualityGate(resolution, issue) {
  // Must have a real problem description (not just template junk)
  const desc = stripPRTemplate(resolution.problem || issue.body || '')
  if (desc.length < 50) return false

  // Must have either: real steps, a meaningful solution, or code snippets
  const hasSteps = resolution.steps.length >= 2
  const hasSolution = (resolution.solution || '').length > 100
  const hasCode = resolution.yamlSnippets.length > 0

  if (!hasSteps && !hasSolution && !hasCode) return false

  // Reject non-English content (heuristic: check solution and problem text)
  if (!isLikelyEnglish(resolution.solution || '') && (resolution.solution || '').length > 50) return false
  if (!isLikelyEnglish(resolution.problem || '') && (resolution.problem || '').length > 50) return false

  // Reject if solution is empty after stripping — means no real fix was found
  const strippedSolution = stripPRTemplate(resolution.solution || '')
  const MIN_SOLUTION_LENGTH = 80
  if (strippedSolution.length < MIN_SOLUTION_LENGTH && resolution.yamlSnippets.length === 0) {
    return false
  }

  // Reject if solution is mostly a commit message (short + contains "Closes:" or "Fixes:")
  if (strippedSolution.length < 150 && /(?:closes?|fixes?|resolves?):?\s*#\d+/i.test(strippedSolution)) {
    return false
  }

  return true
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
  // Bug/error patterns — check first since these override feature keywords
  if (text.includes('bug') || text.includes('crash') || text.includes('error') || text.includes('fix')) return 'troubleshoot'
  // Session/auth issues are troubleshooting, not features
  if (text.includes('logged out') || text.includes('timeout') || text.includes('session expir') || text.includes('stopped working') || text.includes('not working') || text.includes('fails') || text.includes('failing') || text.includes('broken') || text.includes('unable') || text.includes('does not work') || text.includes('doesn\'t work') || text.includes('cannot') || text.includes('can\'t')) return 'troubleshoot'
  if (text.includes('upgrade') || text.includes('migration') || text.includes('breaking') || text.includes('deprecat')) return 'upgrade'
  if (text.includes('deploy') || text.includes('install') || text.includes('setup') || text.includes('helm')) return 'deploy'
  if (text.includes('performance') || text.includes('slow') || text.includes('memory') || text.includes('cpu') || text.includes('leak')) return 'analyze'
  if (text.includes('security') || text.includes('cve') || text.includes('vulnerab')) return 'troubleshoot'
  // Feature/enhancement keywords — default for PRs that add new functionality
  if (text.includes('feat') || text.includes('add') || text.includes('implement') || text.includes('support') || text.includes('new') || text.includes('enhance') || text.includes('introduce')) return 'feature'
  return 'feature'
}

function extractLabels(issue) {
  return (issue.labels || [])
    .map(l => (typeof l === 'string' ? l : l.name))
    .filter(Boolean)
    .map(l => l.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
    .slice(0, 10)
}

function extractResourceKinds(issue, project) {
  // Only extract K8s resource kinds for K8s-native projects
  if (project && !isKubernetesNative(project)) return []

  const text = `${issue.title} ${issue.body || ''}`.toLowerCase()
  const kinds = []
  // Use word-boundary matching to avoid false positives (e.g., "role" in "user role")
  const k8sResources = [
    'pod', 'deployment', 'ingress', 'configmap',
    'statefulset', 'daemonset', 'cronjob', 'namespace',
    'persistentvolumeclaim', 'persistentvolume', 'storageclass',
    'serviceaccount', 'clusterrole', 'clusterrolebinding',
    'rolebinding', 'networkpolicy',
    'replicaset', 'horizontalpodautoscaler', 'poddisruptionbudget',
    'customresourcedefinition', 'mutatingwebhookconfiguration',
    'validatingwebhookconfiguration',
  ]
  // Ambiguous words that need explicit K8s context (kubectl/helm/k8s mention) to count
  // "service" matches microservice/web service, "secret" matches client secret,
  // "role" matches user role, "node" matches Node.js
  const AMBIGUOUS_KINDS = new Set(['job', 'role', 'node', 'service', 'secret'])
  const hasK8sContext = /\bkubectl\b|\bkubernetes\b|\bk8s\b|\bhelm\b|\bkubeconfig\b/i.test(text)

  for (const kind of k8sResources) {
    // Use word boundary regex to avoid substring matches
    const regex = new RegExp(`\\b${kind}s?\\b`, 'i')
    if (regex.test(text)) {
      kinds.push(kind.charAt(0).toUpperCase() + kind.slice(1))
    }
  }

  // Only include ambiguous kinds if there's clear K8s context
  if (hasK8sContext) {
    for (const kind of AMBIGUOUS_KINDS) {
      const regex = new RegExp(`\\b${kind}s?\\b`, 'i')
      if (regex.test(text)) {
        kinds.push(kind.charAt(0).toUpperCase() + kind.slice(1))
      }
    }
  }

  const MAX_RESOURCE_KINDS = 3
  return [...new Set(kinds)].slice(0, MAX_RESOURCE_KINDS)
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
  // Multi-component setups are harder (e.g., EKS + VPC CNI + Cilium chaining)
  if (text.includes('chaining') || text.includes('cni') || text.includes('vpc')) score += 2
  if (text.includes('wireguard') || text.includes('encryption') || text.includes('ipsec')) score += 1
  if (text.includes('bpf') || text.includes('ebpf') || text.includes('datapath')) score += 2
  if (text.includes('kernel') || text.includes('iptables') || text.includes('nftables')) score += 1
  // Integration scenarios with multiple products
  const productMentions = ['eks', 'gke', 'aks', 'openshift', 'rancher', 'aws', 'azure', 'gcp'].filter(p => text.includes(p))
  if (productMentions.length >= 2) score += 2
  else if (productMentions.length >= 1) score += 1

  if (score <= 0) return 'beginner'
  if (score <= 2) return 'intermediate'
  if (score <= 4) return 'advanced'
  return 'expert'
}

/**
 * Create a GitHub issue for Copilot to generate a mission from.
 * Returns the issue number if created, null if skipped/failed.
 */
async function createCopilotIssue(project, issue, resolution, linkedPR) {
  const slug = slugify(`${project.name}-${issue.number}-${issue.title}`)
  const missionType = detectMissionType(issue)
  const difficulty = estimateDifficulty(issue)
  const filePath = `solutions/cncf-generated/${project.name}/${slug}.json`

  if (DRY_RUN) {
    console.log(`    [DRY RUN] Would create PR for: ${project.name}: ${truncateAtWordBoundary(issue.title, 60)}`)
    return { dryRun: true, slug }
  }

  const token = ISSUE_TOKEN
  if (!token) {
    console.warn('    [SKIP] No ISSUE_TOKEN available for PR creation')
    return null
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
  }
  const apiBase = `https://api.github.com/repos/${COPILOT_REPO_OWNER}/${COPILOT_REPO_NAME}`

  try {
    // 1. Get master branch SHA
    const refResp = await fetch(`${apiBase}/git/ref/heads/master`, { headers })
    if (!refResp.ok) {
      console.warn(`    [ERROR] Could not get master ref: ${refResp.status}`)
      return null
    }
    const masterSha = (await refResp.json()).object.sha

    // 2. Create branch
    const branchName = `cncf-mission/${slug}`
    const branchResp = await fetch(`${apiBase}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: masterSha }),
    })
    if (!branchResp.ok) {
      const err = await branchResp.text().catch(() => '')
      // Branch may already exist from a previous run
      if (!err.includes('Reference already exists')) {
        console.warn(`    [ERROR] Branch creation failed: ${branchResp.status} ${err.slice(0, 200)}`)
        return null
      }
    }

    // 3. Build and write mission JSON file
    const missionJson = buildMissionJson({ project, issue, resolution, linkedPR, slug, missionType, difficulty })
    const content = Buffer.from(JSON.stringify(missionJson, null, 2) + '\n').toString('base64')

    const fileResp = await fetch(`${apiBase}/contents/${filePath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `🌱 Add ${project.name}: ${truncateAtWordBoundary(issue.title, 60)} mission`,
        content,
        branch: branchName,
      }),
    })
    if (!fileResp.ok) {
      const err = await fileResp.text().catch(() => '')
      console.warn(`    [ERROR] File creation failed: ${fileResp.status} ${err.slice(0, 200)}`)
      return null
    }

    // 4. Create PR
    const prBody = buildPRBody({ project, issue, resolution, linkedPR, filePath, missionType })
    const prResp = await fetch(`${apiBase}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `🌱 ${project.name}: ${truncateAtWordBoundary(issue.title, 80)}`,
        head: branchName,
        base: 'master',
        body: prBody,
      }),
    })

    if (!prResp.ok) {
      const err = await prResp.text().catch(() => '')
      console.warn(`    [ERROR] PR creation failed: ${prResp.status} ${err.slice(0, 200)}`)
      return null
    }

    const pr = await prResp.json()
    console.log(`    [PR] Created #${pr.number}: ${pr.html_url}`)

    // 5. Add labels to the PR
    try {
      await fetch(`${apiBase}/issues/${pr.number}/labels`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ labels: ['cncf-mission-gen', 'ai-fix-requested', 'triage/accepted'] }),
      })
    } catch (labelErr) {
      console.warn(`    [WARN] Could not add labels: ${labelErr.message}`)
    }

    // 6. Assign Copilot to enhance the pre-filled content
    try {
      await fetch(`${apiBase}/issues/${pr.number}/assignees`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ assignees: ['copilot-swe-agent[bot]'] }),
      })
      console.log(`    [PR] Assigned Copilot to enhance #${pr.number}`)
    } catch (assignErr) {
      console.warn(`    [WARN] Could not assign Copilot: ${assignErr.message}`)
    }

    return { prNumber: pr.number, slug, url: pr.html_url }
  } catch (err) {
    console.warn(`    [ERROR] PR creation error: ${err.message}`)
    return null
  }
}

/**
 * Build a description from the issue body, extracting error messages and symptoms.
 * Varies phrasing by mission type — features don't "encounter errors".
 */
function buildDescription(issue, resolution) {
  const body = truncateAtWordBoundary(issue.body || '', 500)
  const reactions = issue.reactions?.total_count || 0
  const mType = detectMissionType(issue)
  const isFeature = mType === 'feature' || mType === 'deploy'

  if (isFeature) {
    return truncateAtWordBoundary(
      `${issue.title}. Requested by ${reactions}+ users.`,
      300,
    )
  }

  const errorMatch = body.match(/(?:error|ERROR|panic|fatal|FATAL|failed to)[:=]\s*([^\n]{10,100})/)?.[1]
  const symptom = errorMatch
    ? `${issue.title}. Users encounter: "${errorMatch.trim()}".`
    : `${issue.title}. This issue affects ${reactions}+ users.`
  return truncateAtWordBoundary(symptom, 300)
}

/**
 * Build the full mission JSON object with real pre-filled content.
 */
function buildMissionJson({ project, issue, resolution, linkedPR, slug, missionType, difficulty }) {
  const cleanDesc = truncateAtWordBoundary(stripPRTemplate(resolution.problem || issue.body || ''), 500)
  const cleanSolution = truncateAtWordBoundary(stripPRTemplate(resolution.solution || ''), 500)

  return {
    version: 'kc-mission-v1',
    name: slug,
    missionClass: 'solution',
    author: 'KubeStellar Bot',
    authorGithub: 'kubestellar',
    mission: {
      title: `${project.name}: ${issue.title}`,
      description: buildDescription(issue, resolution),
      type: missionType,
      status: 'completed',
      steps: buildDetailedSteps(issue, resolution, project, cleanDesc, cleanSolution),
      resolution: {
        summary: buildResolutionSummary(resolution, cleanSolution, missionType),
        codeSnippets: (resolution.yamlSnippets || []).slice(0, 3).map(s => s.slice(0, 800)),
      },
    },
    metadata: {
      tags: [project.name, project.maturity, project.category, missionType].filter(Boolean),
      cncfProjects: [project.name],
      targetResourceKinds: extractResourceKinds({ body: (issue.body || '') + ' ' + (resolution.solution || ''), title: issue.title || '' }, project),
      difficulty,
      issueTypes: [missionType],
      maturity: project.maturity,
      sourceUrls: {
        issue: issue.html_url,
        repo: `https://github.com/${project.repo}`,
        ...(linkedPR ? { pr: linkedPR.html_url } : {}),
      },
      reactions: issue.reactions?.total_count || 0,
      comments: issue.comments || 0,
      synthesizedBy: 'copilot',
    },
    prerequisites: generatePrerequisites(project),
    security: {
      scannedAt: new Date().toISOString(),
      scannerVersion: 'cncf-gen-3.0.0',
      sanitized: true,
      findings: [],
    },
  }
}

/**
 * Build detailed steps from the issue and resolution context.
 * Uses project-aware namespaces and commands instead of hardcoded cert-manager.
 * Non-Kubernetes projects get application-specific steps instead of kubectl commands.
 */
function buildDetailedSteps(issue, resolution, project, cleanDesc, cleanSolution) {
  const steps = []
  const body = issue.body || ''
  const k8sNative = isKubernetesNative(project)

  // Derive project-specific namespace and helm repo (not hardcoded cert-manager)
  const namespace = project.namespace || project.name
  const helmRepo = project.helmRepo || project.name
  const mType = detectMissionType(issue)
  const isFeature = mType === 'feature' || mType === 'deploy'

  // Step 1: Context — varies by mission type
  // Only use actual error patterns from the body, never the issue title
  // Require colon/equals after keyword to avoid matching prose like "error output, etc"
  const errorMatch = body.match(/(?:error|ERROR|panic|fatal|FATAL|failed to)[:=]\s*([^\n]{10,120})/)?.[1]

  if (isFeature) {
    // Feature requests: check current state, not "look for errors"
    if (k8sNative) {
      steps.push({
        title: `Check current ${project.name} deployment`,
        description: [
          `Verify your ${project.name} version and configuration:`,
          '```bash',
          `kubectl get pods -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
          `helm list -n ${namespace} 2>/dev/null || echo "Not installed via Helm"`,
          '```',
          `This feature requires a working ${project.name} installation.`,
        ].join('\n')
      })
    } else {
      steps.push({
        title: `Check current ${project.name} setup`,
        description: [
          `Verify your ${project.name} version and configuration:`,
          '```bash',
          `${project.name} version`,
          '```',
          `This feature requires a working ${project.name} installation.`,
        ].join('\n')
      })
    }
  } else {
    // Troubleshoot/analyze: look for specific errors
    if (k8sNative) {
      steps.push({
        title: `Identify ${project.name} ${mType} symptoms`,
        description: [
          `Check for the issue in your ${project.name} deployment:`,
          '```bash',
          `kubectl get pods -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
          `kubectl logs -l app.kubernetes.io/name=${project.name} -n ${namespace} --tail=100 | grep -i error`,
          '```',
          errorMatch ? `Look for error: \`${errorMatch.trim()}\`` : `Look for errors or warnings in the logs that may indicate the issue.`,
        ].join('\n')
      })
    } else {
      steps.push({
        title: `Identify ${project.name} ${mType} symptoms`,
        description: [
          `Check for the issue in your ${project.name} installation:`,
          '```bash',
          `${project.name} version`,
          `${project.name} status 2>&1 | head -20`,
          '```',
          errorMatch ? `Look for error: \`${errorMatch.trim()}\`` : `Look for errors or warnings that may indicate the issue.`,
        ].join('\n')
      })
    }
  }

  // Step 2: Understand the issue context
  // Don't use auto-detected resourceKinds for kubectl commands — they produce
  // false positives (e.g., "service" from "microservice", "role" from "user role").
  // Instead, describe the issue context with the project-specific configuration.
  const descSnippet = truncateAtSentenceBoundary(cleanDesc, 250)
  if (k8sNative) {
    steps.push({
      title: `Review ${project.name} configuration`,
      description: [
        `Inspect the relevant ${project.name} configuration:`,
        '```bash',
        `kubectl get all -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
        `kubectl get configmap -n ${namespace} -l app.kubernetes.io/part-of=${project.name}`,
        '```',
        descSnippet,
      ].join('\n')
    })
  } else {
    steps.push({
      title: `Review ${project.name} configuration`,
      description: [
        `Review the relevant ${project.name} configuration:`,
        descSnippet,
      ].join('\n')
    })
  }

  // Step 3: Apply the fix
  if (resolution.yamlSnippets?.length > 0) {
    steps.push({
      title: `Apply the fix for ${truncateAtWordBoundary(issue.title, 60)}`,
      description: [
        truncateAtWordBoundary(cleanSolution, 300) || `Apply the configuration change to resolve the issue:`,
        '```yaml',
        resolution.yamlSnippets[0].slice(0, 600),
        '```',
      ].join('\n')
    })
  } else if (cleanSolution) {
    steps.push({
      title: `Apply the fix for ${truncateAtWordBoundary(issue.title, 60)}`,
      description: [
        truncateAtWordBoundary(cleanSolution, 500),
        '',
        `See the fix PR for details: ${resolution.prUrl || 'linked PR'}`,
      ].join('\n')
    })
  } else {
    steps.push({
      title: `Apply the recommended fix`,
      description: `Apply the fix as described in the source issue. Check ${issue.html_url} for community-verified solutions.`
    })
  }

  // Step 4: Upgrade if there's a version fix (only for K8s-native projects with Helm)
  if (k8sNative && (resolution.prUrl || resolution.solution?.includes('upgrade') || resolution.solution?.includes('version'))) {
    steps.push({
      title: `Upgrade ${project.name} to include the fix`,
      description: [
        `If the fix is included in a newer release, upgrade ${project.name}:`,
        '```bash',
        `helm repo update`,
        `helm upgrade ${project.name} ${helmRepo}/${project.name} --namespace ${namespace}`,
        '```',
        'Verify the upgrade:',
        '```bash',
        `kubectl get pods -n ${namespace}`,
        `helm list -n ${namespace}`,
        '```',
      ].join('\n')
    })
  } else if (!k8sNative && (resolution.prUrl || resolution.solution?.includes('upgrade') || resolution.solution?.includes('version'))) {
    steps.push({
      title: `Upgrade ${project.name} to include the fix`,
      description: [
        `If the fix is included in a newer release, upgrade ${project.name}:`,
        '```bash',
        `# Check current version`,
        `${project.name} version`,
        `# Follow the project's upgrade guide at https://github.com/${project.repo}`,
        '```',
      ].join('\n')
    })
  }

  // Step 5: Verify — varies by mission type
  if (isFeature) {
    if (k8sNative) {
      steps.push({
        title: `Verify the feature works`,
        description: [
          `Test that the new capability is working as expected:`,
          '```bash',
          `kubectl get pods -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
          `kubectl get events -n ${namespace} --sort-by='.lastTimestamp' | tail -10`,
          '```',
          `Confirm the feature described in "${truncateAtWordBoundary(issue.title, 60)}" is functioning correctly.`,
        ].join('\n')
      })
    } else {
      steps.push({
        title: `Verify the feature works`,
        description: [
          `Test that the new capability is working as expected.`,
          `Confirm the feature described in "${truncateAtWordBoundary(issue.title, 60)}" is functioning correctly.`,
        ].join('\n')
      })
    }
  } else {
    if (k8sNative) {
      steps.push({
        title: `Confirm ${truncateAtWordBoundary(issue.title, 50)} is resolved`,
        description: [
          `Verify the fix by checking that the original error no longer occurs:`,
          '```bash',
          `kubectl logs -l app.kubernetes.io/name=${project.name} -n ${namespace} --tail=50 --since=5m`,
          `kubectl get events -n ${namespace} --sort-by='.lastTimestamp' | tail -10`,
          '```',
          errorMatch ? `Confirm that \`${errorMatch.trim()}\` no longer appears in logs.` : 'Confirm that the issue symptoms are gone.',
        ].join('\n')
      })
    } else {
      steps.push({
        title: `Confirm ${truncateAtWordBoundary(issue.title, 50)} is resolved`,
        description: [
          `Verify the fix by checking that the original error no longer occurs:`,
          `Test ${project.name} to confirm the issue is resolved.`,
          errorMatch ? `Confirm that \`${errorMatch.trim()}\` no longer appears.` : 'Confirm that the issue symptoms are gone.',
        ].join('\n')
      })
    }
  }

  return steps
}

/**
 * Build resolution summary from available context.
 * Strips PR template boilerplate and avoids tautological filler text.
 * Ensures the summary ends at a sentence boundary (period, not mid-word).
 */
function buildResolutionSummary(resolution, cleanSolution, missionType) {
  if (cleanSolution && cleanSolution.length > 50) {
    const summary = truncateAtSentenceBoundary(cleanSolution, 400)
    // Skip if after cleaning it's just empty or too short to be useful
    if (summary.length < 30) {
      return `See the linked issue and PR for the community-verified solution.`
    }
    return summary
  }
  return `See the linked issue and PR for the community-verified solution.`
}

/**
 * Build PR body with context for reviewers and Copilot.
 */
function buildPRBody({ project, issue, resolution, linkedPR, filePath, missionType }) {
  const sections = []
  sections.push(`## 🌱 New Mission: ${project.name} — ${issue.title}`)
  sections.push('')
  sections.push(`**Type:** ${missionType} | **Source:** ${issue.html_url} (${issue.reactions?.total_count || 0} reactions)`)
  if (linkedPR) sections.push(`**Fix PR:** ${linkedPR.html_url}`)
  sections.push(`**File:** \`${filePath}\``)
  sections.push('')
  sections.push('### Copilot: Please enhance this mission')
  sections.push('')
  sections.push('The JSON file has been pre-filled with content from the source issue. Please improve:')
  sections.push('1. Make step descriptions more specific with exact commands for this issue')
  sections.push('2. Add the exact error message to the description if missing')
  sections.push('3. Explain the root cause in the resolution summary')
  sections.push('4. Add relevant YAML/code snippets to codeSnippets if missing')
  sections.push('5. Run `node scripts/scanner.mjs` to validate')
  sections.push('')
  sections.push(`*Auto-generated by CNCF Mission Generator*`)
  return sections.join('\n')
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
    `**Mission PRs created:** ${report.generated}`,
    `**Skipped:** ${report.skipped}`,
    `**Errors:** ${report.errors}`,
    '',
    '## Projects Processed',
    '',
    '| Project | Maturity | Items Found | Issues Created | Errors |',
    '|---------|----------|------------|---------------|--------|',
  ]

  for (const p of report.projects) {
    lines.push(
      `| ${p.name} | ${p.maturity} | ${p.issuesFound} | ${p.generated} | ${p.errors} |`
    )
  }

  if (report.generated > 0) {
    lines.push('', '## Copilot Issues Created', '')
    lines.push('| Mission | Difficulty | Source | Issue |')
    lines.push('|---------|-----------|--------|-------|')
    for (const m of report.missions || []) {
      const issueLink = m.issueUrl ? `[#${m.issueNumber}](${m.issueUrl})` : 'dry-run'
      lines.push(`| ${m.title} | ${m.difficulty} | [source](${m.sourceIssue}) | ${issueLink} |`)
    }
  }

  return lines.join('\n')
}

async function main() {
  if (!GITHUB_TOKEN) {
    console.warn('Warning: GITHUB_TOKEN not set. API rate limits will be very low.')
  }

  // Load knowledge sources config and search state
  const sourcesConfig = loadSourcesConfig()
  const sources = initializeSources(sourcesConfig)
  const searchState = FORCE_RESCAN ? { version: 1, lastUpdated: null, projects: {} } : loadSearchState()

  console.log(`Active sources: ${sources.map(s => s.id).join(', ')}`)
  console.log(`Force rescan: ${FORCE_RESCAN}`)

  // Merge CNCF and other projects — normalize schema for non-CNCF entries
  const ALL_PROJECTS = [
    ...CNCF_PROJECTS,
    ...OTHER_PROJECTS.map(p => ({
      name: p.name,
      repo: p.repo,
      maturity: 'community',          // non-CNCF projects use 'community' tier
      category: p.category || 'other',
      sources: p.sources || {},        // may lack SO/Reddit config
    })),
  ]

  let projects = TARGET_PROJECTS
    ? ALL_PROJECTS.filter(p => TARGET_PROJECTS.includes(p.name))
    : ALL_PROJECTS

  // Apply batch slicing if BATCH_INDEX is set
  if (BATCH_INDEX != null) {
    const start = BATCH_INDEX * BATCH_SIZE
    const end = start + BATCH_SIZE
    projects = projects.slice(start, end)
    console.log(`Batch ${BATCH_INDEX}: projects ${start}-${Math.min(end, ALL_PROJECTS.length) - 1} of ${ALL_PROJECTS.length}`)
  }

  if (projects.length === 0) {
    console.log('No projects in this batch range. Exiting.')
    const reportPath = join(process.cwd(), BATCH_INDEX != null ? `generation-report-${BATCH_INDEX}.md` : 'generation-report.md')
    writeFileSync(reportPath, formatReport({ generated: 0, skipped: 0, errors: 0, projects: [], missions: [] }))
    process.exit(0)
  }

  console.log(`Processing ${projects.length} projects (${CNCF_PROJECTS.length} CNCF + ${OTHER_PROJECTS.length} other, min_reactions=${MIN_REACTIONS}, dry_run=${DRY_RUN})`)

  mkdirSync(SOLUTIONS_DIR, { recursive: true })

  const report = { generated: 0, skipped: 0, errors: 0, projects: [], missions: [] }

  for (const project of projects) {
    const [owner, repo] = project.repo.split('/')
    const projectReport = { name: project.name, maturity: project.maturity, issuesFound: 0, generated: 0, errors: 0 }
    console.log(`\nProcessing ${project.name} (${project.repo})...`)

    const projectDir = join(SOLUTIONS_DIR, project.name)
    mkdirSync(projectDir, { recursive: true })

    // --- Process each knowledge source ---
    for (const source of sources) {
      try {
        if (source.builtin && source.id === 'github-issues') {
          // Original built-in GitHub issues flow
          const sourceState = getSourceState(searchState, project.repo, 'github-issues')
          const issues = await findHighEngagementIssues(project)
          projectReport.issuesFound += issues.length
          console.log(`  [github-issues] Found ${issues.length} high-engagement issues`)

          const newIds = []
          for (const issue of issues) {
            const canonicalId = `gh:${project.repo}#${issue.number}`
            if (!FORCE_RESCAN && sourceState.processedIds.includes(canonicalId)) {
              console.log(`  [github-issues] Skipping already-processed: #${issue.number}`)
              report.skipped++
              continue
            }

            const slug = slugify(`${project.name}-${issue.number}-${issue.title}`)
            if (deduplicateAgainstExisting(slug, projectDir)) {
              console.log(`  [github-issues] Skipping duplicate: ${slug}`)
              report.skipped++
              newIds.push(canonicalId) // Mark as processed even if file exists
              continue
            }

            try {
              console.log(`  [github-issues] Processing issue #${issue.number}: ${issue.title.slice(0, 60)}...`)
              const details = await getIssueDetails(owner, repo, issue.number)
              if (!details) {
                console.warn(`  Could not fetch details for #${issue.number}, skipping.`)
                continue
              }

              const resolution = extractResolutionFromIssue(details.issue, details.comments, details.linkedPR)

              // Fetch PR diff summary for richer Copilot context
              if (details.linkedPR?.number) {
                resolution.prDiffSummary = await fetchPRDiffSummary(owner, repo, details.linkedPR.number)
              }

              // Quality gate — ensure enough content for Copilot to work with
              if (!passesQualityGate(resolution, details.issue)) {
                console.log(`  Skipped #${issue.number} (quality gate: insufficient actionable content)`)
                report.skipped++
                newIds.push(canonicalId)
                continue
              }

              // Enforce per-run issue limit to avoid flooding
              if (report.generated >= MAX_COPILOT_ISSUES_PER_RUN) {
                console.log(`  [LIMIT] Reached max ${MAX_COPILOT_ISSUES_PER_RUN} Copilot issues per run`)
                break
              }

              // Create GitHub issue for Copilot to generate the mission
              const result = await createCopilotIssue(project, details.issue, resolution, details.linkedPR)

              if (!result) {
                console.log(`  Skipped #${issue.number} (issue creation failed)`)
                report.skipped++
                newIds.push(canonicalId)
                continue
              }

              newIds.push(canonicalId)
              report.generated++
              projectReport.generated++
              report.missions.push({
                title: `${project.name}: ${issue.title}`,
                difficulty: estimateDifficulty(issue),
                sourceIssue: issue.html_url,
                issueNumber: result.issueNumber,
                issueUrl: result.url,
              })
              await sleep(1000) // Rate limit: 1 issue per second
            } catch (err) {
              console.error(`  Error processing issue #${issue.number}: ${err.message}`)
              projectReport.errors++
              report.errors++
            }
          }

          updateSourceState(searchState, project.repo, 'github-issues', newIds)
        } else if (!source.builtin && source.instance) {
          // External source (Reddit, SO, Discussions)
          const sourceState = getSourceState(searchState, project.repo, source.id)
          console.log(`  [${source.id}] Searching...`)

          try {
            const result = await source.instance.search(project, sourceState)
            const items = result.items || []
            console.log(`  [${source.id}] Found ${items.length} items`)

            const newIds = []
            for (const item of items) {
              const canonicalId = source.instance.canonicalId(item)

              try {
                const mission = await source.instance.extractMission(item, project)
                if (!mission) {
                  console.log(`  [${source.id}] Could not extract mission from ${canonicalId}, skipping`)
                  newIds.push(canonicalId)
                  continue
                }

                const slug = baseSlugify(`${project.name}-${source.id}-${mission.mission?.title || canonicalId}`)
                const filePath = join(projectDir, `${slug}.json`)

                if (deduplicateAgainstExisting(slug, projectDir)) {
                  console.log(`  [${source.id}] Skipping duplicate: ${slug}`)
                  report.skipped++
                  newIds.push(canonicalId)
                  continue
                }

                // Quality scoring for external sources
                const qualityResult = scoreMission(mission)
                if (mission.metadata) mission.metadata.qualityScore = qualityResult.score

                if (!qualityResult.pass) {
                  console.log(`  [${source.id}] Skipped ${canonicalId} (quality score: ${qualityResult.score}/100)`)
                  report.skipped++
                  newIds.push(canonicalId)
                  continue
                }

                // Schema validation before writing
                const schemaResult = validateMissionExport(mission)
                if (!schemaResult.valid) {
                  console.warn(`  [${source.id}] ⚠️ Schema invalid for ${slug}: ${schemaResult.errors.join(', ')}`)
                  report.skipped++
                  newIds.push(canonicalId)
                  continue
                }

                if (DRY_RUN) {
                  console.log(`  [DRY RUN] Would write: ${filePath} (score: ${qualityResult.score})`)
                } else {
                  writeFileSync(filePath, JSON.stringify(mission, null, 2) + '\n')
                  console.log(`  [${source.id}] Written: ${slug}.json (score: ${qualityResult.score})`)
                }

                newIds.push(canonicalId)
                report.generated++
                projectReport.generated++
                report.missions.push({
                  title: mission.mission?.title || slug,
                  difficulty: mission.metadata?.difficulty || 'intermediate',
                  sourceIssue: mission.metadata?.sourceUrl || '',
                })
              } catch (err) {
                console.error(`  [${source.id}] Error processing ${canonicalId}: ${err.message}`)
                projectReport.errors++
                report.errors++
                newIds.push(canonicalId) // Don't retry failed items
              }
            }

            updateSourceState(searchState, project.repo, source.id, newIds, result.cursor || null)
          } catch (err) {
            console.error(`  [${source.id}] Search error for ${project.name}: ${err.message}`)
            projectReport.errors++
            report.errors++
          }
        }
      } catch (err) {
        console.error(`  [${source.id}] Fatal error for ${project.name}: ${err.message}`)
        projectReport.errors++
        report.errors++
      }
    }

    report.projects.push(projectReport)
    await sleep(500)
  }

  // Save updated search state
  if (!DRY_RUN) {
    saveSearchState(searchState)
    console.log('\nSearch state saved.')
  }

  // Write generation report (batch-specific filename if batching)
  const reportName = BATCH_INDEX != null ? `generation-report-${BATCH_INDEX}.md` : 'generation-report.md'
  const reportPath = join(process.cwd(), reportName)
  writeFileSync(reportPath, formatReport(report))
  console.log(`\nReport written to: ${reportPath}`)
  console.log(`Done: ${report.generated} generated, ${report.skipped} skipped, ${report.errors} errors`)

  // Exit with error if error rate is too high (>30% of total attempted)
  const totalAttempted = report.generated + report.skipped + report.errors
  if (totalAttempted > 0 && report.errors / totalAttempted > 0.3) {
    console.error(`Error rate ${(report.errors / totalAttempted * 100).toFixed(1)}% exceeds 30% threshold`)
    process.exit(1)
  }
}

// Only run main when executed directly
if (process.argv[1]?.endsWith('generate-cncf-missions.mjs')) {
  main().catch(err => {
    console.error('Unhandled error in main:', err.message)
    process.exit(1)
  })
}

export { detectMissionType, extractLabels, extractResourceKinds, estimateDifficulty, slugify, createCopilotIssue, extractResolutionFromIssue, formatReport }
