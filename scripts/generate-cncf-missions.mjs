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
import { RedditSource } from './sources/reddit.mjs'
import { StackOverflowSource } from './sources/stackoverflow.mjs'
import { GitHubDiscussionsSource } from './sources/github-discussions.mjs'
import { validateMissionExport } from './scanner.mjs'
import { scoreMission } from './quality-scorer.mjs'

import { truncateAtWordBoundary, slugify } from './lib/text-utils.mjs'
import { sleep, findHighEngagementIssues, getIssueDetails, fetchPRDiffSummary } from './lib/cncf-github-client.mjs'
import { extractResolutionFromIssue } from './lib/cncf-resolution.mjs'
import {
  isKubernetesNative,
  getProjectVersionCmd,
  getProjectStatusCmd,
  generatePrerequisites,
  K8S_NATIVE_CATEGORIES,
  NON_K8S_PROJECTS,
  PROJECT_CLI_MAP,
} from './lib/cncf-project-metadata.mjs'
import {
  passesQualityGate,
  detectMissionType,
  extractLabels,
  extractResourceKinds,
  estimateDifficulty,
} from './lib/cncf-mission-quality.mjs'
import {
  buildDescription,
  buildMissionJson,
  generateMission,
  buildResolutionSummary,
  buildPRBody,
} from './lib/cncf-mission-builder.mjs'
const __dirname = dirname(fileURLToPath(import.meta.url))

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN
// PAT for issue creation — events from PATs trigger workflows (GITHUB_TOKEN events don't)
const ISSUE_TOKEN = process.env.ISSUE_TOKEN || process.env.GITHUB_TOKEN
export const MIN_REACTIONS = parseInt(process.env.MIN_REACTIONS || '10', 10)
const TARGET_PROJECTS = process.env.TARGET_PROJECTS
  ? process.env.TARGET_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
  : null
import { DRY_RUN, BATCH_INDEX, BATCH_SIZE } from './lib/batch-env.mjs'
const FORCE_RESCAN = process.env.FORCE_RESCAN === 'true'
const ENABLED_SOURCES = process.env.ENABLED_SOURCES
  ? process.env.ENABLED_SOURCES.split(',').map(s => s.trim()).filter(Boolean)
  : null // null = use config file
const SOLUTIONS_DIR = join(process.cwd(), 'fixes', 'cncf-generated')
export const MAX_ISSUES_PER_PROJECT = 20
export const MAX_RETRIES = 3
export const BASE_BACKOFF_MS = 2000
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
export function parseSimpleYaml(yaml) {
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

/**
 * Create a GitHub issue for Copilot to generate a mission from.
 * Returns the issue number if created, null if skipped/failed.
 */
async function createCopilotIssue(project, issue, resolution, linkedPR) {
  const slug = slugify(`${project.name}-${issue.number}-${issue.title}`)
  const missionType = detectMissionType(issue)
  const difficulty = estimateDifficulty(issue)
  const filePath = `fixes/cncf-generated/${project.name}/${slug}.json`

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

    const BOT_NAME = 'github-actions[bot]'
    const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
    const commitMessage = `🌱 Add ${project.name}: ${truncateAtWordBoundary(issue.title, 60)} mission\n\nSigned-off-by: ${BOT_NAME} <${BOT_EMAIL}>`
    const fileResp = await fetch(`${apiBase}/contents/${filePath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: commitMessage,
        content,
        branch: branchName,
        committer: { name: BOT_NAME, email: BOT_EMAIL },
        author: { name: BOT_NAME, email: BOT_EMAIL },
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

                const slug = slugify(`${project.name}-${source.id}-${mission.mission?.title || canonicalId}`)
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

export { detectMissionType, extractLabels, extractResourceKinds, estimateDifficulty, slugify, generateMission, createCopilotIssue, extractResolutionFromIssue, formatReport, truncateAtWordBoundary, buildDescription, buildResolutionSummary, loadSourcesConfig, isKubernetesNative, getProjectVersionCmd, getProjectStatusCmd, generatePrerequisites, passesQualityGate, K8S_NATIVE_CATEGORIES, NON_K8S_PROJECTS, PROJECT_CLI_MAP }
