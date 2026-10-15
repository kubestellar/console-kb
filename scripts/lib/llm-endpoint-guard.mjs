/**
 * Shared SSRF guard (CWE-441) for fixed-host LLM endpoints.
 *
 * Originally the single allowlist for every generator/executor script's
 * `LLM_ENDPOINT` (kubestellar/console-kb#3134, #3333, #3614, #3562). Those
 * scripts now talk exclusively to the env-configured LLM proxy
 * (`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`), whose URL comes from
 * operator-controlled repo secrets and is structurally validated by
 * `lib/llm-proxy-config.mjs` (kubestellar/console-kb#3702). The GitHub
 * Models / OpenAI host allowlists that pinned the retired GitHub Models
 * endpoint were removed with it.
 *
 * What remains is the prefix gate for `sources/llm-synthesizer/config.mjs`'s
 * `ANTHROPIC_ENDPOINT`, which still targets a single fixed vendor host.
 */

// Policy for sources/llm-synthesizer/config.mjs's `ANTHROPIC_ENDPOINT`.
export const ANTHROPIC_POLICY = ['https://api.anthropic.com/']

/**
 * Asserts that an endpoint URL starts with an approved prefix (CWE-441: prevent SSRF).
 * Throws if the endpoint is not trusted. `name` only affects the error message.
 */
export function assertTrustedEndpoint(endpoint, allowedPrefixes, name = 'LLM_ENDPOINT') {
  if (!allowedPrefixes.some(prefix => endpoint.startsWith(prefix))) {
    throw new Error(`Untrusted ${name}: ${endpoint}. Must start with one of: ${allowedPrefixes.join(', ')}`)
  }
  return endpoint
}
