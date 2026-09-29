/**
 * GitHub context-fetching helpers for the platform mission generator.
 *
 * Extracted from generate-platform-missions.mjs (console-kb#3163) so the
 * GitHub REST fetch helpers and gatherPlatformContext() can be unit-tested
 * (with a mocked global fetch) independently of the LLM synthesis and
 * quality-gate concerns that remain in the main script.
 *
 * All requests go through the shared client in lib/cncf-github-client.mjs
 * (console-kb#3551): one process-wide rate-limit budget, one retry/backoff
 * policy, one request timeout, and one place that owns the Accept /
 * X-GitHub-Api-Version headers. This module deliberately has no private
 * rate-limit counters and no raw `fetch()` against api.github.com —
 * scripts/__tests__/github-client-drift.test.mjs enforces that.
 */
import { sleep, waitForRateLimit, githubApi } from '../lib/cncf-github-client.mjs'
import { checkHelmRepoUrl } from '../lib/helm-sources.mjs'
import {
  fetchRepoMeta,
  fetchReleases,
  fetchReadme,
  fetchHelmChart,
  fetchHelmValues,
  fetchKustomize,
} from '../lib/repo-context.mjs'

export { checkHelmRepoUrl, sleep, waitForRateLimit, githubApi }
// Repo-context primitives now live in scripts/lib/repo-context.mjs
// (kubestellar/console-kb#3575) so the CNCF-install generator can adopt
// the same helpers. Re-exported here so existing importers of this module
// (generate-platform-missions.mjs, platform-github-context.test.mjs) keep
// working unchanged.
export {
  fetchRepoMeta,
  fetchReleases,
  fetchReadme,
  fetchHelmChart,
  fetchHelmValues,
  fetchKustomize,
}

export async function gatherPlatformContext(platform) {
  const context = {
    readme: null,
    helmChart: null,
    helmValues: null,
    kustomize: null,
    releases: [],
    repoMeta: null,
  }

  const [owner, repo] = (platform.repo || '').split('/')
  if (!owner || !repo) return context

  const [repoMeta, releases, readme, helmChart, helmValues, kustomize] = await Promise.all([
    fetchRepoMeta(owner, repo),
    fetchReleases(owner, repo),
    fetchReadme(owner, repo),
    fetchHelmChart(owner, repo),
    fetchHelmValues(owner, repo),
    fetchKustomize(owner, repo),
  ])

  return { repoMeta, releases: releases.slice(0, 5), readme, helmChart, helmValues, kustomize }
}
