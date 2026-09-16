/**
 * Backend selection and endpoint-trust configuration for the LLM synthesizer.
 *
 * Trusted-prefix allowlists for env-configurable LLM endpoints. Any URL supplied
 * via ANTHROPIC_ENDPOINT / LLM_ENDPOINT must start with one of these prefixes,
 * otherwise the module load fails fast. Matches the assertTrustedEndpoint()
 * pattern already used in mission-executor.mjs, enrich-install-missions.mjs,
 * generate-cncf-install-missions.mjs, and generate-platform-missions.mjs
 * (CWE-441). Prevents an attacker who can influence process env (e.g. a
 * compromised reusable workflow that writes to $GITHUB_ENV) from redirecting
 * Bearer-token traffic to an attacker-controlled host.
 *
 * Extracted from scripts/sources/llm-synthesizer.mjs (console-kb#3196).
 */

// --- Configuration ---
const COPILOT_ENDPOINT = 'https://api.enterprise.githubcopilot.com/chat/completions'
const COPILOT_MODEL = process.env.COPILOT_MODEL || 'claude-opus-4.6'

// Trusted-prefix allowlists for env-configurable LLM endpoints. Any URL supplied
// via ANTHROPIC_ENDPOINT / LLM_ENDPOINT must start with one of these prefixes,
// otherwise the module load fails fast. Matches the assertTrustedEndpoint()
// pattern already used in mission-executor.mjs, enrich-install-missions.mjs,
// generate-cncf-install-missions.mjs, and generate-platform-missions.mjs
// (CWE-441). Prevents an attacker who can influence process env (e.g. a
// compromised reusable workflow that writes to $GITHUB_ENV) from redirecting
// Bearer-token traffic to an attacker-controlled host.
const ALLOWED_ANTHROPIC_PREFIXES = ['https://api.anthropic.com/']
const ALLOWED_MODELS_PREFIXES = [
  'https://models.github.ai/',
  'https://models.inference.ai.azure.com/',
]

function assertTrustedEndpoint(name, endpoint, allowedPrefixes) {
  if (!allowedPrefixes.some(prefix => endpoint.startsWith(prefix))) {
    throw new Error(`Untrusted ${name}: ${endpoint}. Must start with one of: ${allowedPrefixes.join(', ')}`)
  }
  return endpoint
}

export const ANTHROPIC_ENDPOINT = assertTrustedEndpoint(
  'ANTHROPIC_ENDPOINT',
  process.env.ANTHROPIC_ENDPOINT || 'https://api.anthropic.com/v1/messages',
  ALLOWED_ANTHROPIC_PREFIXES,
)
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
export const ANTHROPIC_VERSION = '2023-06-01'

export const GITHUB_MODELS_ENDPOINT = assertTrustedEndpoint(
  'LLM_ENDPOINT',
  process.env.LLM_ENDPOINT || 'https://models.github.ai/inference/chat/completions',
  ALLOWED_MODELS_PREFIXES,
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
