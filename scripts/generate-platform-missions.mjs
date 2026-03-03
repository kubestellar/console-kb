#!/usr/bin/env node
/**
 * Generates install + configure missions for Kubernetes platforms, managed
 * services, and popular cluster operators — version-aware.
 *
 * Reuses the same scanner / quality-scorer / index builder as the CNCF
 * install generator, but with a platform-specific LLM prompt that asks
 * for version-specific instructions, provider-specific CLI steps,
 * and upgrade/troubleshooting paths per platform version.
 *
 * Environment variables:
 *   GITHUB_TOKEN       — GitHub API auth
 *   LLM_TOKEN          — GitHub Models PAT (falls back to GITHUB_TOKEN)
 *   TARGET_PLATFORMS    — comma-separated platform names (empty = all)
 *   BATCH_INDEX / BATCH_SIZE — for parallelised workflow runs
 *   DRY_RUN            — if 'true', no files written
 *   FORCE_REGENERATE   — if 'true', overwrite existing missions
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { K8S_PLATFORMS, getPlatformByName } from './k8s-platforms.mjs'
import { validateMissionExport, scanForSensitiveData, scanForMaliciousContent } from './scanner.mjs'
import { scoreMission } from './quality-scorer.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ──────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const LLM_TOKEN = process.env.LLM_TOKEN || GITHUB_TOKEN
const TARGET_PLATFORMS = process.env.TARGET_PLATFORMS
  ? process.env.TARGET_PLATFORMS.split(',').map(s => s.trim()).filter(Boolean)
  : null
const DRY_RUN = process.env.DRY_RUN === 'true'
const BATCH_INDEX = process.env.BATCH_INDEX != null ? parseInt(process.env.BATCH_INDEX, 10) : null
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '20', 10)
const FORCE_REGENERATE = process.env.FORCE_REGENERATE === 'true'
const QUALITY_THRESHOLD = parseInt(process.env.QUALITY_THRESHOLD || '60', 10)
const DRAFT_THRESHOLD = parseInt(process.env.DRAFT_THRESHOLD || '40', 10)
const SOLUTIONS_DIR = join(process.cwd(), 'solutions', 'platform-install')

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://models.inference.ai.azure.com/chat/completions'
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini'
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10)

let rateLimitRemaining = 5000
let rateLimitReset = 0

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// ─── GitHub API helpers ──────────────────────────────────────────────
async function waitForRateLimit() {
  if (rateLimitRemaining < 10) {
    const waitMs = Math.max(0, (rateLimitReset * 1000) - Date.now()) + 1000
    console.log(`  Rate limit low (${rateLimitRemaining}), waiting ${Math.round(waitMs / 1000)}s...`)
    await sleep(waitMs)
  }
}

async function githubApi(url, options = {}) {
  await waitForRateLimit()
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'platform-install-gen/1.0',
  }
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })
    const rem = response.headers.get('x-ratelimit-remaining')
    const rst = response.headers.get('x-ratelimit-reset')
    if (rem != null) rateLimitRemaining = parseInt(rem, 10)
    if (rst != null) rateLimitReset = parseInt(rst, 10)

    if (response.status === 403 && rateLimitRemaining < 5) {
      await sleep(60_000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      console.warn(`  GitHub API ${response.status}: ${url}`)
      return null
    }
    return response.json()
  }
  return null
}

// ─── Knowledge Source Crawling ────────────────────────────────────────
async function crawlPlatformKnowledge(platform) {
  const ctx = { repoMeta: null, readme: '', release: null, helm: '', configs: [] }

  // 1. Repo metadata
  if (platform.repo) {
    ctx.repoMeta = await githubApi(`https://api.github.com/repos/${platform.repo}`)
  }

  // 2. README
  if (platform.repo) {
    const readmeData = await githubApi(`https://api.github.com/repos/${platform.repo}/readme`)
    if (readmeData?.content) {
      try {
        ctx.readme = Buffer.from(readmeData.content, 'base64').toString('utf-8').slice(0, 4000)
      } catch { /* ignore */ }
    }
  }

  // 3. Latest release
  if (platform.repo) {
    ctx.release = await githubApi(`https://api.github.com/repos/${platform.repo}/releases/latest`)
  }

  // 4. Helm chart if it exists
  if (platform.repo) {
    for (const path of ['charts', 'deploy/helm', 'helm', 'chart']) {
      const contents = await githubApi(`https://api.github.com/repos/${platform.repo}/contents/${path}`)
      if (Array.isArray(contents) && contents.length > 0) {
        // Try to find Chart.yaml
        const chartYaml = contents.find(f => f.name === 'Chart.yaml')
        if (chartYaml) {
          const raw = await githubApi(chartYaml.url)
          if (raw?.content) {
            try { ctx.helm = Buffer.from(raw.content, 'base64').toString('utf-8').slice(0, 1500) } catch { /* */ }
          }
        }
        break
      }
    }
  }

  // 5. Configs / manifests
  if (platform.repo) {
    for (const path of ['deploy', 'install', 'config', 'manifests', 'examples']) {
      const contents = await githubApi(`https://api.github.com/repos/${platform.repo}/contents/${path}`)
      if (Array.isArray(contents)) {
        const yamls = contents.filter(f => /\.(ya?ml|json)$/i.test(f.name)).slice(0, 3)
        for (const file of yamls) {
          const raw = await githubApi(file.url)
          if (raw?.content) {
            try {
              ctx.configs.push({
                name: file.name,
                content: Buffer.from(raw.content, 'base64').toString('utf-8').slice(0, 2000)
              })
            } catch { /* */ }
          }
        }
        break
      }
    }
  }

  return ctx
}

