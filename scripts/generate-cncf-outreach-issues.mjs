#!/usr/bin/env node

/**
 * generate-cncf-outreach-issues.mjs
 *
 * Generates parameterized GitHub issue bodies for filing in each CNCF project's
 * repository. Each issue links to the KubeStellar Console, the project's AI mission,
 * and an "Improve this AI Mission" call-to-action.
 *
 * Usage:
 *   node scripts/generate-cncf-outreach-issues.mjs [--project=NAME] [--dry-run] [--output=DIR]
 *
 * Options:
 *   --project=NAME   Generate only for a specific project
 *   --dry-run        Print issues without writing files
 *   --output=DIR     Output directory (default: outreach-issues/)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { slugify, titleCase, generateIssueTitle, generateIssueBody, generateIssueLabels } from './lib/outreach-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load CNCF projects list
const { CNCF_PROJECTS } = await import('./cncf-projects.mjs')

// Console base URL (configurable)
const CONSOLE_URL = process.env.CONSOLE_URL || 'https://console.kubestellar.io'
const KB_REPO = 'kubestellar/console-kb'

// Parse CLI args
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const projectFilter = args.find(a => a.startsWith('--project='))?.split('=')[1]
const outputDir = args.find(a => a.startsWith('--output='))?.split('=')[1] || 'outreach-issues'

// ── Main ──────────────────────────────────────────────────────────────

// Check which projects have missions
const fixesDir = join(__dirname, '..', 'fixes', 'cncf-install')
let projects = CNCF_PROJECTS.filter(p => p.name !== 'kubestellar')

if (projectFilter) {
  projects = projects.filter(p => p.name === projectFilter)
  if (projects.length === 0) {
    console.error(`Project '${projectFilter}' not found in CNCF projects list`)
    process.exit(1)
  }
}

// Only generate outreach for projects that have missions
const projectsWithMissions = projects.filter(p => {
  const slug = slugify(p.name)
  const missionPath = join(fixesDir, `install-${slug}.json`)
  return existsSync(missionPath)
})

console.log(`Generating outreach issues for ${projectsWithMissions.length}/${projects.length} projects with missions`)

if (!dryRun) {
  mkdirSync(outputDir, { recursive: true })
}

const summary = { total: 0, generated: 0, skipped: 0 }

for (const project of projectsWithMissions) {
  summary.total++
  const slug = slugify(project.name)
  const title = generateIssueTitle(project)
  const body = generateIssueBody(project)
  const labels = generateIssueLabels()

  if (dryRun) {
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`Project: ${project.name} (${project.repo})`)
    console.log(`Title: ${title}`)
    console.log(`Labels: ${labels.join(', ')}`)
    console.log(`${'─'.repeat(60)}`)
    console.log(body.slice(0, 500) + '...')
    summary.generated++
  } else {
    const outPath = join(outputDir, `${slug}.md`)
    const metadata = [
      `<!-- OUTREACH ISSUE for ${project.name} -->`,
      `<!-- Repo: ${project.repo} -->`,
      `<!-- Title: ${title} -->`,
      `<!-- Labels: ${labels.join(', ')} -->`,
      `<!-- To file: gh issue create --repo ${project.repo} --title "${title}" --body-file ${outPath} -->`,
      '',
    ].join('\n')
    writeFileSync(outPath, metadata + body)
    console.log(`  ✅ ${slug}.md`)
    summary.generated++
  }
}

console.log(`\n📊 Summary: ${summary.generated}/${summary.total} outreach issues generated`)
if (!dryRun) {
  console.log(`📁 Output: ${outputDir}/`)
  console.log(`\nTo file an issue for a specific project:`)
  console.log(`  gh issue create --repo OWNER/REPO --title "TITLE" --body-file ${outputDir}/PROJECT.md`)
}
