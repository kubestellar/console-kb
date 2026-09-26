/**
 * Shared SSRF guard (CWE-441) for the LLM endpoint used by the mission
 * generator scripts.
 *
 * Extracted from `generate-cncf-install-missions.mjs` and
 * `generate-platform-missions.mjs` (kubestellar/console-kb#3134,
 * kubestellar/console-kb#3333), which each carried a byte-identical copy of
 * `ALLOWED_ENDPOINT_PREFIXES` + `assertTrustedEndpoint`. A single copy means
 * a future allowlist change (or security fix) only has to land once.
 *
 * `enrich-install-missions.mjs`, `lib/executor-llm.mjs`, and
 * `sources/llm-synthesizer/config.mjs` are expected to import from this
 * module to ensure all consumers share a single source of truth for
 * `LLM_ENDPOINT` validation.
 */

export const ALLOWED_ENDPOINT_PREFIXES = [
  'https://models.inference.ai.azure.com/',
  'https://api.openai.com/',
  'https://api.githubcopilot.com/',
  'https://models.github.ai/',
]

/**
 * Asserts that an LLM endpoint URL starts with an approved prefix (CWE-441: prevent SSRF).
 * Throws if the endpoint is not trusted.
 */
export function assertTrustedEndpoint(endpoint, allowedPrefixes = ALLOWED_ENDPOINT_PREFIXES) {
  if (!allowedPrefixes.some(prefix => endpoint.startsWith(prefix))) {
    throw new Error(`Untrusted LLM_ENDPOINT: ${endpoint}. Must start with one of: ${allowedPrefixes.join(', ')}`)
  }
  return endpoint
}