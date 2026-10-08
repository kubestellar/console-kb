/**
 * LLM prompt-building and synthesis for the platform mission generator.
 *
 * Extracted from generate-platform-missions.mjs (console-kb#3163). The
 * trusted-endpoint / token / model config it depends on lives in
 * ../lib/platform-llm-config.mjs (console-kb#3544), which is the single
 * place those env-derived constants are validated (assertTrustedEndpoint
 * runs once, at module load, when that module is imported). This module
 * must not import from the orchestrator that calls it.
 */
import { slugify } from '../lib/mission-file.mjs'
import { getLlmToken, getGithubToken, TRUSTED_LLM_ENDPOINT, LLM_MODEL, LLM_TIMEOUT_MS } from '../lib/platform-llm-config.mjs'
import { createLogger } from '../lib/logger.mjs'

const log = createLogger('synthesize')
export const PLATFORM_SYSTEM_PROMPT = `You are an expert Kubernetes platform engineer. Your task is to generate a comprehensive, accurate, and practical install mission JSON for a specific Kubernetes platform or managed service.

Rules:
- Generate REAL install steps with actual CLI commands, not placeholders
- Use the latest stable version from the releases provided
- Include version-specific flags and options
- Steps must be actionable — no "see documentation" or vague instructions
- Include verification steps with kubectl commands
- Follow the exact JSON schema provided
- For cloud providers: include cloud-specific CLI commands (aws, gcloud, az)
- For helm: include proper repo add, update, install commands with specific chart versions
- For kubectl: include apply commands with specific manifest URLs or inline YAML
- Include prerequisites: specific tool versions required
- The "description" of each step must include the actual command in a code block

IMPORTANT: Return ONLY the JSON object, no markdown fences.`

export function buildPlatformPrompt(platform, context) {
  const sections = []

  sections.push(`## Platform: ${platform.name}`)
  sections.push(`Category: ${platform.category || 'Kubernetes platform'}`)
  sections.push(`Description: ${platform.description || ''}`)
  if (platform.version) sections.push(`Latest Version: ${platform.version}`)
  if (platform.provider) sections.push(`Provider: ${platform.provider}`)

  if (context.releases?.length > 0) {
    const latest = context.releases[0]
    sections.push(`\nLatest Release: ${latest.tag_name} (${latest.published_at?.slice(0, 10) || 'unknown'})`)
  }

  if (context.repoMeta) {
    sections.push(`\nRepository: ${context.repoMeta.full_name}`)
    sections.push(`Stars: ${context.repoMeta.stargazers_count} | Language: ${context.repoMeta.language}`)
  }

  if (context.readme) {
    sections.push(`\n## README (excerpt)\n${context.readme.slice(0, 3000)}`)
  }

  if (context.helmChart) {
    sections.push(`\n## Chart.yaml\n\`\`\`yaml\n${context.helmChart}\n\`\`\``)
  }

  if (context.helmValues) {
    sections.push(`\n## values.yaml (excerpt)\n\`\`\`yaml\n${context.helmValues.slice(0, 2000)}\n\`\`\``)
  }

  if (context.kustomize) {
    sections.push(`\n## kustomization.yaml\n\`\`\`yaml\n${context.kustomize}\n\`\`\``)
  }

  const slug = slugify(platform.name)
  const installMethods = platform.installMethods || ['kubectl']

  sections.push(`\n## Required Output Schema\n\`\`\`json\n${JSON.stringify({
    version: 'kc-mission-v1',
    name: `platform-${slug}`,
    missionClass: 'installer',
    author: 'KubeStellar Bot',
    authorGithub: 'kubestellar',
    mission: {
      title: `${platform.name}: Complete Install Guide`,
      description: `Step-by-step installation guide for ${platform.name}.`,
      type: 'configuration',
      status: 'completed',
      steps: [
        { title: 'Step title', description: 'Step with actual commands' },
      ],
      resolution: {
        summary: 'Summary of what was installed and how to verify.',
        codeSnippets: ['key command or config snippet'],
      },
    },
    metadata: {
      category: platform.category || 'platform',
      installMethods,
      cncfProjects: platform.cncfProjects || [],
      qualityScore: 0,
    },
    prerequisites: {
      tools: platform.prerequisites?.tools || ['kubectl'],
      permissions: ['cluster-admin'],
    },
    security: {
      rbacRequired: true,
      networkPolicies: false,
    },
  }, null, 2)}\n\`\`\``)

  return sections.join('\n')
}

export async function synthesizePlatformMission(platform, context) {
  const prompt = buildPlatformPrompt(platform, context)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

  const requestBody = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: PLATFORM_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 6000,
    response_format: { type: 'json_object' },
  })
  const post = (token) =>
    fetch(TRUSTED_LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      signal: controller.signal,
      body: requestBody,
    })
  const isJson = (res) => (res.headers.get('content-type') || '').includes('application/json')

  try {
    let response = await post(getLlmToken())

    // A 200 text/plain "OK" body means the LLM_TOKEN PAT is not accepted by
    // the Models endpoint (console-kb#3702, #3742). Retry once with the
    // workflow's GITHUB_TOKEN (models: read) before giving up.
    const fallbackToken = getGithubToken()
    if (response.ok && !isJson(response) && fallbackToken && fallbackToken !== getLlmToken()) {
      log.warn('  LLM response was not JSON with LLM_TOKEN; retrying with GITHUB_TOKEN')
      response = await post(fallbackToken)
    }

    clearTimeout(timeout)
    if (!response.ok) {
      const err = await response.text()
      log.error(`  LLM API error ${response.status}: ${err.slice(0, 200)}`)
      return null
    }

    // Validate Content-Type and enforce a response size ceiling before parsing
    // HTTP-derived bytes into the mission object that will be written to disk (CWE-434).
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      // A 200 response with a non-JSON Content-Type carries no `!response.ok`
      // signal, so without the body itself there is nothing to distinguish
      // an upstream outage page from a proxy error from a provider-format
      // change (console-kb#3702, where this branch fired 5 consecutive
      // scheduled runs with only the Content-Type logged and no indication
      // of what the body actually said).
      const body = await response.text()
      log.error(
        `  LLM response has unexpected Content-Type: ${contentType.slice(0, 100)} — body: ${body.slice(0, 200)}`
      )
      return null
    }
    const MAX_LLM_RESPONSE_BYTES = 1_000_000
    const rawText = await response.text()
    if (rawText.length > MAX_LLM_RESPONSE_BYTES) {
      log.error(`  LLM response too large (${rawText.length} bytes), rejecting`)
      return null
    }
    const data = JSON.parse(rawText)
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      // Unlike every other failure branch above, an empty/missing content
      // field is returned with HTTP 200 and a well-formed JSON envelope, so
      // there is nothing else in this function that would otherwise surface
      // *why* the provider produced no content (rate-limiting, a
      // content-filter refusal, a response-schema change, etc). Log the
      // finish_reason and any top-level error the provider reported so a
      // run that fails this way leaves diagnostic evidence instead of just
      // "LLM returned null" (console-kb#3702).
      const finishReason = data.choices?.[0]?.finish_reason
      const providerError = data.error
      log.error(
        `  LLM response had no content (finish_reason: ${finishReason ?? 'unknown'}${
          providerError ? `, error: ${JSON.stringify(providerError).slice(0, 200)}` : ''
        })`
      )
      return null
    }
    return JSON.parse(content)
  } catch (err) {
    clearTimeout(timeout)
    log.error(`  LLM error: ${err.message}`)
    return null
  }
}
