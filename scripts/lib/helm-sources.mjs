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
 */

/** Timeout for the `index.yaml` reachability probe against a Helm repo URL. */
export const HELM_REPO_INDEX_TIMEOUT_MS = 10000

/** Checks whether a Helm chart repository's index.yaml is reachable. */
export async function checkHelmRepoUrl(helmRepoUrl) {
  if (!helmRepoUrl) return false
  try {
    const response = await fetch(`${helmRepoUrl}/index.yaml`, {
      signal: AbortSignal.timeout(HELM_REPO_INDEX_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}
