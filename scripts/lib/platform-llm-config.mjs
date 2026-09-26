/**
 * Env-derived config shared by the platform mission generator and the
 * modules extracted from it (kubestellar/console-kb#3544).
 *
 * `scripts/platform/github-context.mjs` and `scripts/platform/synthesize.mjs`
 * were extracted from `generate-platform-missions.mjs` (console-kb#3163) but
 * kept importing their config *back* from the orchestrator — the same
 * reverse-import anti-pattern that #3528/#3529 removed from
 * `lib/cncf-github-client.mjs`. This module is the single owner of those
 * constants so the extracted libs no longer depend on their caller, and so a
 * second orchestrator can reuse them without re-exporting or duplicating the
 * SSRF guard.
 *
 * Tuning constants (endpoint / model / timeout) are read from env once, at
 * module load, and `assertTrustedEndpoint(LLM_ENDPOINT)` runs here at module
 * load (CWE-441: prevent SSRF) — importing this module is what arms the gate.
 * Tokens are read per-call via `getGithubToken()` / `getLlmToken()` so tests
 * (and callers) can mutate `process.env` after import, matching
 * `lib/cncf-github-client.mjs`.
 */
import { ALLOWED_ENDPOINT_PREFIXES, assertTrustedEndpoint } from './llm-endpoint-guard.mjs'

export { ALLOWED_ENDPOINT_PREFIXES, assertTrustedEndpoint }

export const DEFAULT_LLM_ENDPOINT = 'https://models.inference.ai.azure.com/chat/completions'
export const DEFAULT_LLM_MODEL = 'gpt-4o-mini'
export const DEFAULT_LLM_TIMEOUT_MS = 90000

export const LLM_ENDPOINT = process.env.LLM_ENDPOINT || DEFAULT_LLM_ENDPOINT
export const LLM_MODEL = process.env.LLM_MODEL || DEFAULT_LLM_MODEL
export const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || String(DEFAULT_LLM_TIMEOUT_MS), 10)

// Validate LLM_ENDPOINT at module load time (CWE-441: prevent SSRF).
// ALLOWED_ENDPOINT_PREFIXES / assertTrustedEndpoint are shared with
// generate-cncf-install-missions.mjs via ./llm-endpoint-guard.mjs
// (kubestellar/console-kb#3134, #3333).
export const TRUSTED_LLM_ENDPOINT = assertTrustedEndpoint(LLM_ENDPOINT)

/** GitHub API auth token, read per-call from process.env. */
export function getGithubToken() {
  return process.env.GITHUB_TOKEN
}

/** GitHub Models PAT (falls back to GITHUB_TOKEN), read per-call from process.env. */
export function getLlmToken() {
  return process.env.LLM_TOKEN || process.env.GITHUB_TOKEN
}
