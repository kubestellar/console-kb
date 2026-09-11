import { describe, it, expect } from 'vitest'
import { assertSafePath, buildEnrichPrompt } from '../enrich-install-missions.mjs'

describe('assertSafePath', () => {
  const ALLOWED = '/data/missions'

  it('accepts a child path directly under the allowed dir', () => {
    expect(() => assertSafePath('/data/missions/foo.json', ALLOWED)).not.toThrow()
  })

  it('accepts a nested child path', () => {
    expect(() => assertSafePath('/data/missions/sub/foo.json', ALLOWED)).not.toThrow()
  })

  it('accepts the allowed directory itself (equal path)', () => {
    expect(() => assertSafePath(ALLOWED, ALLOWED)).not.toThrow()
  })

  it('rejects a sibling directory with the same prefix (missing trailing slash boundary)', () => {
    // '/data/missions-evil/x' starts with '/data/missions' but not '/data/missions/'
    expect(() => assertSafePath('/data/missions-evil/x', ALLOWED))
      .toThrow(/Path traversal detected/)
  })

  it('rejects a path completely outside the allowed dir', () => {
    expect(() => assertSafePath('/etc/passwd', ALLOWED))
      .toThrow(/Path traversal detected/)
  })

  it('rejects a parent-directory escape (already-resolved)', () => {
    expect(() => assertSafePath('/data/other/foo.json', ALLOWED))
      .toThrow(/Path traversal detected/)
  })

  it('includes both paths in the thrown message', () => {
    try {
      assertSafePath('/etc/passwd', ALLOWED)
      throw new Error('expected throw')
    } catch (err) {
      expect(err.message).toContain('/etc/passwd')
      expect(err.message).toContain(ALLOWED)
    }
  })
})

describe('buildEnrichPrompt', () => {
  const baseMission = {
    mission: {
      title: 'Install Foo',
      description: 'Install the Foo project',
      steps: [
        { title: 'Add helm repo', description: 'helm repo add foo https://foo.example' },
        { title: 'Install chart', description: 'helm install foo foo/foo' },
      ],
    },
    metadata: {
      cncfProjects: ['foo'],
      installMethods: ['helm'],
    },
  }

  it('renders the mission title, description, projects, and methods', () => {
    const out = buildEnrichPrompt(baseMission)
    expect(out).toContain('**Title:** Install Foo')
    expect(out).toContain('**Description:** Install the Foo project')
    expect(out).toContain('**CNCF Project(s):** foo')
    expect(out).toContain('**Install Methods:** helm')
  })

  it('numbers each step starting at 1 and bolds the title', () => {
    const out = buildEnrichPrompt(baseMission)
    expect(out).toContain('1. **Add helm repo**')
    expect(out).toContain('2. **Install chart**')
  })

  it('includes each step description on the line after the title', () => {
    const out = buildEnrichPrompt(baseMission)
    expect(out).toContain('1. **Add helm repo**\nhelm repo add foo https://foo.example')
  })

  it('joins multiple CNCF projects with ", "', () => {
    const out = buildEnrichPrompt({
      ...baseMission,
      metadata: { cncfProjects: ['a', 'b', 'c'], installMethods: ['helm'] },
    })
    expect(out).toContain('**CNCF Project(s):** a, b, c')
  })

  it('joins multiple install methods with ", "', () => {
    const out = buildEnrichPrompt({
      ...baseMission,
      metadata: { cncfProjects: ['foo'], installMethods: ['helm', 'kubectl'] },
    })
    expect(out).toContain('**Install Methods:** helm, kubectl')
  })

  it('falls back to "Unknown" when mission.title is missing', () => {
    const out = buildEnrichPrompt({ mission: { description: 'x', steps: [] }, metadata: {} })
    expect(out).toContain('**Title:** Unknown')
  })

  it('falls back to empty string when mission.description is missing', () => {
    const out = buildEnrichPrompt({ mission: { title: 'T', steps: [] }, metadata: {} })
    expect(out).toContain('**Description:** \n')
  })

  it('handles a completely missing mission object without throwing', () => {
    const out = buildEnrichPrompt({ metadata: {} })
    expect(out).toContain('**Title:** Unknown')
  })

  it('handles a completely missing metadata object without throwing', () => {
    const out = buildEnrichPrompt({ mission: { title: 'T', description: 'D', steps: [] } })
    expect(out).toContain('**CNCF Project(s):** \n')
    expect(out).toContain('**Install Methods:** \n')
  })

  it('emits an empty steps section when steps is missing', () => {
    const out = buildEnrichPrompt({ mission: { title: 'T', description: 'D' }, metadata: {} })
    expect(out).toContain('## Current Install Steps\n\n\n')
  })

  it('emits an empty steps section when steps is an empty array', () => {
    const out = buildEnrichPrompt({
      mission: { title: 'T', description: 'D', steps: [] },
      metadata: {},
    })
    expect(out).toContain('## Current Install Steps\n\n\n')
  })

  it('ends with a JSON-only instruction', () => {
    const out = buildEnrichPrompt(baseMission)
    expect(out.trim().endsWith('Return JSON only.')).toBe(true)
  })

  it('separates consecutive steps with a blank line', () => {
    const out = buildEnrichPrompt(baseMission)
    expect(out).toMatch(/1\. \*\*Add helm repo\*\*\nhelm repo add foo https:\/\/foo\.example\n\n2\. \*\*Install chart\*\*/)
  })

  it('preserves the leading "# Existing Install Mission" header', () => {
    const out = buildEnrichPrompt(baseMission)
    expect(out.startsWith('# Existing Install Mission')).toBe(true)
  })
})
