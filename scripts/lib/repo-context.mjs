/**
 * Shared GitHub repo-context fetcher primitives for the mission generators.
 *
 * These helpers are the layer above lib/cncf-github-client.mjs (the base
 * REST client consolidated in kubestellar/console-kb#3551): they compose
 * `githubApi` into "fetch this project's install context" primitives
 * (README, repo metadata, releases, Helm chart/values, Kustomize
 * manifests). Extracted from scripts/platform/github-context.mjs so the
 * CNCF-install generator can migrate onto the same primitives instead of
 * carrying its own drift-prone copies (kubestellar/console-kb#3575).
 *
 * All requests flow through the shared client, so this module has no
 * private rate-limit counters and no raw `fetch()` against api.github.com;
 * see scripts/__tests__/github-client-drift.test.mjs.
 */
import { githubApi } from './cncf-github-client.mjs'

const API = 'https://api.github.com/repos'

// Canonical candidate directories and character caps for install-context
// fetching. Consumers should import these constants rather than re-declare
// them so a future tuning change lands in one place.
export const HELM_DIRS = ['charts/', 'chart/', 'helm/', '']
export const KUSTOMIZE_DIRS = ['config/default/', 'deploy/', 'manifests/', 'kustomize/', '']
export const README_MAX_CHARS = 8000
export const HELM_FILE_MAX_CHARS = 4000
export const KUSTOMIZE_MAX_CHARS = 3000

/**
 * Fetch a base64 `content` payload (contents API / readme endpoint) and
 * return its decoded text, or null when it is missing or the shared client
 * skipped the request.
 */
export async function fetchDecodedContent(url, maxChars) {
  const data = await githubApi(url)
  if (!data || typeof data.content !== 'string') return null
  return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, maxChars)
}

export async function fetchContentsFile(owner, repo, path, maxChars) {
  return fetchDecodedContent(`${API}/${owner}/${repo}/contents/${path}`, maxChars)
}

/** Try `candidateDirs` in order and return the first decoded `file` found. */
export async function fetchFirstContentsFile(owner, repo, candidateDirs, file, maxChars) {
  for (const dir of candidateDirs) {
    const text = await fetchContentsFile(owner, repo, `${dir}${file}`, maxChars)
    if (text != null) return text
  }
  return null
}

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