// ─── LLM Prompt ──────────────────────────────────────────────────────
const PLATFORM_SYSTEM_PROMPT = `You are an expert Kubernetes platform engineer creating VERSION-AWARE installation missions for the KubeStellar Console.

A "platform install mission" is a structured, copy-pasteable guide that covers setting up, configuring, upgrading, and troubleshooting a Kubernetes platform (managed service, distribution, or operator).

CRITICAL: Your output MUST include version-specific instructions. Different versions of a platform may have different installation steps, CLI commands, or configuration options.

Your output MUST be a JSON object with these fields:
{
  "description": "1-3 sentences describing this platform/operator and when you'd use it.",
  "platformType": "managed|distribution|local|operator",
  "supportedVersions": ["version1", "version2"],
  "supportedK8sVersions": ["1.28", "1.29", "1.30"],
  "steps": [
    {
      "title": "Short imperative title",
      "description": "Detailed step with exact commands. Include version-specific notes where applicable. Use code blocks."
    }
  ],
  "uninstall": [
    {
      "title": "Short imperative title",
      "description": "Detailed step to remove/tear down. Include cleanup of resources, CRDs, cloud resources."
    }
  ],
  "upgrade": [
    {
      "title": "Short imperative title",
      "description": "Detailed step for version upgrade. Include pre-upgrade checks, backup, version-specific migration notes, and rollback."
    }
  ],
  "troubleshooting": [
    {
      "title": "Short title describing the issue",
      "description": "Description, diagnosis commands, and fix. Include version-specific gotchas."
    }
  ],
  "versionNotes": [
    {
      "version": "string",
      "changes": "Key changes / breaking changes in this version",
      "deprecations": "Any deprecated features"
    }
  ],
  "resolution": "2-3 sentences confirming what a successful setup looks like.",
  "difficulty": "beginner|intermediate|advanced",
  "installMethods": ["cli", "helm", "kubectl", "terraform", "console", "operator"],
  "prerequisites": {
    "kubernetes": ">=1.25",
    "tools": ["kubectl", "helm"],
    "cloudCLI": "optional cloud CLI tool (gcloud, aws, az, oci)",
    "description": "Brief prereq description"
  },
  "containerImages": ["registry/org/image:tag"],
  "skip": false
}

Rules:
- Steps MUST have real commands — never "see the documentation"
- Include the platform's CLI tool in prerequisites (gcloud, eksctl, az, oci, etc.)
- For managed services: include cluster creation, node pool config, and connecting kubectl
- For distributions: include installation on Linux nodes, join commands, and HA setup
- For operators: include Helm install, CRD setup, and creating a CR instance
- Pin versions — never use :latest
- Include a verification step (kubectl cluster-info, node status, operator readiness)
- Include at least 1 post-install configuration step (autoscaling, monitoring, RBAC)
- "upgrade" must cover version-to-version upgrade paths with backup steps
- "troubleshooting" must have 3-5 common issues with version-specific notes
- "versionNotes" should cover at least the 2 most recent versions
- Do NOT invent URLs or image names — only use what's in the provided context`

