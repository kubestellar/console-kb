/**
 * GitHub Discussions knowledge source — searches GitHub Discussions via GraphQL
 * for answered Q&A threads with high engagement.
 *
 * Uses the existing GITHUB_TOKEN — no additional credentials needed.
 */
import { BaseSource, slugify, buildMission } from './base-source.mjs'
import { computeSinceDate } from './search-state.mjs'

const GRAPHQL_URL = 'https://api.github.com/graphql'

export class GitHubDiscussionsSource extends BaseSource {
  constructor(config) {
    super('github-discussions', config)
    this.minUpvotes = config.minUpvotes || 5
    this.token = process.env.GITHUB_TOKEN
  }

  canonicalId(item) {
    return `ghd:${item.repository?.nameWithOwner || 'unknown'}/${item.number}`
  }

  async search(project, sourceState) {
    if (!this.token) {
      console.warn('  Discussions: No GITHUB_TOKEN, skipping')
      return { items: [] }
    }

    const sinceDate = computeSinceDate(sourceState, this.searchWindow)
    const [owner, repo] = project.repo.split('/')
    const items = []

    // First check if repo has discussions enabled
    const hasDiscussions = await this.checkDiscussionsEnabled(owner, repo)
    if (!hasDiscussions) {
      return { items: [] }
    }

    // Search for answered discussions
    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          discussions(
            first: 25
            orderBy: { field: UPDATED_AT, direction: DESC }
            after: $cursor
            answered: true
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              body
              url
              createdAt
              updatedAt
              upvoteCount
              answer {
                body
                url
                createdAt
                upvoteCount
                author { login }
              }
              labels(first: 5) {
                nodes { name }
              }
              category { name slug }
              repository { nameWithOwner }
            }
          }
        }
      }
    `

    let cursor = sourceState.cursor || null
    let page = 0
    const MAX_PAGES = 3

    while (page < MAX_PAGES && items.length < this.maxPerProject) {
      try {
        await this.throttle()
        const response = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'cncf-mission-generator/1.0',
          },
          body: JSON.stringify({
            query,
            variables: { owner, repo, cursor },
          }),
        })

        if (!response.ok) {
          console.warn(`  Discussions: ${response.status} for ${project.repo}, skipping`)
          break
        }

        const result = await response.json()
        if (result.errors) {
          console.warn(`  Discussions: GraphQL errors for ${project.repo}: ${result.errors[0]?.message}`)
          break
        }

        const discussions = result.data?.repository?.discussions
        if (!discussions) break

        for (const d of discussions.nodes || []) {
          if (!d || !d.answer) continue
          if (d.upvoteCount < this.minUpvotes) continue

          // Skip if before our search window
          if (sinceDate && new Date(d.updatedAt) < new Date(sinceDate)) continue

          const cid = this.canonicalId(d)
          if (sourceState.processedIds.includes(cid)) continue

          items.push(d)
          if (items.length >= this.maxPerProject) break
        }

        if (!discussions.pageInfo?.hasNextPage) break
        cursor = discussions.pageInfo.endCursor
        page++
      } catch (err) {
        console.warn(`  Discussions: Error for ${project.repo}: ${err.message}`)
        break
      }
    }

    return { items, cursor }
  }

  async extractMission(item, project) {
    const title = item.title || 'GitHub Discussion'
    const body = item.body || ''
    const answer = item.answer?.body || ''
    const url = item.url

    if (!answer || answer.length < 50) return null

    const problem = body.slice(0, 500)
    const solution = answer.slice(0, 2000)

    const yamlSnippets = extractCodeBlocks(body + '\n' + answer)
    const allText = `${title} ${body} ${answer}`
    const labels = [
      project.name,
      project.category,
      ...(item.labels?.nodes?.map(l => l.name) || []),
    ]
    const resourceKinds = extractResourceKinds(allText)
    const difficulty = item.upvoteCount > 20 ? 'advanced' : 'intermediate'
    const type = item.category?.slug === 'q-a' ? 'troubleshooting' : detectType(allText)

    return buildMission({
      title: `${project.name}: ${title.slice(0, 120)}`,
      description: problem,
      problem,
      solution,
      steps: extractSteps(answer),
      yamlSnippets,
      difficulty,
      type,
      labels: [...new Set(labels)],
      resourceKinds,
      sourceUrl: url,
      sourceType: 'github-discussions',
      project,
    })
  }

  async checkDiscussionsEnabled(owner, repo) {
    try {
      await this.throttle()
      const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'cncf-mission-generator/1.0',
        },
        body: JSON.stringify({
          query: `query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
              hasDiscussionsEnabled
            }
          }`,
          variables: { owner, repo },
        }),
      })
      if (!response.ok) return false
      const result = await response.json()
      return result.data?.repository?.hasDiscussionsEnabled === true
    } catch {
      return false
    }
  }
}

function extractCodeBlocks(text) {
  const blocks = []
  const regex = /```(?:yaml|yml|bash|sh)?\n([\s\S]*?)```/gi
  let match
  while ((match = regex.exec(text)) !== null) {
    const block = match[1].trim()
    if (block.length > 20 && block.length < 5000) blocks.push(block)
  }
  return blocks
}

function extractResourceKinds(text) {
  const kinds = ['Pod', 'Deployment', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'PersistentVolumeClaim', 'NetworkPolicy', 'ServiceAccount', 'ClusterRole', 'HorizontalPodAutoscaler']
  return kinds.filter(k => text.includes(k) || text.toLowerCase().includes(k.toLowerCase()))
}

function detectType(text) {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('crash') || lower.includes('fail')) return 'troubleshooting'
  if (lower.includes('how to') || lower.includes('best practice')) return 'best-practice'
  if (lower.includes('performance') || lower.includes('slow')) return 'performance'
  if (lower.includes('security') || lower.includes('rbac')) return 'security'
  return 'troubleshooting'
}

function extractSteps(text) {
  const steps = []
  const numbered = text.match(/\d+[.)]\s+[^\n]+/g)
  if (numbered) {
    for (const step of numbered.slice(0, 10)) {
      steps.push(step.replace(/^\d+[.)]\s+/, '').trim())
    }
  }
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
