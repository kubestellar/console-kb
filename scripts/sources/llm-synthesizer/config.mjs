/**
 * Backend selection and endpoint-trust configuration for the LLM synthesizer.
 *
 * Trusted-prefix allowlists for env-configurable LLM endpoints. Any URL supplied
 * via ANTHROPIC_ENDPOINT / LLM_ENDPOINT must start with one of these prefixes,
 * otherwise the module load fails fast. Uses the shared assertTrustedEndpoint()
 * gate from lib/llm-endpoint-guard.mjs (also used by mission-executor.mjs,
 * enrich-install-missions.mjs, generate-cncf-install-missions.mjs, and
 * generate-platform-missions.mjs) so the SSRF check itself has a single
 * source of truth (CWE-441, kubestellar/console-kb#3562). Prevents an
 * attacker who can influence process env (e.g. a compromised reusable
 * workflow that writes to $GITHUB_ENV) from redirecting Bearer-token traffic
 * to an attacker-controlled host.
 *
 * `LLM_ENDPOINT` here is intentionally guarded against a narrower policy
 * (`GITHUB_MODELS_POLICY`) than the generator/executor scripts' own
 * `LLM_ENDPOINT` (`LLM_ENDPOINT_POLICY`): this synthesizer only ever talks to
 * GitHub Models / Azure AI, not api.openai.com or api.githubcopilot.com
 * directly. Both policies are named exports of lib/llm-endpoint-guard.mjs so
 * scripts/__tests__/ssrf-allowlist-drift.test.mjs can pin them independently.
 *
 * Extracted from scripts/sources/llm-synthesizer.mjs (console-kb#3196).
 */
import { assertTrustedEndpoint, GITHUB_MODELS_POLICY, ANTHROPIC_POLICY } from '../../lib/llm-endpoint-guard.mjs'

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

export const GITHUB_MODELS_ENDPOINT = assertTrustedEndpoint(
  process.env.LLM_ENDPOINT || 'https://models.github.ai/inference/chat/completions',
  GITHUB_MODELS_POLICY,
  'LLM_ENDPOINT',
)
export const GITHUB_MODELS_MODEL = process.env.LLM_MODEL || 'openai/gpt-4o'

export const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10)
export const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '4096', 10)
export const LLM_MAX_RETRIES = 2

/**
 * Determine which backend to use.
 * @returns {{ backend: string, token: string, endpoint: string, model: string } | null}
 */
export function getBackendConfig() {
  // 1. Copilot API (Claude via GitHub Copilot subscription)
  const copilotToken = process.env.COPILOT_TOKEN || process.env.GITHUB_TOKEN
  if (copilotToken && process.env.USE_COPILOT !== 'false') {
    return { backend: 'copilot', token: copilotToken, endpoint: COPILOT_ENDPOINT, model: COPILOT_MODEL }
  }

  // 2. Anthropic API (direct)
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    return { backend: 'anthropic', token: anthropicKey, endpoint: ANTHROPIC_ENDPOINT, model: ANTHROPIC_MODEL }
  }

  // 3. GitHub Models (OpenAI only)
  const ghToken = process.env.LLM_TOKEN || process.env.GITHUB_TOKEN
  if (ghToken) {
    return { backend: 'github-models', token: ghToken, endpoint: GITHUB_MODELS_ENDPOINT, model: GITHUB_MODELS_MODEL }
  }

  return null
}
