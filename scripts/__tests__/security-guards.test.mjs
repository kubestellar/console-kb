import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  assertSafeSlug,
  assertSafePath,
  slugify,
} from '../generate-cncf-install-missions.mjs'
import {
  assertSafeSlug as assertSafeSlugPlatform,
  assertSafePath as assertSafePathPlatform,
  slugify as slugifyPlatform,
} from '../generate-platform-missions.mjs'
import { assertTrustedEndpoint, ANTHROPIC_POLICY } from '../lib/llm-endpoint-guard.mjs'
import { chatCompletionsEndpoint } from '../lib/llm-proxy-config.mjs'

// ─── assertSafeSlug (generate-cncf-install-missions) ────────────────

describe('assertSafeSlug (cncf-install)', () => {
  describe('happy path — safe slugs', () => {
    it('accepts a simple lowercase slug', () => {
      expect(() => assertSafeSlug('my-project')).not.toThrow()
    })

    it('accepts a slug with digits', () => {
      expect(() => assertSafeSlug('project-v2')).not.toThrow()
    })

    it('accepts a single word', () => {
      expect(() => assertSafeSlug('argo')).not.toThrow()
    })

    it('accepts a long but valid slug', () => {
      expect(() => assertSafeSlug('a'.repeat(80))).not.toThrow()
    })
  })

  describe('rejects path separators', () => {
    it('throws on forward slash', () => {
      expect(() => assertSafeSlug('../../etc/passwd')).toThrow('Unsafe slug')
    })

    it('throws on backslash', () => {
      expect(() => assertSafeSlug('project\\evil')).toThrow('Unsafe slug')
    })
  })

  describe('rejects dot notation', () => {
    it('throws on a slug with a dot', () => {
      expect(() => assertSafeSlug('project.json')).toThrow('Unsafe slug')
    })

    it('throws on double-dot traversal attempt', () => {
      expect(() => assertSafeSlug('..evil')).toThrow('Unsafe slug')
    })
  })

  describe('rejects leading dash', () => {
    it('throws on slug starting with dash', () => {
      expect(() => assertSafeSlug('-bad-slug')).toThrow('Unsafe slug')
    })
  })

  describe('rejects empty / falsy values', () => {
    it('throws on empty string', () => {
      expect(() => assertSafeSlug('')).toThrow('Unsafe slug')
    })

    it('throws on null', () => {
      expect(() => assertSafeSlug(null)).toThrow('Unsafe slug')
    })

    it('throws on undefined', () => {
      expect(() => assertSafeSlug(undefined)).toThrow('Unsafe slug')
    })
  })

  it('includes the source name in the error message', () => {
    expect(() => assertSafeSlug('bad/slug', 'project.name'))
      .toThrow('project.name')
  })
})

// ─── assertSafePath (generate-cncf-install-missions) ─────────────────

describe('assertSafePath (cncf-install)', () => {
  const root = '/workspace/solutions'

  describe('happy path — safe paths', () => {
    it('accepts a direct child file', () => {
      expect(() => assertSafePath(`${root}/install-argo.json`, root)).not.toThrow()
    })

    it('accepts a nested child file', () => {
      expect(() => assertSafePath(`${root}/subdir/file.json`, root)).not.toThrow()
    })

    it('accepts exact match to the allowed dir', () => {
      expect(() => assertSafePath(root, root)).not.toThrow()
    })
  })

  describe('rejects path traversal', () => {
    it('throws when resolved path escapes the allowed dir', () => {
      const traversal = join(root, '../..', 'etc', 'passwd')
      expect(() => assertSafePath(traversal, root)).toThrow('Path traversal detected')
    })

    it('throws for a completely different directory', () => {
      expect(() => assertSafePath('/etc/passwd', root)).toThrow('Path traversal detected')
    })

    it('throws for a sibling directory that shares the prefix', () => {
      // /workspace/solutions-evil should NOT match /workspace/solutions
      expect(() => assertSafePath(`${root}-evil/file.json`, root)).toThrow('Path traversal detected')
    })

    it('throws for root path', () => {
      expect(() => assertSafePath('/', root)).toThrow('Path traversal detected')
    })
  })
})

// ─── assertSafeSlug (generate-platform-missions) ─────────────────────

