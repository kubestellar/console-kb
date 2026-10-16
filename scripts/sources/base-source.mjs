/**
 * Base class for knowledge source integrations.
 * Each source module extends this to provide search + extraction for a specific platform.
 */

// `slugify` is re-exported from scripts/lib/text-utils.mjs so all sources
// (github-discussions, reddit, stackoverflow, and generate-cncf-missions'
// former `baseSlugify` alias) share a single implementation. See
// kubestellar/console-kb#3518.
import { slugify } from '../lib/text-utils.mjs'
export { slugify }

export class BaseSource {
  constructor(id, config) {
    this.id = id
    this.config = config
    this.enabled = config.enabled !== false
    this.maxPerProject = config.maxPerProject || 20
    this.searchWindow = config.searchWindow || '90d'
    this.requestCount = 0
    this.rateLimitDelay = config.rateLimitDelay || 200
  }

  /**
   * Generate a canonical ID for deduplication.
   * Must be unique across all sources.
   * @param {object} item - Raw item from the source API
   * @returns {string} e.g. "gh:kubernetes/kubernetes#12345"
   */
  canonicalId(item) {
    throw new Error(`${this.id}: canonicalId() not implemented`)
  }

  /**
   * Search the source for items related to a CNCF project.
   * @param {object} project - { name, repo, maturity, category, sources? }
   * @param {object} sourceState - { lastSearched, processedIds, cursor }
   * @returns {Promise<{ items: object[], cursor?: string }>}
   */
  async search(project, sourceState) {
    throw new Error(`${this.id}: search() not implemented`)
  }

  /**
   * Extract a kc-mission-v1 resolution from a raw item.
   * @param {object} item - Raw item from search results
   * @param {object} project - CNCF project metadata
   * @returns {Promise<object|null>} Mission object or null if not extractable
   */
  async extractMission(item, project) {
    throw new Error(`${this.id}: extractMission() not implemented`)
  }

  /**
   * Rate-limit-aware delay between requests.
   */
  async throttle() {
    this.requestCount++
    if (this.requestCount % 10 === 0) {
      await sleep(this.rateLimitDelay * 5)
    } else {
      await sleep(this.rateLimitDelay)
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Assembles the kc-mission-v1 object shared by both the LLM-synthesized and
 * raw-extraction paths of `buildMission` below — the `mission.title`,
 * `metadata.{tags,cncfProjects,targetResourceKinds,maturity,sourceUrls}`,
 * `prerequisites`, and `security` blocks (console-kb#3828) were previously
 * a byte-identical ~15-line copy in each path, differing only in the
 * `description`/`type`/`steps`/`resolution`/`difficulty`/`issueTypes`/
 * `synthesizedBy` values each path now passes in here.
 */
function buildCncfMission({ slug, title, description, type, steps, resolutionSummary, codeSnippets, labels, resourceKinds, difficulty, issueTypes, sourceUrl, sourceType, synthesizedBy, project }) {
  return {
    version: 'kc-mission-v1',
    name: slug,
    missionClass: 'fixer',
    author: 'KubeStellar Bot',
    authorGithub: 'kubestellar',
    mission: {
      title,
      description,
      type,
      status: 'completed',
      steps,
      resolution: {
        summary: resolutionSummary,
        codeSnippets,
      },
    },
    metadata: {
      tags: [project.name, project.maturity, ...(labels || [])].filter((v, i, a) => a.indexOf(v) === i),
      cncfProjects: [project.name],
      targetResourceKinds: resourceKinds || [],
      difficulty,
      issueTypes,
      maturity: project.maturity,
      sourceUrls: {
        [sourceType || 'source']: sourceUrl,
        repo: `https://github.com/${project.repo}`,
      },
      synthesizedBy,
    },
    prerequisites: {
      kubernetes: '>=1.24',
      tools: ['kubectl'],
      description: `A running Kubernetes cluster with ${project.name} installed or the issue environment reproducible.`,
    },
    security: {
      scannedAt: new Date().toISOString(),
      scannerVersion: 'cncf-gen-2.0.0',
      sanitized: true,
      findings: [],
    },
  }
}

/**
 * Build the kc-mission-v1 JSON structure used by all sources.
 * If LLM synthesis is available, uses it to improve quality.
 */
export async function buildMission({ title, description, problem, solution, steps, yamlSnippets, difficulty, type, labels, resourceKinds, sourceUrl, sourceType, project }) {
  // Try LLM synthesis for higher quality
  let llmResult = null
  try {
    const { synthesizeMission } = await import('./llm-synthesizer.mjs')
    llmResult = await synthesizeMission({
      projectName: project.name,
      issueTitle: title,
      issueBody: problem || description || '',
      labels: labels || [],
      solution: solution || '',
      codeSnippets: yamlSnippets || [],
      prUrl: null,
      prDiff: null,
      sourceUrl,
    })
  } catch {
    // LLM not available, continue with raw extraction
  }

  const slug = slugify(`${project.name}-${sourceType}-${title}`)

  if (llmResult) {
    const missionSteps = (llmResult.steps || []).map(s => ({
      title: s.title.slice(0, 120),
      description: (s.description || '').slice(0, 3000),
    }))
    return buildCncfMission({
      slug,
      title,
      description: llmResult.description,
      type: llmResult.type || type || 'troubleshoot',
      steps: missionSteps,
      resolutionSummary: llmResult.resolution,
      codeSnippets: extractSnippetsFromSteps(missionSteps, yamlSnippets),
      labels,
      resourceKinds,
      difficulty: llmResult.difficulty || difficulty || 'intermediate',
      issueTypes: [llmResult.type || type || 'troubleshoot'],
      sourceUrl,
      sourceType,
      synthesizedBy: 'llm',
      project,
    })
  }

  // Fallback: raw extraction
  const rawSteps = (steps || []).map(s => {
    const step = typeof s === 'string' ? { title: s, description: s } : s
    return { title: step.title.slice(0, 120), description: (step.description || '').slice(0, 3000) }
  })
  return buildCncfMission({
    slug,
    title,
    description: description || problem || title,
    type: type || 'troubleshoot',
    steps: rawSteps,
    resolutionSummary: solution || description || '',
    codeSnippets: extractSnippetsFromSteps(rawSteps, yamlSnippets),
    labels,
    resourceKinds,
    difficulty: difficulty || 'intermediate',
    issueTypes: [type || 'troubleshoot'],
    sourceUrl,
    sourceType,
    synthesizedBy: 'regex',
    project,
  })
}

function extractSnippetsFromSteps(steps, yamlSnippets) {
  const snippets = []
  for (const step of steps) {
    const matches = (step.description || '').matchAll(/```[\w]*\n([\s\S]*?)```/g)
    for (const m of matches) {
      if (m[1].trim().length > 10) snippets.push(m[1].trim())
      if (snippets.length >= 5) return snippets
    }
  }
  if (yamlSnippets) {
    for (const s of yamlSnippets) {
      if (snippets.length >= 5) break
      if (s.trim().length > 10) snippets.push(s.trim())
    }
  }
  return snippets
}
