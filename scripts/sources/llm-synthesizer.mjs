/**
 * LLM-powered mission synthesizer using GitHub Models API.
 * Takes raw issue/PR/comment data and produces high-quality structured missions
 * with actionable steps, clean descriptions, and proper resolution summaries.
 *
 * Uses gpt-4o-mini via https://models.inference.ai.azure.com (free for GitHub Actions).
 * Falls back gracefully if LLM is unavailable.
 */

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://models.inference.ai.azure.com/chat/completions'
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini'
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10)
const LLM_MAX_RETRIES = 2

// Use GITHUB_TOKEN for GitHub Models API authentication
function getLLMToken() {
  return process.env.LLM_TOKEN || process.env.GITHUB_TOKEN
}

/**
 * Synthesize a high-quality mission from raw issue context.
 * Returns a structured object or null if the issue isn't actionable.
 *
 * @param {object} params
 * @param {string} params.projectName - CNCF project name
 * @param {string} params.issueTitle - Issue title
 * @param {string} params.issueBody - Raw issue body (pre-cleaned of HTML comments)
 * @param {string[]} params.labels - Issue labels
 * @param {string} params.solution - Extracted solution text (from PR or comments)
 * @param {string[]} params.codeSnippets - Extracted YAML/code blocks
 * @param {string} params.prUrl - Linked PR URL if available
 * @param {string} params.prDiff - PR diff summary (file names + key changes)
 * @param {string} params.sourceUrl - Source issue/discussion URL
 * @returns {Promise<{description: string, steps: Array<{title: string, description: string}>, resolution: string, difficulty: string, type: string} | null>}
 */
export async function synthesizeMission(params) {
  const token = getLLMToken()
  if (!token) {
    return null
  }

  const prompt = buildPrompt(params)

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(LLM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10)
        console.warn(`  [LLM] Rate limited, waiting ${retryAfter}s (attempt ${attempt + 1})`)
        await sleep(retryAfter * 1000)
        continue
      }

      if (!response.ok) {
        console.warn(`  [LLM] API error ${response.status}: ${response.statusText}`)
        return null
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) {
        console.warn('  [LLM] Empty response')
        return null
      }

      const parsed = JSON.parse(content)

      // LLM returns null/"skip" if issue isn't actionable
      if (parsed.skip || !parsed.description || !parsed.steps?.length) {
        return null
      }

      return validateAndClean(parsed)
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        console.warn(`  [LLM] Timeout after ${LLM_TIMEOUT_MS}ms (attempt ${attempt + 1})`)
      } else if (err instanceof SyntaxError) {
        console.warn(`  [LLM] Invalid JSON response (attempt ${attempt + 1})`)
      } else {
        console.warn(`  [LLM] Error: ${err.message} (attempt ${attempt + 1})`)
      }

      if (attempt < LLM_MAX_RETRIES) {
        await sleep(2000 * (attempt + 1))
      }
    }
  }

  return null
}

const SYSTEM_PROMPT = `You are an expert Kubernetes technical writer creating missions for the KubeStellar Console.
A "mission" is a structured guide that helps a Kubernetes operator solve a real problem.

Your output MUST be a JSON object with these fields:
{
  "description": "1-3 sentence problem description. Be specific about what breaks and when.",
  "steps": [
    {
      "title": "Short imperative title (e.g. 'Configure the HPA threshold')",
      "description": "Detailed step with exact commands, YAML snippets, or file paths. Must be copy-pasteable."
    }
  ],
  "resolution": "2-4 sentence summary explaining WHY this solution works, not just WHAT was changed.",
  "difficulty": "beginner|intermediate|advanced|expert",
  "type": "troubleshoot|deploy|upgrade|analyze|configure",
  "skip": false
}

Rules:
- If the issue has NO actionable resolution (feature request with no implementation, discussion with no conclusion), return {"skip": true}
- Steps MUST be concrete and actionable. Include kubectl commands, YAML configs, helm values, or code changes.
- Never use generic steps like "Review the issue" or "Check the documentation"
- 3-6 steps is ideal. Each step should be one discrete action.
- The description should help someone recognize "yes, this is the problem I have"
- Strip all PR template boilerplate, bot commands, and GitHub automation text
- Do NOT invent information — only use what's provided in the context`

function buildPrompt(params) {
  const sections = [`# ${params.projectName}: ${params.issueTitle}`]

  if (params.issueBody) {
    sections.push(`## Issue Body\n${truncate(params.issueBody, 2000)}`)
  }

  if (params.labels?.length) {
    sections.push(`## Labels\n${params.labels.join(', ')}`)
  }

  if (params.solution) {
    sections.push(`## Solution/Resolution\n${truncate(params.solution, 2000)}`)
  }

  if (params.codeSnippets?.length) {
    sections.push(`## Code Snippets\n${params.codeSnippets.map(s => '```\n' + truncate(s, 500) + '\n```').join('\n')}`)
  }

  if (params.prUrl) {
    sections.push(`## Linked PR\n${params.prUrl}`)
  }

  if (params.prDiff) {
    sections.push(`## PR Changes Summary\n${truncate(params.prDiff, 1500)}`)
  }

  sections.push('\nSynthesize a high-quality mission from the above context. Return JSON.')

  return sections.join('\n\n')
}

function validateAndClean(parsed) {
  // Ensure steps have required fields
  const steps = (parsed.steps || [])
    .filter(s => s.title && s.description)
    .map(s => ({
      title: s.title.slice(0, 120),
      description: s.description.slice(0, 2000),
    }))

  if (steps.length < 2) return null

  const validDifficulties = ['beginner', 'intermediate', 'advanced', 'expert']
  const validTypes = ['troubleshoot', 'deploy', 'upgrade', 'analyze', 'configure']

  return {
    description: (parsed.description || '').slice(0, 500),
    steps,
    resolution: (parsed.resolution || '').slice(0, 1500),
    difficulty: validDifficulties.includes(parsed.difficulty) ? parsed.difficulty : 'intermediate',
    type: validTypes.includes(parsed.type) ? parsed.type : 'troubleshoot',
  }
}

function truncate(text, max) {
  if (!text) return ''
  if (text.length <= max) return text
  return text.slice(0, max) + '\n... [truncated]'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
