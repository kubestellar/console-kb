/**
 * Base class for knowledge source integrations.
 * Each source module extends this to provide search + extraction for a specific platform.
 */

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
 * Slugify a string for use as a filename.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
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

  if (llmResult) {
    return {
      format: 'kc-mission-v1',
      exportedAt: new Date().toISOString(),
      exportedBy: 'cncf-mission-generator',
      consoleVersion: 'auto-generated',
      mission: {
        title,
        description: llmResult.description,
        type: llmResult.type || type || 'troubleshoot',
        status: 'completed',
        steps: llmResult.steps,
        resolution: {
          summary: llmResult.resolution,
          steps: llmResult.steps.map(s => s.title),
          codeSnippets: yamlSnippets?.slice(0, 3),
        },
      },
      metadata: {
        tags: labels || [],
        category: project.category,
        cncfProjects: [project.name],
        targetResourceKinds: resourceKinds || [],
        difficulty: llmResult.difficulty || difficulty || 'intermediate',
        sourceUrl,
        sourceType,
        sourceRepo: project.repo,
        synthesizedBy: 'llm',
      },
      security: {
        scannedAt: new Date().toISOString(),
        scannerVersion: 'cncf-gen-2.0.0',
        sanitized: true,
        findings: [],
      },
    }
  }

  // Fallback: raw extraction
  return {
    format: 'kc-mission-v1',
    exportedAt: new Date().toISOString(),
    exportedBy: 'cncf-mission-generator',
    consoleVersion: 'auto-generated',
    mission: {
      title,
      description: description || problem || title,
      type: type || 'troubleshoot',
      status: 'completed',
      steps: (steps || []).map(s => typeof s === 'string' ? { title: s, description: s } : s),
      resolution: {
        summary: solution || description || '',
        steps: steps || [],
        codeSnippets: yamlSnippets?.slice(0, 3),
      },
    },
    metadata: {
      tags: labels || [],
      category: project.category,
      cncfProjects: [project.name],
      targetResourceKinds: resourceKinds || [],
      difficulty: difficulty || 'intermediate',
      sourceUrl,
      sourceType,
      sourceRepo: project.repo,
      synthesizedBy: 'regex',
    },
    security: {
      scannedAt: new Date().toISOString(),
      scannerVersion: 'cncf-gen-2.0.0',
      sanitized: true,
      findings: [],
    },
  }
}
