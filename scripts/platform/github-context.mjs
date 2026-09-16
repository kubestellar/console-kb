/**
 * GitHub context-fetching helpers for the platform mission generator.
 *
 * Extracted from generate-platform-missions.mjs (console-kb#3163) so the
 * GitHub REST fetch helpers and gatherPlatformContext() can be unit-tested
 * (with a mocked global fetch) independently of the LLM synthesis and
 * quality-gate concerns that remain in the main script.
 *
 * GITHUB_TOKEN and the rate-limit state are imported from the main
 * orchestrator module so there is a single source of truth for the token
 * and a single shared rate-limit budget across the generator run.
 */
import { GITHUB_TOKEN } from '../generate-platform-missions.mjs'
import { checkHelmRepoUrl } from '../lib/helm-sources.mjs'

export { checkHelmRepoUrl }

let rateLimitRemaining = 5000
let rateLimitReset = 0

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForRateLimit() {
  if (rateLimitRemaining < 10) {
    const waitMs = Math.max(0, (rateLimitReset * 1000) - Date.now()) + 1000
    console.log(`  Rate limit low (${rateLimitRemaining}), waiting ${Math.round(waitMs / 1000)}s...`)
    await sleep(waitMs)
  }
}

export async function githubFetch(url, options = {}) {
  await waitForRateLimit()
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })
  rateLimitRemaining = parseInt(response.headers.get('x-ratelimit-remaining') || '5000', 10)
  rateLimitReset = parseInt(response.headers.get('x-ratelimit-reset') || '0', 10)
  return response
}

export async function fetchRepoMeta(owner, repo) {
  const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`)
  if (!res.ok) return null
  return res.json()
}

export async function fetchReleases(owner, repo) {
  const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchReadme(owner, repo) {
  const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/readme`)
  if (!res.ok) return null
  const data = await res.json()
  return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 8000)
}

export async function fetchHelmChart(owner, repo) {
  const paths = ['charts/', 'chart/', 'helm/', '']
  for (const p of paths) {
    const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}Chart.yaml`)
    if (res.ok) {
      const data = await res.json()
      return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 4000)
    }
  }
  return null
}

export async function fetchHelmValues(owner, repo) {
  const paths = ['charts/', 'chart/', 'helm/', '']
  for (const p of paths) {
    const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}values.yaml`)
    if (res.ok) {
      const data = await res.json()
      return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 4000)
    }
  }
  return null
}

export async function fetchKustomize(owner, repo) {
  for (const p of ['config/default/', 'deploy/', 'manifests/', '']) {
    const res = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}kustomization.yaml`)
    if (res.ok) {
      const data = await res.json()
      return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 3000)
    }
  }
  return null
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
