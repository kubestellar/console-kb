/**
 * LLM prompt-building and synthesis for the platform mission generator.
 *
 * Extracted from generate-platform-missions.mjs (console-kb#3163). The
 * LLM proxy endpoint / key / model come from the env-configured proxy
 * (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL) via ../lib/platform-llm-config.mjs,
 * which re-exports ../lib/llm-proxy-config.mjs (console-kb#3544, #3702).
 * This module must not import from the orchestrator that calls it.
 */
import { slugify } from '../lib/mission-file.mjs'
import {
  getLlmProxyConfig,
  llmRequestHeaders,
  assertJsonResponse,
  LlmResponseError,
  LLM_TIMEOUT_MS,
} from '../lib/platform-llm-config.mjs'
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

/**
 * Synthesizes one platform mission through the env-configured LLM proxy.
 *
 * Returns null for per-platform failures (HTTP error, timeout, oversize or
 * empty response). Throws — so the run exits non-zero instead of skipping
 * every platform — when the proxy env is unset (`LlmConfigError`) or the
 * proxy answers with a non-JSON body (`LlmResponseError`), since both are
 * fleet-wide misconfigurations, not per-platform flakes (console-kb#3702).
 */
export async function synthesizePlatformMission(platform, context) {
  const { endpoint, apiKey, model } = getLlmProxyConfig()
  const prompt = buildPlatformPrompt(platform, context)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: llmRequestHeaders(apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: PLATFORM_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
      }),
    })

    clearTimeout(timeout)
    if (!response.ok) {
      const err = await response.text()
      log.error(`  LLM API error ${response.status}: ${err.slice(0, 200)}`)
      return null
    }

    // Validate Content-Type before parsing HTTP-derived bytes into the
    // mission object that will be written to disk (CWE-434). A 200 response
    // with a non-JSON Content-Type carries no `!response.ok` signal, so the
    // error carries a body snippet to distinguish an upstream outage page
    // from a proxy error from a retired endpoint (console-kb#3702, #3709).
    try {
      await assertJsonResponse(response)
    } catch (err) {
      log.error(`  ${err.message}`, { status: err.status ?? null, contentType: err.contentType ?? null })
      throw err
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
    if (err instanceof LlmResponseError) throw err
    log.error(`  LLM error: ${err.message}`)
    return null
  }
}
