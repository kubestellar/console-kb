import { describe, it, expect, vi } from 'vitest'
import { runOutreachGenerator } from '../lib/outreach-helpers.mjs'

function makeMockOut() {
  const logs = []
  const errors = []
  return {
    logs,
    errors,
    out: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => errors.push(args.join(' ')),
    },
  }
}

describe('runOutreachGenerator', () => {
  const sampleProjects = [
    { name: 'argo', repo: 'argoproj/argo-cd' },
    { name: 'flux', repo: 'fluxcd/flux2' },
    { name: 'kubestellar', repo: 'kubestellar/kubestellar' },
  ]

  it('--dry-run never touches disk and writes titles/bodies to out', () => {
    const { logs, errors, out } = makeMockOut()
    const mkdirSync = vi.fn()
    const writeFileSync = vi.fn()
    const existsSync = vi.fn().mockReturnValue(true)

    const result = runOutreachGenerator({
      argv: ['--dry-run'],
      projects: sampleProjects,
      fs: { existsSync, mkdirSync, writeFileSync },
      out,
    })

    expect(result.exitCode).toBe(0)
    expect(result.summary.total).toBe(2) // argo, flux (kubestellar excluded)
    expect(result.summary.generated).toBe(2)
    expect(mkdirSync).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(errors).toHaveLength(0)

    // Logs contain dry-run banner and preview
    expect(logs.some(l => l.includes('Project: argo (argoproj/argo-cd)'))).toBe(true)
    expect(logs.some(l => l.includes('Title: 🤖 AI-Powered Install Mission for Argo'))).toBe(true)
    expect(logs.some(l => l.includes('Labels: ai-mission, community, installation'))).toBe(true)
    expect(logs.some(l => l.includes('📊 Summary: 2/2 outreach issues generated'))).toBe(true)
  })

  it('--project=<name> narrows to a single project', () => {
    const { logs, out } = makeMockOut()
    const writtenFiles = new Map()
    const createdDirs = []
    const fs = {
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: (dir, opts) => createdDirs.push({ dir, opts }),
      writeFileSync: (p, content) => writtenFiles.set(p, content),
    }

    const result = runOutreachGenerator({
      argv: ['--project=flux'],
      projects: sampleProjects,
      fs,
      out,
    })

    expect(result.exitCode).toBe(0)
    expect(result.summary.total).toBe(1)
    expect(result.summary.generated).toBe(1)
    expect(writtenFiles.size).toBe(1)
    expect(writtenFiles.has('outreach-issues/flux.md')).toBe(true)
  })

  it('--project=<unknown> logs error and returns exitCode 1', () => {
    const { errors, out } = makeMockOut()
    const mkdirSync = vi.fn()
    const writeFileSync = vi.fn()

    const result = runOutreachGenerator({
      argv: ['--project=does-not-exist'],
      projects: sampleProjects,
      fs: { existsSync: () => true, mkdirSync, writeFileSync },
      out,
    })

    expect(result.exitCode).toBe(1)
    expect(result.summary.generated).toBe(0)
    expect(errors[0]).toBe("Project 'does-not-exist' not found in CNCF projects list")
    expect(mkdirSync).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('--output=<dir> is respected and missing directory is created recursively', () => {
    const { out } = makeMockOut()
    const createdDirs = []
    const writtenFiles = new Map()
    const fs = {
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: (dir, opts) => createdDirs.push({ dir, opts }),
      writeFileSync: (p, content) => writtenFiles.set(p, content),
    }

    const result = runOutreachGenerator({
      argv: ['--project=argo', '--output=custom/outreach/dir'],
      projects: sampleProjects,
      fs,
      out,
    })

    expect(result.exitCode).toBe(0)
    expect(createdDirs).toEqual([{ dir: 'custom/outreach/dir', opts: { recursive: true } }])
    expect(writtenFiles.has('custom/outreach/dir/argo.md')).toBe(true)
  })

  it('CONSOLE_URL env overrides the default console url', () => {
    const { out } = makeMockOut()
    const writtenFiles = new Map()
    const fs = {
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: vi.fn(),
      writeFileSync: (p, content) => writtenFiles.set(p, content),
    }

    const result = runOutreachGenerator({
      argv: ['--project=argo'],
      projects: sampleProjects,
      env: { CONSOLE_URL: 'https://staging.console.example.com' },
      fs,
      out,
    })

    expect(result.exitCode).toBe(0)
    const content = writtenFiles.get('outreach-issues/argo.md')
    expect(content).toContain('https://staging.console.example.com/missions/install-argo')
    expect(content).not.toContain('https://console.kubestellar.io')
  })

  it('filters out kubestellar project unconditionally', () => {
    const { out } = makeMockOut()
    const writtenFiles = new Map()
    const fs = {
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: vi.fn(),
      writeFileSync: (p, content) => writtenFiles.set(p, content),
    }

    const result = runOutreachGenerator({
      argv: ['--project=kubestellar'],
      projects: sampleProjects,
      fs,
      out,
    })

    // kubestellar was filtered out, so searching for it reports not found
    expect(result.exitCode).toBe(1)
    expect(writtenFiles.size).toBe(0)
  })

  it('skips projects that do not have an install mission on disk', () => {
    const { logs, out } = makeMockOut()
    const writtenFiles = new Map()
    const fs = {
      existsSync: (path) => path.includes('install-argo.json'), // flux mission missing
      mkdirSync: vi.fn(),
      writeFileSync: (p, content) => writtenFiles.set(p, content),
    }

    const result = runOutreachGenerator({
      argv: [],
      projects: sampleProjects,
      fs,
      out,
    })

    expect(result.exitCode).toBe(0)
    expect(result.summary.total).toBe(1)
    expect(result.summary.generated).toBe(1)
    expect(writtenFiles.has('outreach-issues/argo.md')).toBe(true)
    expect(writtenFiles.has('outreach-issues/flux.md')).toBe(false)
    expect(logs.some(l => l.includes('Generating outreach issues for 1/2 projects with missions'))).toBe(true)
  })

  it('writes standard metadata comments header and markdown body', () => {
    const { out } = makeMockOut()
    const writtenFiles = new Map()
    const fs = {
      existsSync: () => true,
      mkdirSync: vi.fn(),
      writeFileSync: (p, content) => writtenFiles.set(p, content),
    }

    runOutreachGenerator({
      argv: ['--project=argo'],
      projects: sampleProjects,
      fs,
      out,
    })

    const file = writtenFiles.get('outreach-issues/argo.md')
    expect(file).toContain('<!-- OUTREACH ISSUE for argo -->')
    expect(file).toContain('<!-- Repo: argoproj/argo-cd -->')
    expect(file).toContain('<!-- Title: 🤖 AI-Powered Install Mission for Argo — Community Feedback Welcome -->')
    expect(file).toContain('<!-- Labels: ai-mission, community, installation -->')
    expect(file).toContain('<!-- To file: gh issue create --repo argoproj/argo-cd')
    expect(file).toContain('## 🚀 AI-Generated Install Mission for Argo')
  })
})
