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

  const slug = slugify(`${project.name}-${sourceType}-${title}`)

  if (llmResult) {
    const missionSteps = (llmResult.steps || []).map(s => ({
      title: s.title.slice(0, 120),
      description: (s.description || '').slice(0, 3000),
    }))
    return {
      version: 'kc-mission-v1',
      name: slug,
      missionClass: 'solution',
      author: 'KubeStellar Bot',
      authorGithub: 'kubestellar',
      mission: {
        title,
        description: llmResult.description,
        type: llmResult.type || type || 'troubleshoot',
        status: 'completed',
        steps: missionSteps,
        resolution: {
          summary: llmResult.resolution,
          codeSnippets: extractSnippetsFromSteps(missionSteps, yamlSnippets),
        },
      },
      metadata: {
        tags: [project.name, project.maturity, ...(labels || [])].filter((v, i, a) => a.indexOf(v) === i),
        cncfProjects: [project.name],
        targetResourceKinds: resourceKinds || [],
        difficulty: llmResult.difficulty || difficulty || 'intermediate',
        issueTypes: [llmResult.type || type || 'troubleshoot'],
        maturity: project.maturity,
        sourceUrls: {
          [sourceType || 'source']: sourceUrl,
          repo: `https://github.com/${project.repo}`,
        },
        synthesizedBy: 'llm',
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

  // Fallback: raw extraction
  const rawSteps = (steps || []).map(s => {
    const step = typeof s === 'string' ? { title: s, description: s } : s
    return { title: step.title.slice(0, 120), description: (step.description || '').slice(0, 3000) }
  })
  return {
    version: 'kc-mission-v1',
    name: slug,
    missionClass: 'solution',
    author: 'KubeStellar Bot',
    authorGithub: 'kubestellar',
    mission: {
      title,
      description: description || problem || title,
      type: type || 'troubleshoot',
      status: 'completed',
      steps: rawSteps,
      resolution: {
        summary: solution || description || '',
        codeSnippets: extractSnippetsFromSteps(rawSteps, yamlSnippets),
      },
    },
    metadata: {
      tags: [project.name, project.maturity, ...(labels || [])].filter((v, i, a) => a.indexOf(v) === i),
      cncfProjects: [project.name],
      targetResourceKinds: resourceKinds || [],
      difficulty: difficulty || 'intermediate',
      issueTypes: [type || 'troubleshoot'],
      maturity: project.maturity,
      sourceUrls: {
        [sourceType || 'source']: sourceUrl,
        repo: `https://github.com/${project.repo}`,
      },
      synthesizedBy: 'regex',
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
