/**
 * Reddit knowledge source — searches Reddit's public JSON API for
 * high-quality posts related to CNCF projects.
 *
 * Uses old.reddit.com JSON endpoints which are more permissive from
 * cloud/CI environments. Requires a compliant User-Agent per Reddit API rules.
 */
import { BaseSource, slugify, buildMission } from './base-source.mjs'
import { computeSinceDate } from './search-state.mjs'

// Reddit requires descriptive User-Agent: platform:appid:version (by contact)
const REDDIT_USER_AGENT = 'linux:cncf-mission-generator:v1.0.0 (by /u/kubestellar-bot; github.com/kubestellar/console-kb)'
const REDDIT_BASE = 'https://old.reddit.com'

export class RedditSource extends BaseSource {
  constructor(config) {
    super('reddit', config)
    this.subreddits = config.subreddits || ['kubernetes', 'devops', 'k8s']
    this.minUpvotes = config.minUpvotes || 20
  }

  canonicalId(item) {
    return `reddit:${item.data?.id || item.id}`
  }

  async search(project, sourceState) {
    const sinceDate = computeSinceDate(sourceState, this.searchWindow)
    const projectSubs = project.sources?.reddit?.subreddits || this.subreddits
    const items = []

    for (const subreddit of projectSubs) {
      if (items.length >= this.maxPerProject) break

      const url = `${REDDIT_BASE}/r/${subreddit}/search.json?q=${encodeURIComponent(project.name)}&sort=top&t=year&restrict_sr=1&limit=25`

      try {
        await this.throttle()
        const response = await fetch(url, {
          headers: {
            'User-Agent': REDDIT_USER_AGENT,
            'Accept': 'application/json',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) {
          console.warn(`  Reddit: ${response.status} for r/${subreddit} search, skipping`)
          continue
        }

        const data = await response.json()
        const posts = data?.data?.children || []

        for (const post of posts) {
          const d = post.data
          if (!d) continue
          if (d.ups < this.minUpvotes) continue
          if (d.removed_by_category) continue
          if (d.over_18) continue

          // Skip if before our search window
          if (sinceDate) {
            const postDate = new Date(d.created_utc * 1000)
            if (postDate < new Date(sinceDate)) continue
          }

          // Skip already-processed
          const cid = this.canonicalId(post)
          if (sourceState.processedIds.includes(cid)) continue

          items.push(post)
          if (items.length >= this.maxPerProject) break
        }
      } catch (err) {
        console.warn(`  Reddit: Error searching r/${subreddit}: ${err.message}`)
      }
    }

    return { items }
  }

  async extractMission(item, project) {
    const d = item.data
    if (!d || !d.selftext || d.selftext.length < 100) return null

    const title = d.title || 'Reddit discussion'
    const body = d.selftext || ''
    const url = `https://www.reddit.com${d.permalink}`

    // Extract problem/solution from post body
    const problem = body.slice(0, 500)
    const solution = await this.fetchTopComments(d.permalink)

    if (!solution) return null

    // Extract YAML snippets
    const yamlSnippets = extractCodeBlocks(body + '\n' + solution, ['yaml', 'yml'])

    // Detect labels and resource kinds
    const allText = `${title} ${body} ${solution}`
    const labels = extractRedditLabels(allText, project)
    const resourceKinds = extractResourceKinds(allText)
    const difficulty = body.length > 1000 ? 'advanced' : 'intermediate'

    return await buildMission({
      title: `${project.name}: ${cleanTitle(title)}`,
      description: problem,
      problem,
      solution,
      steps: extractSteps(solution),
      yamlSnippets,
      difficulty,
      type: detectType(allText),
      labels,
      resourceKinds,
      sourceUrl: url,
      sourceType: 'reddit',
      project,
    })
  }

  async fetchTopComments(permalink) {
    try {
      await this.throttle()
      const url = `${REDDIT_BASE}${permalink}.json?sort=top&limit=5`
      const response = await fetch(url, {
        headers: {
          'User-Agent': REDDIT_USER_AGENT,
          'Accept': 'application/json',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return null

      const data = await response.json()
      if (!Array.isArray(data) || data.length < 2) return null

      const comments = data[1]?.data?.children || []
      const topComments = comments
        .filter(c => c.data?.body && c.data.ups > 2 && !c.data.stickied)
        .sort((a, b) => (b.data.ups || 0) - (a.data.ups || 0))
        .slice(0, 3)
        .map(c => c.data.body)

      return topComments.join('\n\n---\n\n') || null
    } catch {
      return null
    }
  }
}

function cleanTitle(title) {
  return title.replace(/^\[.*?\]\s*/, '').replace(/\?$/, '').trim().slice(0, 120)
}

function extractCodeBlocks(text, langs) {
  const blocks = []
  const regex = /```(?:yaml|yml)?\n([\s\S]*?)```/gi
  let match
  while ((match = regex.exec(text)) !== null) {
    const block = match[1].trim()
    if (block.length > 20 && block.length < 5000) blocks.push(block)
  }
  return blocks
}

function extractRedditLabels(text, project) {
  const labels = [project.name, project.category]
  const keywords = ['helm', 'kubectl', 'pod', 'deployment', 'service', 'ingress', 'configmap', 'secret', 'namespace', 'pvc', 'crd', 'operator']
  for (const kw of keywords) {
    if (text.toLowerCase().includes(kw)) labels.push(kw)
  }
  return [...new Set(labels)]
}

function extractResourceKinds(text) {
  const kinds = ['Pod', 'Deployment', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'PersistentVolumeClaim', 'NetworkPolicy', 'ServiceAccount', 'ClusterRole', 'HorizontalPodAutoscaler']
  return kinds.filter(k => text.includes(k) || text.toLowerCase().includes(k.toLowerCase()))
}

function detectType(text) {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('crash') || lower.includes('fail')) return 'troubleshooting'
  if (lower.includes('how to') || lower.includes('best practice') || lower.includes('recommend')) return 'best-practice'
  if (lower.includes('performance') || lower.includes('slow') || lower.includes('latency')) return 'performance'
  if (lower.includes('security') || lower.includes('rbac') || lower.includes('tls')) return 'security'
  return 'troubleshooting'
}

function extractSteps(text) {
  const steps = []
  // Look for numbered lists
  const numbered = text.match(/\d+[.)]\s+[^\n]+/g)
  if (numbered) {
    for (const step of numbered.slice(0, 10)) {
      steps.push(step.replace(/^\d+[.)]\s+/, '').trim())
    }
  }
  // Look for bullet points
  if (steps.length === 0) {
    const bullets = text.match(/^[-*]\s+[^\n]+/gm)
    if (bullets) {
      for (const step of bullets.slice(0, 10)) {
        steps.push(step.replace(/^[-*]\s+/, '').trim())
      }
    }
  }
  return steps
}