function buildPlatformPrompt(platform, context) {
  const sections = [`# Platform install mission for: ${platform.displayName}`]
  sections.push(`Type: ${platform.type} | Category: ${platform.category} | Provider: ${platform.provider}`)
  sections.push(`Docs: ${platform.docs}`)
  sections.push(`Supported versions: ${platform.versions.join(', ')}`)
  sections.push(`Kubernetes versions: ${platform.k8sVersions.join(', ')}`)

  if (platform.repo) sections.push(`Repo: github.com/${platform.repo}`)

  if (context.repoMeta) {
    sections.push(`\n## Project Info\n- Stars: ${context.repoMeta.stargazers_count}\n- Language: ${context.repoMeta.language}\n- Description: ${context.repoMeta.description || 'N/A'}`)
    if (context.repoMeta.homepage) sections.push(`- Homepage: ${context.repoMeta.homepage}`)
  }

  if (context.release) {
    sections.push(`\n## Latest Release\n- Tag: ${context.release.tag_name}\n- Published: ${context.release.published_at}`)
  }

  if (context.readme) {
    sections.push(`\n## README (excerpt)\n${context.readme.slice(0, 3000)}`)
  }

  if (context.helm) {
    sections.push(`\n## Helm Chart\n\`\`\`yaml\n${context.helm}\n\`\`\``)
  }

  if (context.configs.length > 0) {
    sections.push('\n## Configuration Examples')
    for (const cfg of context.configs) {
      sections.push(`### ${cfg.name}\n\`\`\`yaml\n${cfg.content}\n\`\`\``)
    }
  }

  return sections.join('\n')
}

// ─── LLM Synthesis ───────────────────────────────────────────────────
async function synthesizePlatformMission(platform, context) {
  const prompt = buildPlatformPrompt(platform, context)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

  try {
    const response = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_TOKEN}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: PLATFORM_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
    })

    clearTimeout(timeout)
    if (!response.ok) {
      const err = await response.text()
      console.error(`  LLM API error ${response.status}: ${err.slice(0, 200)}`)
      return null
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return null
    return JSON.parse(content)
  } catch (err) {
    clearTimeout(timeout)
    console.error(`  LLM error: ${err.message}`)
    return null
  }
}

// ─── Slug / Title helpers ────────────────────────────────────────────
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') }
function titleCase(s) { return s.replace(/(^|[\s-])(\w)/g, (_, p, c) => p + c.toUpperCase()) }

// ─── Quality Gate ────────────────────────────────────────────────────
const SAFE_CLI_COMMANDS = /\b(kubectl|helm|gcloud|eksctl|az|oci|aws|doctl|linode-cli|vkectl|oc|k3s|k0s|microk8s|snap|curl|wget|apt|yum|dnf|brew)\b/

