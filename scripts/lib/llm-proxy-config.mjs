/**
 * Single owner of the OpenAI-compatible LLM proxy configuration used by every
 * mission-generation / enrichment / execution script (kubestellar/console-kb#3702).
 *
 * The scripts used to hard-code the GitHub Models inference endpoint as
 * their default. GitHub Models was retired on 2026-07-30, after
 * which every call got a 200 `text/plain` "OK" body and the generators
 * silently produced nothing on every scheduled run. All LLM traffic now goes
 * through the same LiteLLM-style proxy the hive agents use, configured
 * exclusively via env (repo secrets/vars in CI):
 *
 *   LLM_BASE_URL  — proxy base URL, e.g. https://llm-proxy.example.com/v1
 *                   (`/chat/completions` is appended unless already present)
 *   LLM_API_KEY   — proxy API key (sent as `Authorization: Bearer <key>`)
 *   LLM_MODEL     — model name (defaults to DEFAULT_LLM_MODEL)
 *
 * There is deliberately no default endpoint and no fallback token: if the
 * env is unset `getLlmProxyConfig()` throws `LlmConfigError`, and callers
 * exit non-zero (`requireLlmProxyConfig`) instead of silently skipping.
 *
 * Env is read per-call (not at module load) so importing a consumer never
 * throws and tests can mutate `process.env` after import, matching
 * `lib/cncf-github-client.mjs`. The endpoint comes from operator-controlled
 * repo secrets, so instead of a fixed host allowlist it is structurally
 * validated (CWE-441/918): https only (http allowed for loopback only), no
 * embedded credentials, no query/fragment.
 */

export const DEFAULT_LLM_MODEL = 'gpt-4o-mini'
export const CHAT_COMPLETIONS_PATH = '/chat/completions'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const BODY_SNIPPET_LEN = 200

export class LlmConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LlmConfigError'
  }
}

export class LlmResponseError extends Error {
  constructor(message, { status, contentType, bodySnippet } = {}) {
    super(message)
    this.name = 'LlmResponseError'
    this.status = status
    this.contentType = contentType
    this.bodySnippet = bodySnippet
  }
}

/** Builds the chat-completions URL from LLM_BASE_URL, validating it structurally. */
export function chatCompletionsEndpoint(baseUrl) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new LlmConfigError(`LLM_BASE_URL is not a valid URL: ${String(baseUrl).slice(0, 100)}`)
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new LlmConfigError(`LLM_BASE_URL must use https:// (got ${url.protocol}//${url.host})`)
  }
  if (url.username || url.password) {
    throw new LlmConfigError('LLM_BASE_URL must not embed credentials; use LLM_API_KEY')
  }
  if (url.search || url.hash) {
    throw new LlmConfigError('LLM_BASE_URL must not contain a query string or fragment')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith(CHAT_COMPLETIONS_PATH) ? path : `${path}${CHAT_COMPLETIONS_PATH}`
  return url.toString()
}

/** Model name from LLM_MODEL, or DEFAULT_LLM_MODEL. Never throws (for reports/logs). */
export function getLlmModel(env = process.env) {
  return (env.LLM_MODEL || '').trim() || DEFAULT_LLM_MODEL
}

/**
 * Reads and validates LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
 * @returns {{ baseUrl: string, endpoint: string, apiKey: string, model: string }}
 * @throws {LlmConfigError} when LLM_BASE_URL or LLM_API_KEY is unset/invalid.
 */
export function getLlmProxyConfig(env = process.env) {
  const baseUrl = (env.LLM_BASE_URL || '').trim()
  const apiKey = (env.LLM_API_KEY || '').trim()
  const missing = []
  if (!baseUrl) missing.push('LLM_BASE_URL')
  if (!apiKey) missing.push('LLM_API_KEY')
  if (missing.length) {
    throw new LlmConfigError(
      `LLM proxy is not configured: ${missing.join(', ')} unset ` +
        '(set LLM_BASE_URL, LLM_API_KEY and optionally LLM_MODEL; see scripts/lib/llm-proxy-config.mjs)'
    )
  }
  const endpoint = chatCompletionsEndpoint(baseUrl)
  const model = getLlmModel(env)
  return { baseUrl, endpoint, apiKey, model }
}

/**
 * Like getLlmProxyConfig(), but on a config error emits a structured error
 * log line and exits the process non-zero. For use at the top of a CLI
 * `main()` so a misconfigured run fails loudly before doing any work.
 */
export function requireLlmProxyConfig(log, env = process.env) {
  try {
    return getLlmProxyConfig(env)
  } catch (err) {
    log.error('LLM proxy configuration invalid', {
      error: err.message,
      llmBaseUrlSet: Boolean(env.LLM_BASE_URL),
      llmApiKeySet: Boolean(env.LLM_API_KEY),
    })
    process.exit(1)
  }
}

/** Authorization + JSON headers for a proxy chat-completions request. */
export function llmRequestHeaders(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
}

/** True when the response advertises an application/json body. */
export function isJsonResponse(response) {
  return (response.headers?.get?.('content-type') || '').toLowerCase().includes('application/json')
}

/**
 * Throws LlmResponseError if `response` is not `application/json`. The
 * thrown error (and its message) carries a bounded body snippet, preserving
 * the diagnostic evidence added in #3703/#3709: a 200 non-JSON body carries
 * no `!response.ok` signal, so without it an upstream outage page, a proxy
 * error and a retired endpoint ("OK") are indistinguishable.
 */
export async function assertJsonResponse(response) {
  if (isJsonResponse(response)) return
  const contentType = (response.headers?.get?.('content-type') || '').slice(0, 100)
  let bodySnippet = ''
  try {
    bodySnippet = String(await response.text()).slice(0, BODY_SNIPPET_LEN)
  } catch {
    // body unreadable — the Content-Type alone is still reported
  }
  throw new LlmResponseError(
    `LLM response has unexpected Content-Type: ${contentType || '(none)'} — body: ${bodySnippet}`,
    { status: response.status, contentType, bodySnippet }
  )
}
