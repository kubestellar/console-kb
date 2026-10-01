/**
 * Install-asset fetchers for CNCF projects.
 *
 * These helpers crawl a GitHub repository (and ArtifactHub) for the knowledge
 * sources that `scripts/generate-cncf-install-missions.mjs` composes into a
 * single install mission per project: README, latest release, Helm charts,
 * Kustomize manifests, Dockerfile/compose files, operator manifests, and
 * ArtifactHub metadata.
 *
 * Extracted verbatim from scripts/generate-cncf-install-missions.mjs
 * (kubestellar/console-kb#3623) following the same thin-shim pattern used by
 * scripts/scanner.mjs → scripts/scanner/ (#3195). The generator continues to
 * re-export every helper here so existing tests and callers keep working
 * unchanged.
 */
import { githubApiResponse as githubApi } from '../lib/cncf-github-client.mjs'
import { fetchReadme, fetchRepoMeta } from '../lib/repo-context.mjs'

// ─── GitHub API helpers ──────────────────────────────────────────────
export async function fetchRawFile(owner, repo, path) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const res = await githubApi(url)
  if (!res?.ok) return null
  const data = await res.json()
  if (data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8')
  }
  return data.content || null
}

// ─── Knowledge source fetchers ───────────────────────────────────────

export async function fetchLatestRelease(owner, repo) {
  const res = await githubApi(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
  if (!res?.ok) return null
  return res.json()
}

export async function fetchHelmCharts(owner, repo) {
  const paths = ['charts/', 'chart/', 'helm/', '']
  const charts = []
  for (const p of paths) {
    const chartYaml = await fetchRawFile(owner, repo, `${p}Chart.yaml`)
    if (chartYaml) {
      const valuesYaml = await fetchRawFile(owner, repo, `${p}values.yaml`)
      charts.push({ path: p, chartYaml: chartYaml.slice(0, 3000), valuesYaml: valuesYaml?.slice(0, 3000) })
      // Also look for sub-charts
      try {
        const dirRes = await githubApi(`https://api.github.com/repos/${owner}/${repo}/contents/${p}charts`)
        if (dirRes?.ok) {
          const entries = await dirRes.json()
          for (const entry of entries.slice(0, 3)) {
            const nested = await fetchRawFile(owner, repo, `${p}${entry.name}/Chart.yaml`)
            if (nested) {
              const vals = await fetchRawFile(owner, repo, `${p}${entry.name}/values.yaml`)
              charts.push({ path: `${p}${entry.name}/`, chartYaml: nested.slice(0, 2000), valuesYaml: vals?.slice(0, 2000) })
            }
          }
        }
      } catch { /* ignore */ }
      break
    }
  }
  return charts
}

export async function fetchKustomizeManifests(owner, repo) {
  const paths = ['config/default/', 'deploy/', 'manifests/', 'kustomize/', '']
  for (const p of paths) {
    const kustomization = await fetchRawFile(owner, repo, `${p}kustomization.yaml`)
    if (kustomization) {
      // Fetch a few related manifests
      const manifests = []
      try {
        const dirRes = await githubApi(`https://api.github.com/repos/${owner}/${repo}/contents/${p}`)
        if (dirRes?.ok) {
          const entries = await dirRes.json()
          for (const f of entries.filter(e => e.name.endsWith('.yaml') && e.name !== 'kustomization.yaml').slice(0, 3)) {
            const content = await fetchRawFile(owner, repo, `${p}${f.name}`)
            if (content) manifests.push({ name: f.name, content: content.slice(0, 2000) })
          }
        }
      } catch { /* ignore */ }
      return { kustomization: kustomization.slice(0, 3000), manifests }
    }
  }
  return null
}

export async function fetchDockerImages(owner, repo) {
  const images = []
  // Try Dockerfile
  for (const path of ['Dockerfile', 'docker/Dockerfile', 'build/Dockerfile']) {
    const content = await fetchRawFile(owner, repo, path)
    if (content) {
      images.push({ path, content: content.slice(0, 2000) })
      break
    }
  }
  // Try docker-compose
  for (const path of ['docker-compose.yml', 'docker-compose.yaml']) {
    const content = await fetchRawFile(owner, repo, path)
    if (content) {
      images.push({ path, content: content.slice(0, 2000) })
      break
    }
  }
  return images
}

export async function fetchOperatorManifests(owner, repo) {
  const paths = ['deploy/operator.yaml', 'config/manager/manager.yaml', 'operator.yaml']
  for (const p of paths) {
    const content = await fetchRawFile(owner, repo, p)
    if (content) return content.slice(0, 3000)
  }
  return null
}

export async function fetchArtifactHubChart(projectName) {
  try {
    const response = await fetch(
      `https://artifacthub.io/api/v1/packages/search?kind=0&ts_query_web=${encodeURIComponent(projectName)}&limit=3`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!response.ok) return null
    const data = await response.json()
    const pkg = data.packages?.[0]
    if (!pkg) return null
    return {
      repoUrl: pkg.repository?.url,
      chartName: pkg.name,
      latestVersion: pkg.version,
    }
  } catch {
    return null
  }
}

export async function fetchArtifactHubIndexForRepo(helmRepoUrl) {
  try {
    const response = await fetch(`${helmRepoUrl}/index.yaml`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return null
    return response.text()
  } catch {
    return null
  }
}

// ─── Context builder ─────────────────────────────────────────────────

export async function gatherProjectContext(project) {
  const [owner, repo] = (project.repo || '').split('/')
  if (!owner || !repo) return {}

  const [repoMeta, readme, latestRelease, helmCharts, kustomize, dockerImages, operatorManifests] = await Promise.all([
    fetchRepoMeta(owner, repo),
    fetchReadme(owner, repo),
    fetchLatestRelease(owner, repo),
    fetchHelmCharts(owner, repo),
    fetchKustomizeManifests(owner, repo),
    fetchDockerImages(owner, repo),
    fetchOperatorManifests(owner, repo),
  ])

  return {
    repoMeta,
    readme,
    latestRelease,
    helmCharts,
    kustomize,
    dockerImages,
    operatorManifests,
  }
}
