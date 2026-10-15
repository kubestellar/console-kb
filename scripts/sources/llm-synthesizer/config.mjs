/**
 * Backend selection and endpoint-trust configuration for the LLM synthesizer.
 *
 * Any URL supplied via ANTHROPIC_ENDPOINT must start with an ANTHROPIC_POLICY
 * prefix, otherwise the module load fails fast (shared assertTrustedEndpoint()
 * gate from lib/llm-endpoint-guard.mjs, CWE-441, kubestellar/console-kb#3562).
 * Prevents an attacker who can influence process env (e.g. a compromised
 * reusable workflow that writes to $GITHUB_ENV) from redirecting API-key
 * traffic to an attacker-controlled host.
 *
 * The OpenAI-compatible backend is the env-configured LLM proxy
 * (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL) owned and validated by
 * lib/llm-proxy-config.mjs (console-kb#3702) — the same proxy every other
 * mission script uses. The retired GitHub Models backend was removed.
 *
 * Extracted from scripts/sources/llm-synthesizer.mjs (console-kb#3196).
 */
import { assertTrustedEndpoint, ANTHROPIC_POLICY } from '../../lib/llm-endpoint-guard.mjs'
import { getLlmProxyConfig } from '../../lib/llm-proxy-config.mjs'

// --- Configuration ---
const COPILOT_ENDPOINT = 'https://api.enterprise.githubcopilot.com/chat/completions'
const COPILOT_MODEL = process.env.COPILOT_MODEL || 'claude-opus-4.6'

export const ANTHROPIC_ENDPOINT = assertTrustedEndpoint(
  process.env.ANTHROPIC_ENDPOINT || 'https://api.anthropic.com/v1/messages',
  ANTHROPIC_POLICY,
  'ANTHROPIC_ENDPOINT',
)
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
export const ANTHROPIC_VERSION = '2023-06-01'

export const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10)
export const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '4096', 10)
export const LLM_MAX_RETRIES = 2

/**
 * Proxy backend config, or null when LLM_BASE_URL and LLM_API_KEY are both
 * unset. A partial/invalid proxy config throws LlmConfigError rather than
 * silently falling through to another backend (console-kb#3702).
 */
export function getProxyBackendConfig(env = process.env) {
  if (!env.LLM_BASE_URL && !env.LLM_API_KEY) return null
  const { endpoint, apiKey, model } = getLlmProxyConfig(env)
  return { backend: 'proxy', token: apiKey, endpoint, model }
}

/**
 * Determine which backend to use.
 * @returns {{ backend: string, token: string, endpoint: string, model: string } | null}
 */
export function getBackendConfig() {
  // 1. Env-configured LLM proxy (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL)
  const proxy = getProxyBackendConfig()
  if (proxy) return proxy

  // 2. Copilot API (Claude via GitHub Copilot subscription)
  const copilotToken = process.env.COPILOT_TOKEN || process.env.GITHUB_TOKEN
  if (copilotToken && process.env.USE_COPILOT !== 'false') {
    return { backend: 'copilot', token: copilotToken, endpoint: COPILOT_ENDPOINT, model: COPILOT_MODEL }
  }

  // 3. Anthropic API (direct)
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    return { backend: 'anthropic', token: anthropicKey, endpoint: ANTHROPIC_ENDPOINT, model: ANTHROPIC_MODEL }
  }

  return null
}