describe('assertSafeSlug (platform-missions)', () => {
  it('accepts a valid platform slug', () => {
    expect(() => assertSafeSlugPlatform('eks-managed')).not.toThrow()
  })

  it('throws on forward slash in slug', () => {
    expect(() => assertSafeSlugPlatform('eks/evil')).toThrow('Unsafe slug')
  })

  it('throws on backslash in slug', () => {
    expect(() => assertSafeSlugPlatform('eks\\evil')).toThrow('Unsafe slug')
  })

  it('throws on dot in slug', () => {
    expect(() => assertSafeSlugPlatform('eks.json')).toThrow('Unsafe slug')
  })

  it('throws on leading dash', () => {
    expect(() => assertSafeSlugPlatform('-eks')).toThrow('Unsafe slug')
  })

  it('throws on empty string', () => {
    expect(() => assertSafeSlugPlatform('')).toThrow('Unsafe slug')
  })

  it('includes source in error when provided', () => {
    expect(() => assertSafeSlugPlatform('', 'platform.name'))
      .toThrow('platform.name')
  })
})

// ─── assertSafePath (generate-platform-missions) ─────────────────────

describe('assertSafePath (platform-missions)', () => {
  const root = '/workspace/platform-solutions'

  it('accepts a valid child path', () => {
    expect(() => assertSafePathPlatform(`${root}/platform-eks.json`, root)).not.toThrow()
  })

  it('throws on path traversal escape', () => {
    const traversal = join(root, '../../etc/shadow')
    expect(() => assertSafePathPlatform(traversal, root)).toThrow('Path traversal detected')
  })

  it('throws on sibling-prefix path', () => {
    expect(() => assertSafePathPlatform(`${root}-other/file`, root)).toThrow('Path traversal detected')
  })
})

// ─── slugify (generate-cncf-install-missions) ────────────────────────

describe('slugify (cncf-install)', () => {
  it('lowercases and replaces non-alphanumeric chars', () => {
    expect(slugify('My Project 2.0!')).toBe('my-project-2-0')
  })

  it('strips leading and trailing dashes', () => {
    expect(slugify('  argo  ')).toBe('argo')
  })

  it('collapses consecutive separators', () => {
    expect(slugify('foo---bar')).toBe('foo-bar')
  })

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long).length).toBeLessThanOrEqual(80)
  })
})

// ─── slugify (generate-platform-missions) ────────────────────────────

describe('slugify (platform-missions)', () => {
  it('lowercases input', () => {
    expect(slugifyPlatform('EKS')).toBe('eks')
  })

  it('replaces spaces and symbols with dashes', () => {
    expect(slugifyPlatform('GKE Autopilot 2.0')).toBe('gke-autopilot-2-0')
  })

  it('strips leading and trailing dashes', () => {
    expect(slugifyPlatform('-platform-')).toBe('platform')
  })

  it('collapses consecutive dashes', () => {
    expect(slugifyPlatform('a--b---c')).toBe('a-b-c')
  })
})

// ─── assertTrustedEndpoint (fixed-host ANTHROPIC_ENDPOINT gate) ──────

describe('assertTrustedEndpoint', () => {
  it('accepts any path under an allowed prefix', () => {
    expect(() => assertTrustedEndpoint('https://api.anthropic.com/v1/messages', ANTHROPIC_POLICY)).not.toThrow()
  })

  it('throws for an HTTPS endpoint not in the allowlist', () => {
    expect(() => assertTrustedEndpoint('https://attacker.example.com/api', ANTHROPIC_POLICY)).toThrow('Untrusted LLM_ENDPOINT')
  })

  it('throws for an endpoint that only starts like a valid prefix', () => {
    expect(() =>
      assertTrustedEndpoint('https://api.anthropic.com.evil.com/steal', ANTHROPIC_POLICY, 'ANTHROPIC_ENDPOINT')
    ).toThrow('Untrusted ANTHROPIC_ENDPOINT')
  })

  it('throws for an empty string and lists the allowed prefixes', () => {
    let msg = ''
    try { assertTrustedEndpoint('', ANTHROPIC_POLICY) } catch (e) { msg = e.message }
    expect(msg).toContain('Untrusted LLM_ENDPOINT')
    expect(msg).toContain('https://api.anthropic.com/')
  })

  it('ANTHROPIC_POLICY is pinned and uses HTTPS', () => {
    expect(ANTHROPIC_POLICY).toEqual(['https://api.anthropic.com/'])
  })
})

// ─── LLM proxy endpoint validation (lib/llm-proxy-config.mjs, #3702) ──

describe('chatCompletionsEndpoint (LLM_BASE_URL validation)', () => {
  it('rejects plain http to a non-loopback host', () => {
    expect(() => chatCompletionsEndpoint('http://evil.com/steal')).toThrow(/must use https/)
  })

  it('rejects embedded credentials', () => {
    expect(() => chatCompletionsEndpoint('https://u:p@proxy.example.com/v1')).toThrow(/credentials/)
  })

  it('accepts an https proxy URL', () => {
    expect(chatCompletionsEndpoint('https://proxy.example.com/v1')).toBe('https://proxy.example.com/v1/chat/completions')
  })
})