function applyQualityGate(mission) {
  const issues = []
  let score = 0

  // 1. Schema validation
  const schemaResult = validateMissionExport(mission)
  if (!schemaResult.valid) {
    return { pass: false, verdict: 'rejected', score: 0, issues: [`Schema invalid: ${schemaResult.errors.join(', ')}`] }
  }

  // 2. Security scan
  const jsonStr = JSON.stringify(mission)
  const sensitiveResult = scanForSensitiveData(jsonStr)
  if (sensitiveResult.found) {
    return { pass: false, verdict: 'rejected', score: 0, issues: [`Security: sensitive data found — ${sensitiveResult.matches.join(', ')}`] }
  }
  const maliciousResult = scanForMaliciousContent(jsonStr)
  if (maliciousResult.found) {
    return { pass: false, verdict: 'rejected', score: 0, issues: [`Security: malicious content — ${maliciousResult.matches.join(', ')}`] }
  }

  // 3. Quality scoring
  try {
    const scoreResult = scoreMission(mission)
    score = scoreResult.score || 0
  } catch {
    score = 50
  }

  // Platform-specific bonuses
  const steps = mission.mission?.steps || []
  const stepsText = steps.map(s => s.description || '').join(' ')

  // +10 for install/create command
  if (/helm install|kubectl apply|gcloud container|eksctl create|az aks|oci ce|doctl kubernetes|k3s install|kubeadm init|snap install/i.test(stepsText)) {
    score += 10
  }

  // +10 for verification step
  if (/kubectl get|kubectl cluster-info|kubectl get nodes|health|status|ready/i.test(stepsText)) {
    score += 10
  }

  // +5 for version references
  if (/\d+\.\d+/i.test(stepsText)) score += 5

  // +5 for each complete section
  const uninstall = mission.mission?.uninstall || []
  const upgrade = mission.mission?.upgrade || []
  const troubleshooting = mission.mission?.troubleshooting || []
  if (uninstall.length >= 2) score += 5
  if (upgrade.length >= 2) score += 5
  if (troubleshooting.length >= 3) score += 5

  // +5 for versionNotes
  const versionNotes = mission.mission?.versionNotes || []
  if (versionNotes.length >= 1) score += 5

  // +5 for platform-specific CLI
  if (SAFE_CLI_COMMANDS.test(stepsText)) score += 5

  // Penalty for vague steps
  if (/see the documentation|refer to docs|check the website/i.test(stepsText)) score -= 10

  score = Math.max(0, Math.min(100, score))

  if (score >= QUALITY_THRESHOLD) {
    return { pass: true, verdict: 'publish', score, issues }
  } else if (score >= DRAFT_THRESHOLD) {
    return { pass: true, verdict: 'draft', score, issues: [...issues, `Score ${score} below publish threshold ${QUALITY_THRESHOLD}`] }
  } else {
    return { pass: false, verdict: 'rejected', score, issues: [...issues, `Score ${score} below minimum ${DRAFT_THRESHOLD}`] }
  }
}

