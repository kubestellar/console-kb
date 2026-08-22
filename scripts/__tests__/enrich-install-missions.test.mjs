import { describe, it, expect } from 'vitest'
import {
  sanitizeMissionForHTTP,
  validateSection,
  sanitizeSteps,
} from '../enrich-install-missions.mjs'

// ─── sanitizeMissionForHTTP ─────────────────────────────────────────
// Security-critical: this function redacts URLs, emails, and secret-like
// patterns from file-derived mission content BEFORE it is sent to an LLM
// endpoint over HTTP (CWE-441 file-access-to-http). It also clamps string
// lengths and filters metadata arrays to a strict allowlist.

describe('sanitizeMissionForHTTP', () => {
  describe('URL redaction', () => {
    it('redacts http:// URLs from step descriptions', () => {
      const m = {
        mission: {
          title: 'x',
          description: 'x',
          steps: [{ title: 't', description: 'See http://evil.com/exfil for details' }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).toBe('See [redacted-url] for details')
    })

    it('redacts https:// URLs from step descriptions', () => {
      const m = {
        mission: {
          steps: [{ title: 't', description: 'Visit https://internal.corp.example/api/keys' }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).toContain('[redacted-url]')
      expect(out.mission.steps[0].description).not.toContain('internal.corp.example')
    })

    it('redacts git@ SSH URLs', () => {
      const m = {
        mission: {
          steps: [{ title: 't', description: 'Clone from git@github.com:private/repo.git' }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).toBe('Clone from [redacted-url]')
    })

    it('redacts multiple URLs in a single field', () => {
      const m = {
        mission: {
          steps: [{
            title: 't',
            description: 'A: http://a.com and B: https://b.io and C: git@c.io:x/y',
          }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      // three redactions
      const matches = out.mission.steps[0].description.match(/\[redacted-url\]/g) || []
      expect(matches.length).toBe(3)
    })

    it('redacts URLs from title fields too', () => {
      const m = {
        mission: {
          title: 'See https://leak.example',
          description: 'x',
          steps: [],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.title).toBe('See [redacted-url]')
    })
  })

  describe('email redaction', () => {
    it('redacts a simple email address', () => {
      const m = {
        mission: {
          steps: [{ title: 't', description: 'Contact admin@example.com for help' }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).toBe('Contact [redacted-email] for help')
    })

    it('redacts emails with plus-tags and dots', () => {
      const m = {
        mission: {
          steps: [{ title: 't', description: 'user.name+tag@sub.corp.example' }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).toBe('[redacted-email]')
    })
  })

  describe('secret redaction', () => {
    it('redacts token= assignments', () => {
      const m = {
        mission: { steps: [{ title: 't', description: 'export token=abcd1234deadbeef' }] },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).toContain('[redacted-secret]')
      expect(out.mission.steps[0].description).not.toContain('abcd1234deadbeef')
    })

    it('redacts password: assignments', () => {
      const m = {
        mission: { steps: [{ title: 't', description: 'password: hunter2' }] },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).toContain('[redacted-secret]')
      expect(out.mission.steps[0].description).not.toContain('hunter2')
    })

    it('redacts api_key and api-key variants (case-insensitive)', () => {
      for (const key of ['api_key', 'api-key', 'API_KEY', 'ApiKey']) {
        const m = {
          mission: { steps: [{ title: 't', description: `${key}=SUPERSECRET` }] },
        }
        const out = sanitizeMissionForHTTP(m)
        expect(out.mission.steps[0].description).not.toContain('SUPERSECRET')
        expect(out.mission.steps[0].description).toContain('[redacted-secret]')
      }
    })

    it('redacts secret= assignments', () => {
      const m = {
        mission: { steps: [{ title: 't', description: 'SECRET = topsecretvalue' }] },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description).not.toContain('topsecretvalue')
    })
  })

  describe('length clamping', () => {
    it('clamps title to 200 chars', () => {
      const m = { mission: { title: 'a'.repeat(500), description: 'x', steps: [] } }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.title.length).toBe(200)
    })

    it('clamps description to 500 chars', () => {
      const m = { mission: { title: 't', description: 'd'.repeat(2000), steps: [] } }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.description.length).toBe(500)
    })

    it('clamps step title to 200 chars', () => {
      const m = {
        mission: {
          steps: [{ title: 't'.repeat(1000), description: 'x' }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].title.length).toBe(200)
    })

    it('clamps step description to 2000 chars', () => {
      const m = {
        mission: {
          steps: [{ title: 't', description: 'd'.repeat(10000) }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      expect(out.mission.steps[0].description.length).toBe(2000)
    })

    it('caps steps at 20 (prevents huge-payload exfil)', () => {
      const steps = Array.from({ length: 100 }, (_, i) => ({ title: `s${i}`, description: 'x' }))
      const out = sanitizeMissionForHTTP({ mission: { steps } })
      expect(out.mission.steps.length).toBe(20)
    })
  })

  describe('metadata allowlisting', () => {
    it('accepts valid installMethod slugs', () => {
      const out = sanitizeMissionForHTTP({
        mission: { steps: [] },
        metadata: { installMethods: ['helm', 'kubectl', 'operator-sdk'] },
      })
      expect(out.metadata.installMethods).toEqual(['helm', 'kubectl', 'operator-sdk'])
    })

    it('rejects installMethods with uppercase, spaces, or symbols', () => {
      const out = sanitizeMissionForHTTP({
        mission: { steps: [] },
        metadata: { installMethods: ['Helm', 'kube ctl', 'bad$', 'ok'] },
      })
      expect(out.metadata.installMethods).toEqual(['ok'])
    })

    it('rejects installMethods starting with a digit', () => {
      const out = sanitizeMissionForHTTP({
        mission: { steps: [] },
        metadata: { installMethods: ['1helm'] },
      })
      expect(out.metadata.installMethods).toEqual([])
    })

    it('rejects non-string installMethods', () => {
      const out = sanitizeMissionForHTTP({
        mission: { steps: [] },
        metadata: { installMethods: [null, 42, {}, 'valid'] },
      })
      expect(out.metadata.installMethods).toEqual(['valid'])
    })

    it('caps installMethods at 10', () => {
      const arr = Array.from({ length: 50 }, (_, i) => `m${i}`)
      const out = sanitizeMissionForHTTP({
        mission: { steps: [] },
        metadata: { installMethods: arr },
      })
      expect(out.metadata.installMethods.length).toBe(10)
    })

    it('applies the same rules to cncfProjects', () => {
      const out = sanitizeMissionForHTTP({
        mission: { steps: [] },
        metadata: { cncfProjects: ['argo-cd', 'BadProject', 'ok'] },
      })
      expect(out.metadata.cncfProjects).toEqual(['argo-cd', 'ok'])
    })

    it('caps cncfProjects at 10', () => {
      const arr = Array.from({ length: 50 }, (_, i) => `p${i}`)
      const out = sanitizeMissionForHTTP({
        mission: { steps: [] },
        metadata: { cncfProjects: arr },
      })
      expect(out.metadata.cncfProjects.length).toBe(10)
    })
  })

  describe('defensive defaults', () => {
    it('handles missing mission block', () => {
      const out = sanitizeMissionForHTTP({})
      expect(out.mission.steps).toEqual([])
      expect(out.metadata.installMethods).toEqual([])
      expect(out.metadata.cncfProjects).toEqual([])
    })

    it('handles missing metadata block', () => {
      const out = sanitizeMissionForHTTP({ mission: { steps: [] } })
      expect(out.metadata).toEqual({ installMethods: [], cncfProjects: [] })
    })

    it('handles non-string title/description via redactFileText', () => {
      const out = sanitizeMissionForHTTP({
        mission: { title: 12345, description: null, steps: [] },
      })
      expect(out.mission.title).toBe('')
      expect(out.mission.description).toBe('')
    })
  })

  describe('combined redaction cases', () => {
    it('redacts URL, email, and secret together in a single description', () => {
      const m = {
        mission: {
          steps: [{
            title: 't',
            description: 'Fetch https://a.com as ops@example.com token=abcXYZ',
          }],
        },
      }
      const out = sanitizeMissionForHTTP(m)
      const d = out.mission.steps[0].description
      expect(d).toContain('[redacted-url]')
      expect(d).toContain('[redacted-email]')
      expect(d).toContain('[redacted-secret]')
      expect(d).not.toContain('abcXYZ')
      expect(d).not.toContain('ops@example.com')
      expect(d).not.toContain('a.com')
    })
  })
})

// ─── validateSection ────────────────────────────────────────────────

describe('validateSection', () => {
  it('accepts a valid section meeting minCount', () => {
    const steps = [
      { title: 'a', description: 'd1' },
      { title: 'b', description: 'd2' },
    ]
    expect(validateSection(steps, 'uninstall', 2)).toBe(true)
  })

  it('accepts a section exceeding minCount', () => {
    const steps = Array.from({ length: 5 }, () => ({ title: 't', description: 'd' }))
    expect(validateSection(steps, 'troubleshooting', 4)).toBe(true)
  })

  it('rejects fewer than minCount steps', () => {
    const steps = [{ title: 'a', description: 'd' }]
    expect(validateSection(steps, 'upgrade', 3)).toBe(false)
  })

  it('rejects a non-array input', () => {
    expect(validateSection(null, 'x', 1)).toBe(false)
    expect(validateSection(undefined, 'x', 1)).toBe(false)
    expect(validateSection('not-an-array', 'x', 1)).toBe(false)
    expect(validateSection({}, 'x', 1)).toBe(false)
  })

  it('rejects a step missing title', () => {
    const steps = [{ description: 'd' }, { title: 'b', description: 'd2' }]
    expect(validateSection(steps, 'x', 2)).toBe(false)
  })

  it('rejects a step missing description', () => {
    const steps = [{ title: 'a' }, { title: 'b', description: 'd2' }]
    expect(validateSection(steps, 'x', 2)).toBe(false)
  })

  it('rejects a step where title is not a string', () => {
    const steps = [{ title: 42, description: 'd' }]
    expect(validateSection(steps, 'x', 1)).toBe(false)
  })

  it('rejects a step where description is not a string', () => {
    const steps = [{ title: 'a', description: { text: 'd' } }]
    expect(validateSection(steps, 'x', 1)).toBe(false)
  })

  it('rejects a step with empty-string title (falsy check)', () => {
    const steps = [{ title: '', description: 'd' }]
    expect(validateSection(steps, 'x', 1)).toBe(false)
  })

  it('rejects an empty array when minCount is 0 only if elements missing? — minCount 0 with empty array passes trivially', () => {
    // every() on [] returns true, so an empty array with minCount 0 is valid.
    expect(validateSection([], 'x', 0)).toBe(true)
  })
})

// ─── sanitizeSteps ──────────────────────────────────────────────────

describe('sanitizeSteps', () => {
  it('returns steps unchanged when under limits', () => {
    const steps = [{ title: 'short', description: 'short-desc' }]
    expect(sanitizeSteps(steps)).toEqual(steps)
  })

  it('clamps title to default 120 chars', () => {
    const steps = [{ title: 't'.repeat(500), description: 'd' }]
    const out = sanitizeSteps(steps)
    expect(out[0].title.length).toBe(120)
  })

  it('clamps description to default 3000 chars', () => {
    const steps = [{ title: 't', description: 'd'.repeat(9000) }]
    const out = sanitizeSteps(steps)
    expect(out[0].description.length).toBe(3000)
  })

  it('honors custom maxTitle and maxDesc', () => {
    const steps = [{ title: 'abcdef', description: 'xyz' }]
    const out = sanitizeSteps(steps, 3, 2)
    expect(out[0].title).toBe('abc')
    expect(out[0].description).toBe('xy')
  })

  it('processes every step in the array', () => {
    const steps = [
      { title: 'a'.repeat(200), description: 'd1' },
      { title: 'b'.repeat(200), description: 'd'.repeat(5000) },
    ]
    const out = sanitizeSteps(steps)
    expect(out.length).toBe(2)
    expect(out[0].title.length).toBe(120)
    expect(out[1].description.length).toBe(3000)
  })

  it('returns a new array of new objects (does not mutate input)', () => {
    const steps = [{ title: 't', description: 'd' }]
    const out = sanitizeSteps(steps)
    expect(out).not.toBe(steps)
    expect(out[0]).not.toBe(steps[0])
  })
})
