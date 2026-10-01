#!/usr/bin/env node
/**
 * Generates 1 canonical install + configure mission per CNCF project.
 * Crawls 6 knowledge sources (docs, README, Helm, containers, configs, manifests),
 * synthesizes via LLM, and applies a 7-gate quality gate.
 *
 * Environment variables:
 *   GITHUB_TOKEN       — GitHub API + GitHub Models auth
 *   TARGET_PROJECTS    — comma-separated project names (empty = all)
 *   BATCH_INDEX        — batch index for parallelism
 *   BATCH_SIZE         — projects per batch (default 20)
 *   DRY_RUN            — if 'true', no files written
 *   GEN_QUALITY_THRESHOLD — minimum score (default 60; falls back to legacy QUALITY_THRESHOLD)
 *   FORCE_REGENERATE   — if 'true', overwrite existing missions
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join, dirname, basename, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parse as parseYaml } from 'yaml'
import { CNCF_PROJECTS } from './cncf-projects.mjs'
import { validateMissionExport, scanForSensitiveData, scanForMaliciousContent } from './scanner.mjs'
import { scoreMission } from './quality-scorer.mjs'
import { genQualityThreshold } from './lib/quality-thresholds.mjs'
import { ALLOWED_ENDPOINT_PREFIXES, assertTrustedEndpoint } from './lib/llm-endpoint-guard.mjs'
import { slugify, assertSafeSlug, assertSafePath, serializeSanitizedMissionForFile } from './lib/mission-file.mjs'
import { checkHelmRepoUrl } from './lib/helm-sources.mjs'
// GitHub REST primitives (rate-limit tracking, 30s timeout, 5xx/network
// backoff) are shared with generate-cncf-missions.mjs via the lib; the
// Response-returning variant is used here because the knowledge-source
// fetchers below inspect `res.ok` themselves (kubestellar/console-kb#3536).
import { sleep, githubApiResponse as githubApi } from './lib/cncf-github-client.mjs'
// README/repo-meta fetchers are shared with platform/github-context.mjs
// (kubestellar/console-kb#3575).
import { fetchReadme, fetchRepoMeta } from './lib/repo-context.mjs'
// Install-asset fetchers (GitHub + ArtifactHub) extracted to a dedicated
// module following the scripts/scanner.mjs → scripts/scanner/ pattern
// (kubestellar/console-kb#3623, mirrors #3195).
import {
  fetchRawFile,
  fetchLatestRelease,
  fetchHelmCharts,
  fetchKustomizeManifests,
  fetchDockerImages,
  fetchOperatorManifests,
  fetchArtifactHubChart,
  fetchArtifactHubIndexForRepo,
  gatherProjectContext,
} from './install-gen/github-install-fetchers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ──────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const TARGET_PROJECTS = process.env.TARGET_PROJECTS
  ? process.env.TARGET_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
  : null
import { DRY_RUN, BATCH_INDEX, BATCH_SIZE } from './lib/batch-env.mjs'
import { createLogger } from './lib/logger.mjs'
const log = createLogger('generate-cncf-install-missions')
const FORCE_REGENERATE = process.env.FORCE_REGENERATE === 'true'
const QUALITY_THRESHOLD = genQualityThreshold(60)
const DRAFT_THRESHOLD = parseInt(process.env.DRAFT_THRESHOLD || '40', 10)
const SOLUTIONS_DIR = join(process.cwd(), 'fixes', 'cncf-install')

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://models.github.ai/inference/chat/completions'
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-4o-mini'
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10)

// Validate LLM_ENDPOINT at module load time (CWE-441: prevent SSRF).
// ALLOWED_ENDPOINT_PREFIXES / assertTrustedEndpoint are shared with
// generate-platform-missions.mjs via ./lib/llm-endpoint-guard.mjs
// (kubestellar/console-kb#3134, #3333).
const TRUSTED_LLM_ENDPOINT = assertTrustedEndpoint(LLM_ENDPOINT)

function loadInstallSourcesConfig() {
  const configPath = join(__dirname, 'install-sources.yaml')
  if (!existsSync(configPath)) {
    log.warn('Warning: install-sources.yaml not found, using defaults')
    return { sources: {}, quality: { minScore: 60, draftMinScore: 40 }, author: { name: 'KubeStellar Bot', github: 'kubestellar' } }
  }
  return parseYaml(readFileSync(configPath, 'utf-8'))
}

// ─── GitHub + ArtifactHub install-asset fetchers ─────────────────────
// Implementations live in ./install-gen/github-install-fetchers.mjs
// (kubestellar/console-kb#3623). The symbols are re-exported at the bottom
// of this file so existing tests and callers keep importing them from here.

// checkHelmRepoUrl is shared with generate-platform-missions.mjs via
// ./lib/helm-sources.mjs (kubestellar/console-kb#3134, #3333).

// ─── Prompt builder ──────────────────────────────────────────────────

const INSTALL_SYSTEM_PROMPT = `You are an expert Kubernetes DevOps engineer. Your task is to generate a complete, accurate, and practical install mission for a CNCF project.

Rules:
- Generate REAL install steps with actual CLI commands, not placeholders
- Include verification steps using kubectl get/describe/logs
- Steps must be actionable — no "see documentation" or vague instructions
- For Helm: include helm repo add, update, install commands with specific versions
- For kubectl: include apply commands with specific manifest URLs
- Use the latest stable version from the context provided
- Each step description MUST contain the actual command in a markdown code block
- Return ONLY valid JSON, no markdown fences

IMPORTANT: If the project is not a CNCF project or cannot be meaningfully installed on Kubernetes, return {"skip": true}.`

function buildInstallPrompt(project, context) {
  const sections = []

  sections.push(`## CNCF Project: ${project.name}`)
  sections.push(`Maturity: ${project.maturity || 'sandbox'}`)
  sections.push(`Description: ${project.description || ''}`)

  if (context.repoMeta) {
    sections.push(`\nRepository: ${context.repoMeta.full_name}`)
    sections.push(`Stars: ${context.repoMeta.stargazers_count} | Language: ${context.repoMeta.language}`)
  }

  if (context.latestRelease) {
    sections.push(`Latest Release: ${context.latestRelease.tag_name} (${context.latestRelease.published_at?.slice(0, 10) || 'unknown'})`)
  }

  if (context.readme) {
    sections.push(`\n## README (excerpt)\n${context.readme.slice(0, 4000)}`)
  }

  if (context.helmCharts?.length > 0) {
    const chart = context.helmCharts[0]
    sections.push(`\n## Helm Chart.yaml\n\`\`\`yaml\n${chart.chartYaml}\n\`\`\``)
    if (chart.valuesYaml) {
      sections.push(`\n## Helm values.yaml (excerpt)\n\`\`\`yaml\n${chart.valuesYaml.slice(0, 2000)}\n\`\`\``)
    }
  }

  if (context.kustomize) {
    sections.push(`\n## kustomization.yaml\n\`\`\`yaml\n${context.kustomize.kustomization}\n\`\`\``)
  }

  if (context.operatorManifests) {
    sections.push(`\n## Operator Manifest (excerpt)\n\`\`\`yaml\n${context.operatorManifests.slice(0, 2000)}\n\`\`\``)
  }

  const slug = slugify(project.name)
  const installMethods = project.installMethods || ['kubectl']

  sections.push(`\n## Required JSON Schema\n\`\`\`json\n${JSON.stringify({
    version: 'kc-mission-v1',
    name: `install-${slug}`,
    missionClass: 'installer',
    author: 'KubeStellar Bot',
    authorGithub: 'kubestellar',
    mission: {
      title: `${project.name}: Complete Install Guide`,
      description: `Step-by-step Kubernetes installation guide for ${project.name}.`,
      type: 'configuration',
      status: 'completed',
      steps: [
        { title: 'Step title', description: 'Step with actual commands in code blocks' },
      ],
      resolution: {
        summary: 'What was installed and how to verify.',
        codeSnippets: ['key command or YAML'],
      },
    },
    metadata: {
      category: project.category || 'cncf',
      installMethods,
      cncfProjects: [project.name.toLowerCase()],
      qualityScore: 0,
    },
    prerequisites: {
      tools: ['kubectl', ...(installMethods.includes('helm') ? ['helm'] : [])],
      permissions: ['cluster-admin'],
    },
    security: {
      rbacRequired: true,
      networkPolicies: false,
    },
  }, null, 2)}\n\`\`\``)

  return sections.join('\n')
}

// ─── LLM call ────────────────────────────────────────────────────────

async function synthesizeInstallMission(project, context) {
  const token = process.env.LLM_TOKEN || GITHUB_TOKEN
  if (!token) return null

  const prompt = buildInstallPrompt(project, context)

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const response = await fetch(TRUSTED_LLM_ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: INSTALL_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 3000,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })

      if (response.status === 429) {
        const wait = parseInt(response.headers.get('retry-after') || '10', 10)
        log.warn(`  [LLM] Rate limited, waiting ${wait}s`)
        await sleep(wait * 1000)
        continue
      }
      if (!response.ok) {
        log.warn(`  [LLM] API error ${response.status}`)
        return null
      }

      // Validate Content-Type and enforce a response size ceiling before parsing
      // HTTP-derived bytes into the mission object that will be written to disk (CWE-434).
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        log.warn(`  [LLM] Unexpected Content-Type: ${contentType.slice(0, 100)}`)
        return null
      }
      const MAX_LLM_RESPONSE_BYTES = 1_000_000
      const rawText = await response.text()
      if (rawText.length > MAX_LLM_RESPONSE_BYTES) {
        log.warn(`  [LLM] Response too large (${rawText.length} bytes), rejecting`)
        return null
      }
      const data = JSON.parse(rawText)
      const content = data.choices?.[0]?.message?.content
      if (!content) return null

      const parsed = JSON.parse(content)
      if (parsed.skip || !parsed.steps?.length) return null
      return parsed
    } catch (err) {
      log.warn(`  [LLM] ${err.name === 'AbortError' ? 'Timeout' : err.message} (attempt ${attempt + 1})`)
      if (attempt < 2) await sleep(3000 * (attempt + 1))
    }
  }
  return null
}

// ─── Quality Gate ────────────────────────────────────────────────────

const INSTALL_CMD_RE = /helm install|helm upgrade|kubectl apply|kubectl create|docker run|operator-sdk|kustomize build|kubectl kustomize/i
const VERIFY_CMD_RE = /kubectl get|kubectl describe|kubectl logs|curl.*health|curl.*ready|kubectl port-forward|kubectl rollout status/i

export function applyQualityGate(mission, config) {
  const gates = []
  const qualityConf = config.quality || {}
  const minScore = qualityConf.minScore || QUALITY_THRESHOLD
  const draftMin = qualityConf.draftMinScore || DRAFT_THRESHOLD

  // Gate 5+6: Security scan (run first — cheapest)
  const sensitiveFindings = scanForSensitiveData(mission)
  if (sensitiveFindings.findings.length > 0) {
    return {
      tier: 'rejected',
      score: 0,
      gates: [{ gate: 'security', pass: false, reason: `Sensitive data: ${sensitiveFindings.findings.map(f => f.type).join(', ')}` }],
    }
  }

  const maliciousFindings = scanForMaliciousContent(mission)
  if (maliciousFindings.findings.length > 0) {
    return {
      tier: 'rejected',
      score: 0,
      gates: [{ gate: 'malicious', pass: false, reason: `Malicious content: ${maliciousFindings.findings.map(f => f.type).join(', ')}` }],
    }
  }

  // Gate 1: Schema
  const validation = validateMissionExport(mission)
  gates.push({ gate: 'schema', pass: validation.valid, reason: validation.errors?.join('; ') })

  // Gate 2: Install command
  const steps = mission.mission?.steps || []
  const hasInstallCmd = steps.some(s => INSTALL_CMD_RE.test(s.description || '') || INSTALL_CMD_RE.test(s.title || ''))
  gates.push({ gate: 'install-cmd', pass: hasInstallCmd, reason: hasInstallCmd ? null : 'No install command' })

  // Gate 3: Verification
  const hasVerify = steps.some(s => VERIFY_CMD_RE.test(s.description || '') || VERIFY_CMD_RE.test(s.title || ''))
  gates.push({ gate: 'verification', pass: hasVerify, reason: hasVerify ? null : 'No verification step' })

  // Gate 4: Step count
  gates.push({ gate: 'step-count', pass: steps.length >= 3, reason: steps.length < 3 ? `Only ${steps.length} steps` : null })

  // Gate 7: Quality score
  const { score } = scoreMission(mission)
  gates.push({ gate: 'quality-score', pass: score >= minScore, reason: score < minScore ? `Score ${score} < ${minScore}` : null })

  const allPass = gates.every(g => g.pass)
  const tier = allPass ? 'published' : (score >= draftMin ? 'draft' : 'rejected')

  return { tier, score, gates }
}

// ─── Path + slug helpers ─────────────────────────────────────────────
// slugify / assertSafeSlug / assertSafePath / serializeSanitizedMissionForFile
// are shared with generate-platform-missions.mjs via ./lib/mission-file.mjs
// (kubestellar/console-kb#3134, #3333).

function replaceUntilStable(input, pattern, replacement = '') {
  let previous
  do {
    previous = input
    input = input.replace(pattern, replacement)
  } while (input !== previous)
  return input
}

// ─── Helm URL validation ─────────────────────────────────────────────

async function validateAndFixHelmUrl(helmUrl, projectName) {
  const isValid = await checkHelmRepoUrl(helmUrl)
  if (isValid) return { valid: true, url: helmUrl }

  const artifactHubChart = await fetchArtifactHubChart(projectName)
  if (artifactHubChart?.repoUrl) {
    const fallbackValid = await checkHelmRepoUrl(artifactHubChart.repoUrl)
    if (fallbackValid) return { valid: true, url: artifactHubChart.repoUrl, fromArtifactHub: true }
  }
  return { valid: false }
}

// ─── Staleness check ─────────────────────────────────────────────────

function isMissionStale(filePath) {
  if (FORCE_REGENERATE) return true
  try {
    const mission = JSON.parse(readFileSync(filePath, 'utf-8'))
    const generatedAt = mission.metadata?.generatedAt
    if (!generatedAt) return true
    const age = (Date.now() - new Date(generatedAt).getTime()) / (1000 * 60 * 60 * 24)
    return age > 14
  } catch {
    return true
  }
}

function formatReport(report) {
  const lines = [
    '# CNCF Install Mission Generation Report',
    `Generated: ${new Date().toISOString()}`,
    `Model: ${LLM_MODEL}`,
    '',
    '## Summary',
    `- Published: ${report.published}`,
    `- Drafts: ${report.drafts}`,
    `- Rejected: ${report.rejected}`,
    `- Skipped: ${report.skipped}`,
    `- Errors: ${report.errors}`,
    `- Average Score: ${report.avgScore?.toFixed(1) ?? 'N/A'}`,
    '',
  ]

  if (report.projects?.length > 0) {
    lines.push('## Projects')
    for (const p of report.projects) {
      lines.push(`- **${p.name}** (${p.maturity}): score=${p.score}, tier=${p.tier}, methods=${p.installMethods}`)
    }
  }

  if (report.rejectedProjects?.length > 0) {
    lines.push('\n## Rejected Projects')
    for (const p of report.rejectedProjects) {
      lines.push(`- **${p.name}**: ${p.reason}`)
    }
  }

  return lines.join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== CNCF Install Mission Generator ===')
  if (!GITHUB_TOKEN) {
    log.error('GITHUB_TOKEN required')
    process.exit(1)
  }

  const config = loadInstallSourcesConfig()
  mkdirSync(SOLUTIONS_DIR, { recursive: true })

  // Collect projects
  let projects = [...CNCF_PROJECTS]

  if (TARGET_PROJECTS?.length) {
    projects = projects.filter(p =>
      TARGET_PROJECTS.some(t => p.name.toLowerCase().includes(t.toLowerCase()))
    )
    console.log(`Filtered to ${projects.length} projects matching: ${TARGET_PROJECTS.join(', ')}`)
  }

  // Batch slicing
  if (BATCH_INDEX != null) {
    const start = BATCH_INDEX * BATCH_SIZE
    const end = start + BATCH_SIZE
    console.log(`Batch ${BATCH_INDEX}: projects ${start}–${Math.min(end, projects.length) - 1} of ${projects.length}`)
    projects = projects.slice(start, end)
  }

  console.log(`Processing ${projects.length} projects\n`)

  const report = {
    published: 0, drafts: 0, rejected: 0, skipped: 0, errors: 0,
    scores: [], avgScore: 0,
    projects: [], rejectedProjects: [],
  }

  for (const project of projects) {
    const slug = slugify(project.name)
    assertSafeSlug(slug, 'project.name')
    const outFilename = basename(`install-${slug}.json`)
    if (!/^install-[a-z0-9-]+\.json$/.test(outFilename)) {
      throw new Error(`Unexpected output filename: ${outFilename}`)
    }
    const outPath = join(SOLUTIONS_DIR, outFilename)
    const draftFilename = basename(`install-${slug}.draft.json`)
    if (!/^install-[a-z0-9-]+\.draft\.json$/.test(draftFilename)) {
      throw new Error(`Unexpected draft filename: ${draftFilename}`)
    }
    const draftPath = join(SOLUTIONS_DIR, draftFilename)

    // Check if exists and is fresh
    if ((existsSync(outPath) || existsSync(draftPath)) && !isMissionStale(existsSync(outPath) ? outPath : draftPath)) {
      console.log(`  Skipping ${project.name} — mission exists and is fresh`)
      report.skipped++
      report.projects.push({ name: project.name, maturity: project.maturity, score: 0, tier: 'skipped', installMethods: 'N/A' })
      continue
    }

    console.log(`Processing: ${project.name} (${project.maturity})`)

    // Gather context from GitHub
    let context = {}
    try {
      context = await gatherProjectContext(project)
    } catch (err) {
      log.warn(`  Context gathering failed: ${err.message}`)
    }

    // Synthesize mission via LLM
    let llmResult
    try {
      llmResult = await synthesizeInstallMission(project, context)
    } catch (err) {
      log.error(`  LLM synthesis failed: ${err.message}`)
      report.errors++
      report.projects.push({ name: project.name, maturity: project.maturity, score: 0, tier: 'error', installMethods: 'N/A' })
      continue
    }

    if (!llmResult) {
      console.log(`  LLM returned null — skipping`)
      report.skipped++
      report.projects.push({ name: project.name, maturity: project.maturity, score: 0, tier: 'skipped', installMethods: 'N/A' })
      continue
    }

    // Build mission
    const authorConf = config.author || {}
    const mission = {
      version: 'kc-mission-v1',
      name: `install-${slug}`,
      missionClass: 'installer',
      author: authorConf.name || 'KubeStellar Bot',
      authorGithub: authorConf.github || 'kubestellar',
      mission: {
        title: String(llmResult.mission?.title || `${project.name}: Install Guide`).slice(0, 200),
        description: String(llmResult.mission?.description || '').slice(0, 500),
        type: 'configuration',
        status: 'completed',
        steps: (llmResult.mission?.steps || []).map(s => ({
          title: String(s.title || '').slice(0, 200),
          description: String(s.description || '').slice(0, 5000),
        })),
        resolution: {
          summary: String(llmResult.mission?.resolution?.summary || '').slice(0, 1000),
          codeSnippets: (llmResult.mission?.resolution?.codeSnippets || []).slice(0, 10).map(c => String(c).slice(0, 2000)),
        },
      },
      metadata: {
        category: project.category || 'cncf',
        installMethods: project.installMethods || ['kubectl'],
        cncfProjects: [project.name.toLowerCase()],
        qualityScore: 0,
        generatedAt: new Date().toISOString(),
      },
      prerequisites: {
        tools: ['kubectl', ...((project.installMethods || []).includes('helm') ? ['helm'] : [])],
        permissions: ['cluster-admin'],
      },
      security: {
        rbacRequired: true,
        networkPolicies: false,
      },
    }

    // Validate Helm repo URL
    if (llmResult.installMethods?.includes('helm') && llmResult.helmRepoUrl) {
      const helmUrl = String(llmResult.helmRepoUrl).trim()
      const helmValidation = await validateAndFixHelmUrl(helmUrl, project.name)

      if (!helmValidation.valid) {
        console.log(`  ❌ Rejected: LLM generated invalid Helm repo URL and no Artifact Hub fallback`)
        report.rejected++
        report.rejectedProjects.push({ name: project.name, reason: `Invalid Helm repo URL: ${helmUrl}` })
        report.projects.push({ name: project.name, maturity: project.maturity, score: 0, tier: 'rejected', installMethods: 'N/A' })
        continue
      }

      if (helmValidation.fromArtifactHub) {
        console.log(`  🔧 Fixing: replacing with Artifact Hub URL: ${helmValidation.url}`)
        const badUrl = helmUrl
        const goodUrl = helmValidation.url
        for (const step of mission.mission.steps) {
          step.description = step.description.replace(badUrl, goodUrl)
        }
        for (const step of (mission.mission.uninstall || [])) {
          step.description = step.description.replace(badUrl, goodUrl)
        }
        for (const step of (mission.mission.upgrade || [])) {
          step.description = step.description.replace(badUrl, goodUrl)
        }
        if (mission.mission.resolution?.codeSnippets) {
          mission.mission.resolution.codeSnippets = mission.mission.resolution.codeSnippets.map(s => s.replace(badUrl, goodUrl))
        }
      } else {
        console.log(`  ✅ Helm repo URL validated: ${helmUrl}`)
      }
    }

    // Apply quality gate
    const gateResult = applyQualityGate(mission, config)
    mission.metadata.qualityScore = gateResult.score

    const failedGates = gateResult.gates.filter(g => !g.pass).map(g => `${g.gate}: ${g.reason || 'failed'}`).join(', ')
    console.log(`  Score: ${gateResult.score} → ${gateResult.tier}${failedGates ? ` (${failedGates})` : ''}`)

    if (gateResult.tier === 'rejected') {
      console.log(`  ❌ Rejected: ${failedGates}`)
      report.rejected++
      report.rejectedProjects.push({ name: project.name, reason: failedGates })
      report.projects.push({ name: project.name, maturity: project.maturity, score: gateResult.score, tier: 'rejected', installMethods: 'N/A' })
      continue
    }

    report.scores.push(gateResult.score)
    const methods = (mission.metadata.installMethods || []).join(', ')

    // Sanitize mission text after LLM synthesis
    const sanitizeMissionText = (obj) => {
      if (typeof obj === 'string') {
        // Strip HTML tags and script content to prevent prompt injection in MDX output
        // Use loop-until-stable to handle overlapping/nested patterns (CWE-80, CWE-79)
        let sanitized = obj
        
        // Decode HTML entities first to catch entity-encoded attacks
        sanitized = sanitized
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#x27;/gi, "'")
          .replace(/&#x2F;/gi, '/')
          .replace(/&amp;/gi, '&')
        
        // Loop each multi-character sanitizer to a fixed point (CWE-80/116).
        // Match closing </script> with any content before > to cover variants like </script\t\n bar> (js/bad-tag-filter).
        sanitized = replaceUntilStable(sanitized, /<script[\s\S]*?<\/\s*script[^>]*>/gi)
        sanitized = replaceUntilStable(sanitized, /\bon\w+[\s\u0000-\u001F\u007F]*=[\s\u0000-\u001F\u007F]*(?:["'][^"']*["']|[^\s>]+)/gi)
        sanitized = replaceUntilStable(sanitized, /javascript[\s\u0000-\u001F\u007F]*:/gi)
        sanitized = replaceUntilStable(sanitized, /<[^>]+>/g)
        
        return sanitized
      }
      if (Array.isArray(obj)) return obj.map(sanitizeMissionText)
      if (obj && typeof obj === 'object') {
        const result = {}
        for (const [k, v] of Object.entries(obj)) result[k] = sanitizeMissionText(v)
        return result
      }
      return obj
    }
    mission.mission = sanitizeMissionText(mission.mission)

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would write: ${gateResult.tier === 'draft' ? draftPath : outPath}`)
    } else {
      // Sanitize HTTP-derived tier before using it to select the output path (CWE-73).
      // Both draftPath and outPath are computed from the validated local slug; we apply
      // path.basename() to isolate the filename component and validate it against an
      // allowlist pattern to break the taint from HTTP-sourced tier data.
      const candidatePath = gateResult.tier === 'draft' ? draftPath : outPath
      const safeBasename = basename(candidatePath)
      if (!/^install-[a-z0-9-]+(?:\.draft)?\.json$/.test(safeBasename)) {
        throw new Error(`Unexpected output filename derived from HTTP-sourced tier: ${safeBasename}`)
      }
      const targetPath = join(SOLUTIONS_DIR, safeBasename)

      // Path traversal guard (CWE-22)
      const resolvedPath = resolve(targetPath)
      const resolvedSolutionsDir = resolve(SOLUTIONS_DIR)
      assertSafePath(resolvedPath, resolvedSolutionsDir)
      const missionJson = serializeSanitizedMissionForFile(mission)
      
      // mission.mission is sanitized by sanitizeMissionText() above;
      // path validated via basename allowlist and assertSafePath(); serializeSanitizedMissionForFile()
      // applies a final integrity check before the bytes reach disk (fixes #2909).
      writeFileSync(resolvedPath, missionJson) // codeql[js/http-to-file-access]
      console.log(`  ✅ Written: ${safeBasename} (${methods})`)
    }

    if (gateResult.tier === 'draft') report.drafts++
    else report.published++

    report.projects.push({ name: project.name, maturity: project.maturity, score: gateResult.score, tier: gateResult.tier, installMethods: methods })

    await sleep(500)
  }

  report.avgScore = report.scores.length > 0 ? report.scores.reduce((a, b) => a + b, 0) / report.scores.length : 0

  const reportName = BATCH_INDEX != null ? `install-report-${BATCH_INDEX}.md` : 'install-report.md'
  writeFileSync(join(process.cwd(), reportName), formatReport(report))
  console.log(`\nDone: ${report.published} published, ${report.drafts} drafts, ${report.rejected} rejected, ${report.skipped} skipped, ${report.errors} errors`)
  console.log(`Average score: ${report.avgScore.toFixed(1)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    log.error('Fatal error:', err)
    process.exit(1)
  })
}

// ─── Test exports (pure helpers) ─────────────────────────────────────
// Exported for unit testing. These are pure functions with no network I/O.
export {
  buildInstallPrompt,
  formatReport,
  isMissionStale,
  replaceUntilStable,
  loadInstallSourcesConfig,
}

// ─── Shared lib re-exports ────────────────────────────────────────────
// slugify / assertSafeSlug / assertSafePath / serializeSanitizedMissionForFile
// live in ./lib/mission-file.mjs (shared with generate-platform-missions.mjs,
// kubestellar/console-kb#3134, #3333); re-exported here so existing imports
// of them from this file keep working unchanged.
export { slugify, assertSafeSlug, assertSafePath, serializeSanitizedMissionForFile }

// ─── Test exports (fetch-backed helpers) ──────────────────────────────
// Exported test-only (no behavior change) so the GitHub/ArtifactHub/LLM
// fetch wrappers can be exercised with `vi.stubGlobal('fetch', ...)`
// instead of hitting the network. Mirrors the pattern already used for
// `callLLM` in enrich-install-missions.mjs. Refs kubestellar/console-kb#3165,
// kubestellar/console-kb#3174.
export {
  assertTrustedEndpoint,
  githubApi,
  fetchRawFile,
  fetchReadme,
  fetchRepoMeta,
  fetchLatestRelease,
  fetchHelmCharts,
  fetchKustomizeManifests,
  fetchDockerImages,
  fetchOperatorManifests,
  fetchArtifactHubChart,
  checkHelmRepoUrl,
  fetchArtifactHubIndexForRepo,
  gatherProjectContext,
  synthesizeInstallMission,
  validateAndFixHelmUrl,
}