// ─── Build Mission JSON ──────────────────────────────────────────────
function buildMissionJson(platform, llmResult, context) {
  const slug = slugify(platform.name)
  const mission = {
    version: 'kc-mission-v1',
    name: `platform-${slug}`,
    missionClass: 'install',
    author: 'KubeStellar Bot',
    authorGithub: 'kubestellar',
    mission: {
      title: `Install and Configure ${platform.displayName}`,
      description: llmResult.description || `Setup guide for ${platform.displayName}.`,
      type: 'deploy',
      status: 'completed',
      steps: (llmResult.steps || []).map(s => ({
        title: String(s.title || '').slice(0, 200),
        description: String(s.description || '').slice(0, 3000),
      })),
      uninstall: (llmResult.uninstall || []).map(s => ({
        title: String(s.title || '').slice(0, 200),
        description: String(s.description || '').slice(0, 3000),
      })),
      upgrade: (llmResult.upgrade || []).map(s => ({
        title: String(s.title || '').slice(0, 200),
        description: String(s.description || '').slice(0, 3000),
      })),
      troubleshooting: (llmResult.troubleshooting || []).map(s => ({
        title: String(s.title || '').slice(0, 200),
        description: String(s.description || '').slice(0, 3000),
      })),
      versionNotes: (llmResult.versionNotes || []).map(v => ({
        version: String(v.version || ''),
        changes: String(v.changes || ''),
        deprecations: String(v.deprecations || ''),
      })),
      resolution: {
        summary: typeof llmResult.resolution === 'string'
          ? llmResult.resolution
          : llmResult.resolution?.summary || `${platform.displayName} is installed and running.`,
        codeSnippets: (llmResult.steps || [])
          .map(s => s.description || '')
          .flatMap(d => {
            const matches = d.match(/```(?:bash|console|shell|yaml)?\n([\s\S]*?)```/g)
            return matches ? matches.map(m => m.replace(/```(?:bash|console|shell|yaml)?\n?/g, '').replace(/```$/g, '').trim()) : []
          })
          .filter(Boolean)
          .slice(0, 6),
      },
    },
    metadata: {
      tags: [
        'installation',
        'configuration',
        platform.type,
        platform.category,
        platform.provider.toLowerCase().replace(/\s+/g, '-'),
      ],
      platform: platform.name,
      platformType: platform.type,
      platformProvider: platform.provider,
      platformVersions: platform.versions,
      supportedK8sVersions: platform.k8sVersions,
      cncfProjects: [],
      targetResourceKinds: ['Namespace', 'Deployment', 'Service'],
      difficulty: llmResult.difficulty || 'intermediate',
      issueTypes: ['installation', 'configuration'],
      installMethods: llmResult.installMethods || ['cli'],
      containerImages: llmResult.containerImages || [],
      sourceUrls: {
        docs: platform.docs,
        repo: platform.repo ? `https://github.com/${platform.repo}` : undefined,
      },
      qualityScore: 0,
    },
    prerequisites: {
      kubernetes: llmResult.prerequisites?.kubernetes || '>=1.25',
      tools: llmResult.prerequisites?.tools || ['kubectl'],
      cloudCLI: llmResult.prerequisites?.cloudCLI || undefined,
      description: llmResult.prerequisites?.description || `Ensure you have the required CLI tools installed.`,
    },
    security: {
      scannedAt: new Date().toISOString(),
      scannerVersion: 'platform-install-gen-1.0.0',
      sanitized: true,
      findings: [],
    },
  }

  return mission
}

