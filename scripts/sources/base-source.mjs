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
 */
export function buildMission({ title, description, problem, solution, steps, yamlSnippets, difficulty, type, labels, resourceKinds, sourceUrl, sourceType, project }) {
  return {
    apiVersion: 'kc-mission-v1',
    metadata: {
      difficulty: difficulty || 'intermediate',
      type: type || 'troubleshooting',
      labels: labels || [],
      resourceKinds: resourceKinds || [],
      project: project.name,
      maturity: project.maturity,
      category: project.category,
      sourceType,
      sourceUrl,
      generatedAt: new Date().toISOString(),
    },
    mission: {
      title,
      description: description || problem || title,
      issueSignatures: [{
        type: type || 'troubleshooting',
        pattern: title,
        keywords: labels || [],
      }],
      resolutionSteps: {
        summary: solution || description || '',
        steps: steps || [],
        yaml: yamlSnippets?.join('\n---\n') || undefined,
      },
    },
  }
}
