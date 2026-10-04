/**
 * Shared Helm chart-repo reachability check for the mission generator
 * scripts.
 *
 * Extracted from `generate-cncf-install-missions.mjs` and
 * `generate-platform-missions.mjs` (kubestellar/console-kb#3134,
 * kubestellar/console-kb#3333). The two copies had drifted: the
 * install-missions copy used a bare `10000` inline timeout and no
 * null-guard, while the platform-missions copy added a null-guard. This
 * reconciles both onto the platform copy's behavior (the newer, safer
 * variant) with the timeout promoted to a named constant.
 *
 * `helmRepoUrl` is LLM-synthesized from mission content seeded from public,
 * unauthenticated sources (GitHub Discussions, Reddit, Stack Overflow — see
 * scripts/sources/*), so it is attacker-influenceable. Before this fix,
 * `fetch()` ran unguarded against whatever string the LLM produced, on a
 * schedule, with no human review gate — an SSRF primitive (CWE-918) that
 * could reach internal services or cloud metadata endpoints (e.g.
 * http://169.254.169.254/) from the GitHub Actions runner. `isSafeFetchUrl`
 * rejects non-http(s) schemes and loopback/private/link-local/metadata
 * hosts (including via DNS resolution, to catch rebinding).
 */

import { isSafeFetchUrl } from './url-fetch-guard.mjs'

/** Timeout for the `index.yaml` reachability probe against a Helm repo URL. */
export const HELM_REPO_INDEX_TIMEOUT_MS = 10000

/** Checks whether a Helm chart repository's index.yaml is reachable. */
export async function checkHelmRepoUrl(helmRepoUrl) {
  if (!helmRepoUrl) return false
  const url = `${helmRepoUrl}/index.yaml`
  if (!(await isSafeFetchUrl(url))) return false
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(HELM_REPO_INDEX_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}