// ─── Report Generation ───────────────────────────────────────────────
function formatReport(results) {
  const lines = ['# Platform Install Mission Generation Report', '', `Generated: ${new Date().toISOString()}`, '']

  const published = results.filter(r => r.verdict === 'publish')
  const drafted = results.filter(r => r.verdict === 'draft')
  const rejected = results.filter(r => r.verdict === 'rejected')
  const skipped = results.filter(r => r.verdict === 'skipped')

  lines.push(`| Status | Count |`, `|--------|-------|`)
  lines.push(`| ✅ Published | ${published.length} |`)
  lines.push(`| 📝 Draft | ${drafted.length} |`)
  lines.push(`| ❌ Rejected | ${rejected.length} |`)
  lines.push(`| ⏭️ Skipped | ${skipped.length} |`)
  lines.push('')

  for (const r of results) {
    const icon = r.verdict === 'publish' ? '✅' : r.verdict === 'draft' ? '📝' : r.verdict === 'skipped' ? '⏭️' : '❌'
    lines.push(`## ${icon} ${r.platform} (score: ${r.score})`)
    if (r.issues.length) lines.push(`Issues: ${r.issues.join('; ')}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Platform Install Mission Generator ===')
  console.log(`Platforms in catalog: ${K8S_PLATFORMS.length}`)

  // Determine which platforms to process
  let platforms = [...K8S_PLATFORMS]
  if (TARGET_PLATFORMS && TARGET_PLATFORMS.length > 0) {
    platforms = TARGET_PLATFORMS
      .map(name => getPlatformByName(name))
      .filter(Boolean)
    console.log(`Targeting ${platforms.length} platform(s): ${platforms.map(p => p.name).join(', ')}`)
  }

  // Apply batch index
  if (BATCH_INDEX != null) {
    const start = BATCH_INDEX * BATCH_SIZE
    const end = start + BATCH_SIZE
    platforms = platforms.slice(start, end)
    console.log(`Batch ${BATCH_INDEX}: platforms ${start}-${end - 1} (${platforms.length} items)`)
  }

  // Filter already-generated unless force
  if (!FORCE_REGENERATE) {
    const existing = existsSync(SOLUTIONS_DIR)
      ? readdirSync(SOLUTIONS_DIR).filter(f => f.endsWith('.json'))
      : []
    const existingNames = new Set(existing.map(f => f.replace(/\.json$/, '')))
    const before = platforms.length
    platforms = platforms.filter(p => !existingNames.has(`platform-${slugify(p.name)}`))
    if (before !== platforms.length) {
      console.log(`Skipping ${before - platforms.length} already-generated platforms`)
    }
  }

  if (platforms.length === 0) {
    console.log('No platforms to process.')
    return
  }

  console.log(`Processing ${platforms.length} platform(s)...`)
  mkdirSync(SOLUTIONS_DIR, { recursive: true })

  const results = []

  for (const platform of platforms) {
    console.log(`\n── ${platform.displayName} (${platform.type}) ──`)

    // 1. Crawl knowledge sources
    console.log('  Crawling knowledge sources...')
    const context = await crawlPlatformKnowledge(platform)

    // 2. Synthesize via LLM
    console.log('  Synthesizing via LLM...')
    const llmResult = await synthesizePlatformMission(platform, context)
    if (!llmResult) {
      results.push({ platform: platform.name, verdict: 'rejected', score: 0, issues: ['LLM returned no result'] })
      continue
    }

    if (llmResult.skip) {
      results.push({ platform: platform.name, verdict: 'skipped', score: 0, issues: ['Platform marked as skip by LLM'] })
      continue
    }

    // 3. Build mission JSON
    const mission = buildMissionJson(platform, llmResult, context)

    // 4. Apply quality gate
    const gateResult = applyQualityGate(mission)
    mission.metadata.qualityScore = gateResult.score

    console.log(`  Score: ${gateResult.score} → ${gateResult.verdict}`)
    if (gateResult.issues.length > 0) {
      console.log(`  Issues: ${gateResult.issues.join('; ')}`)
    }

    results.push({
      platform: platform.name,
      verdict: gateResult.verdict,
      score: gateResult.score,
      issues: gateResult.issues,
    })

    if (!gateResult.pass) continue

    // 5. Write mission file
    const slug = slugify(platform.name)
    const filename = `platform-${slug}.json`
    const isDraft = gateResult.verdict === 'draft'
    const outPath = join(SOLUTIONS_DIR, isDraft ? filename.replace('.json', '.draft.json') : filename)

    if (!DRY_RUN) {
      writeFileSync(outPath, JSON.stringify(mission, null, 2))
      console.log(`  Wrote: ${outPath}`)
    } else {
      console.log(`  [DRY RUN] Would write: ${outPath}`)
    }

    // Rate-limit between platforms
    await sleep(2000)
  }

  // Write report
  const report = formatReport(results)
  const reportPath = join(process.cwd(), `platform-report-${BATCH_INDEX ?? 'all'}.md`)
  if (!DRY_RUN) {
    writeFileSync(reportPath, report)
    console.log(`\nReport: ${reportPath}`)
  }

  // Summary
  const published = results.filter(r => r.verdict === 'publish').length
  const drafted = results.filter(r => r.verdict === 'draft').length
  const rejected = results.filter(r => r.verdict === 'rejected').length
  console.log(`\n=== Summary: ${published} published, ${drafted} draft, ${rejected} rejected ===`)

  if (rejected > 0) process.exitCode = 0 // Don't fail workflow for quality rejections
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
