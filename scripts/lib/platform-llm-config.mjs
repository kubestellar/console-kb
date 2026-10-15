/**
 * Env-derived config shared by the platform mission generator and the
 * modules extracted from it (kubestellar/console-kb#3544).
 *
 * `scripts/platform/github-context.mjs` and `scripts/platform/synthesize.mjs`
 * were extracted from `generate-platform-missions.mjs` (console-kb#3163) but
 * kept importing their config *back* from the orchestrator — the same
 * reverse-import anti-pattern that #3528/#3529 removed from
 * `lib/cncf-github-client.mjs`. This module is the single owner of those
 * constants so the extracted libs no longer depend on their caller.
 *
 * LLM endpoint / key / model are no longer parsed here: they come from the
 * shared env-configured proxy (`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`)
 * owned by ./llm-proxy-config.mjs (console-kb#3702), re-exported below so
 * platform consumers need only one import. The timeout is still read once,
 * at module load. The GitHub token is read per-call via `getGithubToken()`
 * so tests (and callers) can mutate `process.env` after import.
 */
export {
  DEFAULT_LLM_MODEL,
  LlmConfigError,
  LlmResponseError,
  getLlmProxyConfig,
  requireLlmProxyConfig,
  llmRequestHeaders,
  assertJsonResponse,
} from './llm-proxy-config.mjs'

export const DEFAULT_LLM_TIMEOUT_MS = 90000
export const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || String(DEFAULT_LLM_TIMEOUT_MS), 10)

/** GitHub API auth token, read per-call from process.env. */
export function getGithubToken() {
  return process.env.GITHUB_TOKEN
}
