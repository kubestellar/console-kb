/**
 * LLM-powered mission synthesizer supporting multiple backends:
 *   1. GitHub Copilot API (Claude Opus/Sonnet) — preferred, included with Copilot subscription
 *   2. Anthropic API (direct) — if ANTHROPIC_API_KEY is set
 *   3. GitHub Models API (GPT-4o) — free fallback for GitHub Actions
 *
 * Backend selection priority:
 *   - COPILOT_TOKEN or GITHUB_TOKEN + Copilot → api.enterprise.githubcopilot.com
 *   - ANTHROPIC_API_KEY → api.anthropic.com
 *   - LLM_TOKEN/GITHUB_TOKEN → models.github.ai (OpenAI models only)
 *
 * This is the orchestration barrel: it wires together backend config
 * selection, provider HTTP clients, prompt construction, and response
 * parsing/validation from the sibling modules in this directory.
 *
 * Split out of the former monolithic scripts/sources/llm-synthesizer.mjs
 * (console-kb#3196). scripts/sources/llm-synthesizer.mjs remains as a thin
 * re-export shim so existing imports keep working unchanged.
 */

import { getBackendConfig, ANTHROPIC_ENDPOINT, ANTHROPIC_MODEL, GITHUB_MODELS_ENDPOINT, GITHUB_MODELS_MODEL, LLM_MAX_RETRIES, LLM_TIMEOUT_MS } from './config.mjs'
import { callAnthropic, callOpenAICompatible } from './providers.mjs'
import { buildPrompt } from './prompt.mjs'
import { extractJSON, validateAndClean, sleep } from './parse.mjs'

export { sleep } from './parse.mjs'

/**
 * Synthesize a high-quality mission from raw issue context.
 * @param {object} params
 * @returns {Promise<{description: string, steps: Array, resolution: string, difficulty: string, type: string} | null>}
 */
export async function synthesizeMission(params) {
  const config = getBackendConfig()
  if (!config) {
    console.warn('  [LLM] No API key found (set GITHUB_TOKEN, ANTHROPIC_API_KEY, or COPILOT_TOKEN)')
    return null
  }

  console.log(`  [LLM] Using ${config.backend} (${config.model})`)
  const prompt = buildPrompt(params)

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      let response
      if (config.backend === 'anthropic') {
        response = await callAnthropic(config, prompt)
      } else {
        // Both copilot and github-models use OpenAI-compatible format
        response = await callOpenAICompatible(config, prompt)
      }

      if (response.rateLimited) {
        const wait = response.retryAfterSec || 5
        console.warn(`  [LLM] Rate limited, waiting ${wait}s (attempt ${attempt + 1})`)
        await sleep(wait * 1000)
        continue
      }

      if (response.error) {
        console.warn(`  [LLM] API error: ${response.error} (attempt ${attempt + 1})`)
        // If Copilot fails (e.g. no subscription), fall back to next backend
        if (config.backend === 'copilot' && attempt === LLM_MAX_RETRIES) {
          console.warn('  [LLM] Copilot failed, trying fallback backends...')
          return await synthesizeWithFallback(params, prompt)
        }
        if (attempt < LLM_MAX_RETRIES) {
          await sleep(2000 * (attempt + 1))
          continue
        }
        return null
      }

      const content = response.content
      if (!content) {
        console.warn('  [LLM] Empty response')
        return null
      }

      const jsonStr = extractJSON(content)
      let parsed
      try {
        parsed = JSON.parse(jsonStr)
      } catch (parseErr) {
        const MAX_PREVIEW_LEN = 300
        console.warn(`  [LLM] JSON parse failed: ${parseErr.message}`)
        console.warn(`  [LLM] Raw content preview: ${content.slice(0, MAX_PREVIEW_LEN)}`)
        throw parseErr // re-throw to hit the retry logic
      }

      if (parsed.skip || !parsed.description || !parsed.steps?.length) {
        console.log('  [LLM] Skipped — not actionable')
        return null
      }

      const result = validateAndClean(parsed)
      if (!result) {
        console.warn('  [LLM] Failed validation (generic steps, too few steps, or no commands)')
        return null
      }

      return result
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        console.warn(`  [LLM] Timeout after ${LLM_TIMEOUT_MS}ms (attempt ${attempt + 1})`)
      } else if (err instanceof SyntaxError) {
        console.warn(`  [LLM] Invalid JSON response (attempt ${attempt + 1}): ${err.message}`)
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

/** Try fallback backends if primary (Copilot) fails */
async function synthesizeWithFallback(params, prompt) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    console.log('  [LLM] Falling back to Anthropic API')
    const config = { backend: 'anthropic', token: anthropicKey, endpoint: ANTHROPIC_ENDPOINT, model: ANTHROPIC_MODEL }
    try {
      const response = await callAnthropic(config, prompt)
      if (response.content) {
        const parsed = JSON.parse(extractJSON(response.content))
        if (!parsed.skip && parsed.description && parsed.steps?.length) {
          return validateAndClean(parsed)
        }
      }
    } catch { /* fall through */ }
  }

  const ghToken = process.env.LLM_TOKEN
  if (ghToken) {
    console.log('  [LLM] Falling back to GitHub Models')
    const config = { backend: 'github-models', token: ghToken, endpoint: GITHUB_MODELS_ENDPOINT, model: GITHUB_MODELS_MODEL }
    try {
      const response = await callOpenAICompatible(config, prompt)
      if (response.content) {
        const parsed = JSON.parse(extractJSON(response.content))
        if (!parsed.skip && parsed.description && parsed.steps?.length) {
          return validateAndClean(parsed)
        }
      }
    } catch { /* give up */ }
  }

  return null
}
