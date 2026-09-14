import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadMission,
  checkMissionQuality,
  extractHelmRepos,
  extractContainerImages,
  extractUrls,
  runContentValidation,
} from '../mission-content-validation.mjs'

describe('mission-content-validation.mjs checkMissionQuality (CI observability)', () => {
  it('flags a step with no code blocks as a skeleton step error', () => {
    const mission = { mission: { steps: [{ title: 'Install', description: 'Do the thing manually.' }] } }
    const { errors } = checkMissionQuality(mission)
    expect(errors).toContain('Step 0 ("Install") has no code blocks — skeleton step')
  })

  it('does not flag a step that contains a code block', () => {
    const mission = { mission: { steps: [{ title: 'Install', description: 'Run:\n```\nhelm install foo bar\n```' }] } }
    const { errors } = checkMissionQuality(mission)
    expect(errors).toEqual([])
  })

  it('flags kubectl edit deployment used as the only command', () => {
    const mission = { mission: { steps: [{ title: 'Fix', description: '```\nkubectl edit deployment foo\n```' }] } }
    const { errors } = checkMissionQuality(mission)
    expect(errors).toContain('Step 0 ("Fix") contains only kubectl edit deployment placeholder')
  })

  it('does not flag kubectl edit deployment when another real command is present', () => {
    const mission = {
      mission: {
        steps: [{ title: 'Fix', description: '```\nkubectl edit deployment foo\nkubectl apply -f patched.yaml\n```' }],
      },
    }
    const { errors } = checkMissionQuality(mission)
    expect(errors).not.toContain('Step 0 ("Fix") contains only kubectl edit deployment placeholder')
  })

  it('warns on kubectl apply -f with a local file not provided inline', () => {
    const mission = { mission: { steps: [{ title: 'Apply', description: '```\nkubectl apply -f patch.yaml\n```' }] } }
    const { warnings } = checkMissionQuality(mission)
    expect(warnings).toContain('Step 0: kubectl apply -f patch.yaml — local file not provided inline')
  })

  it('does not warn on kubectl apply -f with an http(s) URL target', () => {
    const mission = {
      mission: { steps: [{ title: 'Apply', description: '```\nkubectl apply -f https://example.com/x.yaml\n```' }] },
    }
    const { warnings } = checkMissionQuality(mission)
    expect(warnings).toEqual([])
  })

  it('does not warn on kubectl apply -f - with heredoc content inline', () => {
    const mission = {
      mission: {
        steps: [
          {
            title: 'Apply',
            description: '```\nkubectl apply -f - <<EOF\napiVersion: v1\nEOF\n```',
          },
        ],
      },
    }
    const { warnings } = checkMissionQuality(mission)
    expect(warnings).toEqual([])
  })

  it('returns no findings for a mission with no steps', () => {
    const { errors, warnings } = checkMissionQuality({ mission: {} })
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe('mission-content-validation.mjs extractHelmRepos (CI observability)', () => {
  it('extracts a non-oci helm repo add URL', () => {
    const mission = { mission: { steps: [{ description: '```\nhelm repo add bitnami https://charts.bitnami.com/bitnami\n```' }] } }
    expect(extractHelmRepos(mission)).toContain('https://charts.bitnami.com/bitnami')
  })

  it('skips oci:// helm repo add URLs', () => {
    const mission = { mission: { steps: [{ description: '```\nhelm repo add foo oci://registry.example.com/foo\n```' }] } }
    expect(extractHelmRepos(mission)).toEqual([])
  })

  it('extracts a non-oci metadata.helmRepoUrl field', () => {
    const mission = { metadata: { helmRepoUrl: 'https://charts.example.com' } }
    expect(extractHelmRepos(mission)).toContain('https://charts.example.com')
  })

  it('skips an oci:// metadata.helmRepoUrl field', () => {
    const mission = { metadata: { helmRepoUrl: 'oci://registry.example.com/foo' } }
    expect(extractHelmRepos(mission)).toEqual([])
  })
})

describe('mission-content-validation.mjs extractContainerImages (CI observability)', () => {
  it('extracts a real container image', () => {
    const mission = { metadata: { containerImages: ['ghcr.io/example/app:v1.0.0'] } }
    expect(extractContainerImages(mission)).toEqual(['ghcr.io/example/app:v1.0.0'])
  })

  it('skips the registry/org placeholder image', () => {
    const mission = { metadata: { containerImages: ['registry/org/image:tag'] } }
    expect(extractContainerImages(mission)).toEqual([])
  })

  it('skips the your-docker-registry placeholder image', () => {
    const mission = { metadata: { containerImages: ['your-docker-registry/image:tag'] } }
    expect(extractContainerImages(mission)).toEqual([])
  })

  it('returns an empty array when no containerImages field is present', () => {
    expect(extractContainerImages({ metadata: {} })).toEqual([])
  })
})

describe('mission-content-validation.mjs extractUrls (CI observability)', () => {
  it('skips known-good documentation domains', () => {
    const mission = { metadata: { note: 'See https://kubernetes.io/docs/concepts and https://github.com/kubestellar/console' } }
    expect(extractUrls(mission)).toEqual([])
  })

  it('includes a raw.githubusercontent.com URL even though github.com is a known host', () => {
    const mission = { metadata: { note: 'https://raw.githubusercontent.com/org/repo/main/file.yaml' } }
    expect(extractUrls(mission)).toContain('https://raw.githubusercontent.com/org/repo/main/file.yaml')
  })

  it('includes a non-standard custom domain URL', () => {
    const mission = { metadata: { note: 'https://custom-domain.example.com/thing' } }
    expect(extractUrls(mission)).toContain('https://custom-domain.example.com/thing')
  })

  it('caps results at MAX_URLS_PER_FILE (10)', () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://custom-${i}.example.com`).join(' ')
    const mission = { metadata: { note: urls } }
    expect(extractUrls(mission).length).toBe(10)
  })
})

describe('mission-content-validation.mjs runContentValidation (CI observability)', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mission-content-validation-test-'))
    mkdirSync(join(dir, 'fixes', 'cncf-install'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('flags a skeleton install-mission step as an error via the full pipeline', () => {
    const filePath = join(dir, 'fixes', 'cncf-install', 'install-foo.json')
    writeFileSync(filePath, JSON.stringify({ mission: { steps: [{ title: 'Install', description: 'no code here' }] } }))

    const result = runContentValidation([filePath], [filePath], { checkUrl: () => '200', checkImage: () => true })
    expect(result.filesValidated).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.findings[0].message).toContain('skeleton step')
  })

  it('does not run step-quality checks on files outside installFiles', () => {
    const filePath = join(dir, 'fixes', 'other.json')
    writeFileSync(filePath, JSON.stringify({ mission: { steps: [{ title: 'X', description: 'no code' }] } }))

    const result = runContentValidation([filePath], [], { checkUrl: () => '200', checkImage: () => true })
    expect(result.errors).toBe(0)
  })

  it('flags an unreachable helm repo as an error using the injected checkUrl', () => {
    const filePath = join(dir, 'fixes', 'repo.json')
    writeFileSync(
      filePath,
      JSON.stringify({ metadata: { helmRepoUrl: 'https://dead-repo.example.com' }, mission: { steps: [] } })
    )

    const result = runContentValidation([filePath], [], { checkUrl: () => '000', checkImage: () => true })
    expect(result.errors).toBe(1)
    expect(result.findings[0].message).toContain('Helm repo URL unreachable or invalid')
  })

  it('flags a missing container image as a warning using the injected checkImage', () => {
    const filePath = join(dir, 'fixes', 'image.json')
    writeFileSync(
      filePath,
      JSON.stringify({ metadata: { containerImages: ['ghcr.io/example/app:v1'] }, mission: { steps: [] } })
    )

    const result = runContentValidation([filePath], [], { checkUrl: () => '200', checkImage: () => false })
    expect(result.warnings).toBe(1)
    expect(result.findings[0].message).toContain('Container image not found in registry')
  })

  it('flags an unreachable non-standard URL as a warning', () => {
    const filePath = join(dir, 'fixes', 'urlcheck.json')
    writeFileSync(filePath, JSON.stringify({ metadata: { note: 'https://custom.example.com/x' }, mission: { steps: [] } }))

    const result = runContentValidation([filePath], [], { checkUrl: () => '404', checkImage: () => true })
    expect(result.warnings).toBe(1)
    expect(result.findings[0].message).toContain('URL unreachable or 404')
  })

  it('skips a file that cannot be read or parsed', () => {
    const result = runContentValidation([join(dir, 'does-not-exist.json')], [], {
      checkUrl: () => '200',
      checkImage: () => true,
    })
    expect(result.filesValidated).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.warnings).toBe(0)
  })

  it('aggregates a clean pass across multiple files with zero errors/warnings', () => {
    const f1 = join(dir, 'fixes', 'clean1.json')
    const f2 = join(dir, 'fixes', 'clean2.json')
    writeFileSync(f1, JSON.stringify({ mission: { steps: [] } }))
    writeFileSync(f2, JSON.stringify({ mission: { steps: [] } }))

    const result = runContentValidation([f1, f2], [], { checkUrl: () => '200', checkImage: () => true })
    expect(result.filesValidated).toBe(2)
    expect(result.errors).toBe(0)
    expect(result.warnings).toBe(0)
  })
})

describe('mission-content-validation.mjs loadMission (CI observability)', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mission-content-validation-load-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads a JSON mission file', () => {
    const filePath = join(dir, 'm.json')
    writeFileSync(filePath, JSON.stringify({ metadata: { helmRepoUrl: 'https://example.com' } }))
    expect(loadMission(filePath).metadata.helmRepoUrl).toBe('https://example.com')
  })

  it('loads a YAML mission file', () => {
    const filePath = join(dir, 'm.yaml')
    writeFileSync(filePath, 'metadata:\n  helmRepoUrl: https://example.com\n')
    expect(loadMission(filePath).metadata.helmRepoUrl).toBe('https://example.com')
  })
})
