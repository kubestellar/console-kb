/**
 * generate-cncf-outreach-issues.cli.test.mjs
 *
 * End-to-end tests for `scripts/generate-cncf-outreach-issues.mjs`, the CLI
 * that materialises per-project outreach issue bodies for CNCF projects that
 * already have a matching install mission JSON on disk.
 *
 * The script is a top-level-side-effecting module (reads process.argv, walks
 * `fixes/cncf-install/`, writes files to disk, calls process.exit), so it
 * can't be unit-tested by import. Instead we spawn it as a subprocess with a
 * disposable output directory and assert on stdout / files / exit code.
 *
 * Previously nothing in `__tests__/` covered this file; a template regression
 * that inverted the `--project=` filter, dropped the exit-1 semantic on an
 * unknown project name, silently stopped writing the label/repo metadata
 * comment, or removed the `--dry-run` branch would land past CI unnoticed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'generate-cncf-outreach-issues.mjs')
const REPO_ROOT = resolve(__dirname, '..', '..')
const FIXES_DIR = join(REPO_ROOT, 'fixes', 'cncf-install')

function runScript(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-outreach-cli-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Pick a project that has BOTH an entry in CNCF_PROJECTS and a mission file on
// disk, so the "happy path" tests do not depend on the specific slug used for
// the argo/istio/prometheus etc. — we discover it dynamically.
async function pickProjectsWithMissions() {
  const { CNCF_PROJECTS } = await import('../cncf-projects.mjs')
  const { slugify } = await import('../lib/outreach-helpers.mjs')
  const withMission = []
  for (const p of CNCF_PROJECTS) {
    if (p.name === 'kubestellar') continue
    const missionPath = join(FIXES_DIR, `install-${slugify(p.name)}.json`)
    if (existsSync(missionPath)) withMission.push(p)
  }
  return withMission
}

describe('generate-cncf-outreach-issues.mjs CLI', () => {
  let projectsWithMissions
  let sampleProject

  beforeEach(async () => {
    projectsWithMissions = await pickProjectsWithMissions()
    sampleProject = projectsWithMissions[0]
  })

  it('exits 0 and reports the projects-with-missions ratio', () => {
    withTempDir(dir => {
      const outputDir = join(dir, 'out')
      const result = runScript(dir, [`--output=${outputDir}`])
      expect(result.status).toBe(0)
      // "Generating outreach issues for N/M projects with missions"
      expect(result.stdout).toMatch(/Generating outreach issues for \d+\/\d+ projects with missions/)
      // Non-dry-run creates the output directory
      expect(existsSync(outputDir)).toBe(true)
    })
  })

  it('writes one .md file per project with an install mission and skips kubestellar', () => {
    withTempDir(dir => {
      const outputDir = join(dir, 'out')
      const result = runScript(dir, [`--output=${outputDir}`])
      expect(result.status).toBe(0)

      const files = readdirSync(outputDir)
      // Every generated file should have a corresponding project-with-mission
      // and vice versa — the script writes one .md per project-with-mission.
      expect(files.length).toBe(projectsWithMissions.length)
      // kubestellar is filtered out explicitly and must never receive a file.
      expect(files).not.toContain('kubestellar.md')

      // Each file must open with the standard OUTREACH ISSUE metadata header.
      const first = readFileSync(join(outputDir, files[0]), 'utf8')
      expect(first.startsWith('<!-- OUTREACH ISSUE for ')).toBe(true)
      expect(first).toContain('<!-- Repo: ')
      expect(first).toContain('<!-- Title: ')
      expect(first).toContain('<!-- Labels: ')
      expect(first).toContain('<!-- To file: gh issue create --repo ')
    })
  })

  it('writes exactly one file when --project=<name> is given', () => {
    withTempDir(dir => {
      const outputDir = join(dir, 'out')
      const result = runScript(dir, [
        `--project=${sampleProject.name}`,
        `--output=${outputDir}`,
      ])
      expect(result.status).toBe(0)
      const files = readdirSync(outputDir)
      expect(files.length).toBe(1)
      const body = readFileSync(join(outputDir, files[0]), 'utf8')
      expect(body).toContain(`<!-- OUTREACH ISSUE for ${sampleProject.name} -->`)
      expect(body).toContain(`<!-- Repo: ${sampleProject.repo} -->`)
    })
  })

  it('exits 1 and prints an error when --project=<unknown> is given', () => {
    withTempDir(dir => {
      const result = runScript(dir, ['--project=this-project-does-not-exist-xyzzy'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Project 'this-project-does-not-exist-xyzzy' not found")
    })
  })

  it('--dry-run prints per-project banners and does NOT create the output directory', () => {
    withTempDir(dir => {
      const outputDir = join(dir, 'out')
      const result = runScript(dir, [
        `--project=${sampleProject.name}`,
        '--dry-run',
        `--output=${outputDir}`,
      ])
      expect(result.status).toBe(0)
      // Dry-run banner formatting: "Project: <name> (<repo>)"
      expect(result.stdout).toContain(`Project: ${sampleProject.name} (${sampleProject.repo})`)
      expect(result.stdout).toContain('Title:')
      expect(result.stdout).toContain('Labels:')
      // The horizontal rule line and body preview are emitted.
      expect(result.stdout).toMatch(/═{60}/)
      expect(result.stdout).toMatch(/─{60}/)
      // Dry-run must NOT touch the filesystem.
      expect(existsSync(outputDir)).toBe(false)
    })
  })

  it('summary line reports generated == total when every filtered project has a mission', () => {
    withTempDir(dir => {
      const outputDir = join(dir, 'out')
      const result = runScript(dir, [
        `--project=${sampleProject.name}`,
        `--output=${outputDir}`,
      ])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/📊 Summary: 1\/1 outreach issues generated/)
      expect(result.stdout).toContain(`📁 Output: ${outputDir}/`)
      expect(result.stdout).toContain('To file an issue for a specific project:')
    })
  })

  it('honours the default output directory (outreach-issues/) when --output is not given', () => {
    withTempDir(dir => {
      const result = runScript(dir, [`--project=${sampleProject.name}`])
      expect(result.status).toBe(0)
      // Default outputDir is 'outreach-issues' relative to cwd.
      const defaultOut = join(dir, 'outreach-issues')
      expect(existsSync(defaultOut)).toBe(true)
      const files = readdirSync(defaultOut)
      expect(files.length).toBe(1)
    })
  })
})
