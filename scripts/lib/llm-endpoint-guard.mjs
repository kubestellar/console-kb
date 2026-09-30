/**
 * Shared SSRF guard (CWE-441) for LLM endpoints used across the mission
 * generator/executor scripts and the llm-synthesizer.
 *
 * Extracted from `generate-cncf-install-missions.mjs` and
 * `generate-platform-missions.mjs` (kubestellar/console-kb#3134,
 * kubestellar/console-kb#3333), which each carried a byte-identical copy of
 * `ALLOWED_ENDPOINT_PREFIXES` + `assertTrustedEndpoint`. A single copy means
 * a future allowlist change (or security fix) only has to land once.
 *
 * `enrich-install-missions.mjs` and `lib/executor-llm.mjs` were consolidated
 * onto this shared copy as well (kubestellar/console-kb#3614) so there is a
 * single declaration site; each of those files still runs the module-load
 * SSRF gate on its own `LLM_ENDPOINT` via the imported `assertTrustedEndpoint`.
 *
 * `sources/llm-synthesizer/config.mjs` guards two *different* env vars
 * (`LLM_ENDPOINT`, `ANTHROPIC_ENDPOINT`) against two different, narrower
 * allowlists (`GITHUB_MODELS_POLICY`, `ANTHROPIC_POLICY` below). Those
 * policies are named and owned here so the drift-detection test can pin
 * them too, instead of `config.mjs` re-declaring its own copy of the gate
 * function (kubestellar/console-kb#3562).
 */

// Policy for the generator/executor scripts' `LLM_ENDPOINT` (OpenAI-family
// backends: GitHub Models, Azure AI, OpenAI, GitHub Copilot). Every consumer
// imports this array by name (scripts/__tests__/ssrf-allowlist-drift.test.mjs).
export const ALLOWED_ENDPOINT_PREFIXES = [
  'https://models.github.ai/',
  'https://models.inference.ai.azure.com/',
  'https://api.openai.com/',
  'https://api.githubcopilot.com/',
]

// Policy for sources/llm-synthesizer/config.mjs's `LLM_ENDPOINT` (GitHub
// Models only — this synthesizer does not talk to api.openai.com or
// api.githubcopilot.com directly).
export const GITHUB_MODELS_POLICY = [
  'https://models.github.ai/',
  'https://models.inference.ai.azure.com/',
]

// Policy for sources/llm-synthesizer/config.mjs's `ANTHROPIC_ENDPOINT`.
export const ANTHROPIC_POLICY = ['https://api.anthropic.com/']

/**
 * Asserts that an LLM endpoint URL starts with an approved prefix (CWE-441: prevent SSRF).
 * Throws if the endpoint is not trusted.
 *
 * `name` only affects the error message (defaults to `LLM_ENDPOINT`, the env
 * var every current declaration site guards); pass an explicit name when
 * guarding a different env var (e.g. `ANTHROPIC_ENDPOINT`).
 */
export function assertTrustedEndpoint(endpoint, allowedPrefixes = ALLOWED_ENDPOINT_PREFIXES, name = 'LLM_ENDPOINT') {
  if (!allowedPrefixes.some(prefix => endpoint.startsWith(prefix))) {
    throw new Error(`Untrusted ${name}: ${endpoint}. Must start with one of: ${allowedPrefixes.join(', ')}`)
  }
  return endpoint
}
