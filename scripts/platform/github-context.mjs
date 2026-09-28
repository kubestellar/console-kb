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

export { checkHelmRepoUrl, sleep, waitForRateLimit, githubApi }

const API = 'https://api.github.com/repos'

/**
 * Fetch a base64 `content` payload (contents API / readme endpoint) and
 * return its decoded text, or null when it is missing or the shared client
 * skipped the request.
 */
async function fetchDecodedContent(url, maxChars) {
  const data = await githubApi(url)
  if (!data || typeof data.content !== 'string') return null
  return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, maxChars)
}

async function fetchContentsFile(owner, repo, path, maxChars) {
  return fetchDecodedContent(`${API}/${owner}/${repo}/contents/${path}`, maxChars)
}

/** Try `candidateDirs` in order and return the first decoded `file` found. */
async function fetchFirstContentsFile(owner, repo, candidateDirs, file, maxChars) {
  for (const dir of candidateDirs) {
    const text = await fetchContentsFile(owner, repo, `${dir}${file}`, maxChars)
    if (text != null) return text
  }
  return null
}

const HELM_DIRS = ['charts/', 'chart/', 'helm/', '']
const KUSTOMIZE_DIRS = ['config/default/', 'deploy/', 'manifests/', '']
const README_MAX_CHARS = 8000
const HELM_FILE_MAX_CHARS = 4000
const KUSTOMIZE_MAX_CHARS = 3000

export async function fetchRepoMeta(owner, repo) {
  return githubApi(`${API}/${owner}/${repo}`)
}

export async function fetchReleases(owner, repo) {
  const releases = await githubApi(`${API}/${owner}/${repo}/releases?per_page=10`)
  return Array.isArray(releases) ? releases : []
}

export async function fetchReadme(owner, repo) {
  return fetchDecodedContent(`${API}/${owner}/${repo}/readme`, README_MAX_CHARS)
}

export async function fetchHelmChart(owner, repo) {
  return fetchFirstContentsFile(owner, repo, HELM_DIRS, 'Chart.yaml', HELM_FILE_MAX_CHARS)
}

export async function fetchHelmValues(owner, repo) {
  return fetchFirstContentsFile(owner, repo, HELM_DIRS, 'values.yaml', HELM_FILE_MAX_CHARS)
}

export async function fetchKustomize(owner, repo) {
  return fetchFirstContentsFile(owner, repo, KUSTOMIZE_DIRS, 'kustomization.yaml', KUSTOMIZE_MAX_CHARS)
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
