// Guards previously-uncovered branches in scripts/sources/stackoverflow.mjs:
//
//   - line 51-52  : tag-search response.ok=false -> early "skipping" return
//   - line 60-61  : data.quota_remaining < 10   -> "Quota nearly exhausted" exit
//   - line 76     : outer try/catch swallows tag-search fetch error
//   - line 108    : text-search response.ok=false -> silent skip
//   - line 153-165: text-search catch reports err.message
//   - line 244    : detectTypeFromTags "networking" arm
//   - line 245    : detectTypeFromTags default "troubleshooting" arm
//   - line 234    : extractStepsFromHtml `text.length > 10` false arm (short LI)
//   - line 235    : extractStepsFromHtml `steps.length >= 10` break arm
//
// Existing __tests__/sources/stackoverflow.test.mjs only covers the happy tag
// + text search dedup path and one `extractMission` happy path via
// `detectTypeFromTags` "security" arm — leaving these branches unreached.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StackOverflowSource } from '../../sources/stackoverflow.mjs'

const ORIGINAL_FETCH = globalThis.fetch

const TEST_PROJECT = {
  name: 'KubeVirt',
  repo: 'kubevirt/kubevirt',
  maturity: 'sandbox',
  category: 'virtualization',
  sources: {
    stackoverflow: { tags: ['kubernetes', 'kubevirt'] },
  },
}

describe('StackOverflowSource — error and quota branches', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('returns empty items when tag search HTTP status is non-ok (line 51-52)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    })
    globalThis.fetch = fetchMock

    const source = new StackOverflowSource({ rateLimitDelay: 0, maxPerProject: 5, minVotes: 10 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: [],
      cursor: null,
    })

    // items short-circuited to []; text-search fallback (< 3 items) also fires,
    // so we assert on the tag-search warning going through the 503 branch.
    expect(result.items.filter(i => i.question_id === 1)).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('SO: 503 for KubeVirt'),
    )
  })

  it('stops early when quota_remaining < 10 (line 60-61)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quota_remaining: 5,
        items: [{ question_id: 401, score: 15, is_answered: true, title: 'ignored' }],
      }),
    })
    globalThis.fetch = fetchMock

    const source = new StackOverflowSource({ rateLimitDelay: 0, maxPerProject: 5, minVotes: 10 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: [],
      cursor: null,
    })

    // Quota-exhausted path returns { items: [] } and skips text search entirely.
    expect(result.items).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Quota nearly exhausted'),
    )
  })

  it('logs but does not throw when the tag-search fetch rejects (line 76 catch)', async () => {
    const fetchMock = vi.fn()
      // Tag-search rejects -> outer try/catch swallows error.
      .mockRejectedValueOnce(new Error('DNS timeout'))
      // Text-search fallback then succeeds with zero items.
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
    globalThis.fetch = fetchMock

    const source = new StackOverflowSource({ rateLimitDelay: 0, maxPerProject: 5, minVotes: 10 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: [],
      cursor: null,
    })

    expect(result.items).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('SO: Error searching for KubeVirt: DNS timeout'),
    )
  })

  it('silently skips the text search when its HTTP status is non-ok (line 108)', async () => {
    const fetchMock = vi.fn()
      // Tag search returns < 3 items so text-search fallback fires.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ question_id: 501, score: 25, is_answered: true, title: 'ok' }],
        }),
      })
      // Text search 500 -> `if (response.ok)` false -> no extra items merged.
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    globalThis.fetch = fetchMock

    const source = new StackOverflowSource({ rateLimitDelay: 0, maxPerProject: 5, minVotes: 10 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: [],
      cursor: null,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0].question_id).toBe(501)
  })

  it('logs but does not throw when the text-search fetch rejects (line 153-165 catch)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ question_id: 601, score: 25, is_answered: true, title: 'ok' }],
        }),
      })
      .mockRejectedValueOnce(new Error('text search failed'))
    globalThis.fetch = fetchMock

    const source = new StackOverflowSource({ rateLimitDelay: 0, maxPerProject: 5, minVotes: 10 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: [],
      cursor: null,
    })

    expect(result.items).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('SO: Text search error: text search failed'),
    )
  })
})

describe('StackOverflowSource — extractMission null-answer and type detection', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when fetchAcceptedAnswer yields no answer', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue(null)

    const mission = await source.extractMission({
      question_id: 42,
      title: 'irrelevant',
      body: '<p>problem</p>',
      link: 'https://example.test/42',
      tags: [],
      score: 5,
    }, TEST_PROJECT)

    expect(mission).toBeNull()
  })

  it('detects "networking" via ingress tag (line 244)', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: '<p>Configure the Ingress with the correct hostname.</p>',
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 88,
      title: 'ingress not routing',
      body: '<p>traffic dropped by ingress controller</p>',
      link: 'https://stackoverflow.com/q/88',
      tags: ['kubernetes', 'ingress'],
      score: 12,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    expect(mission.metadata.issueTypes).toEqual(['networking'])
  })

  it('falls back to "troubleshooting" for unrelated tags (line 245 default arm)', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: '<p>Just restart the operator.</p>',
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 99,
      title: 'operator quirk',
      body: '<p>operator behaves oddly on restart</p>',
      link: 'https://stackoverflow.com/q/99',
      tags: ['kubernetes', 'operator'],
      score: 8,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    expect(mission.metadata.issueTypes).toEqual(['troubleshooting'])
  })

  it('drops <li> steps shorter than 11 chars but keeps longer ones (extractStepsFromHtml short-arm)', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: '<ol><li>ok</li><li>Inspect the Deployment named virt-api carefully</li></ol>',
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 111,
      title: 'short step filter',
      body: '<p>problem</p>',
      link: 'https://stackoverflow.com/q/111',
      tags: ['kubernetes'],
      score: 5,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    const steps = mission.mission?.steps ?? []
    // Short "ok" LI (< 11 chars) must be dropped.
    expect(steps.some(s => (s.title || s) === 'ok')).toBe(false)
    // Longer LI must survive.
    const combined = JSON.stringify(steps)
    expect(combined).toContain('Inspect the Deployment named virt-api')
  })
})

describe('StackOverflowSource — fetchAcceptedAnswer real fetch paths', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('returns the accepted answer when present', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { is_accepted: false, body: 'other', score: 12 },
          { is_accepted: true, body: 'the accepted body', score: 5 },
        ],
      }),
    })
    const ans = await source.fetchAcceptedAnswer(123)
    expect(ans).toEqual({ is_accepted: true, body: 'the accepted body', score: 5 })
  })

  it('falls back to the highest-voted answer when none is accepted', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { is_accepted: false, body: 'top', score: 30 },
          { is_accepted: false, body: 'lower', score: 10 },
        ],
      }),
    })
    const ans = await source.fetchAcceptedAnswer(456)
    expect(ans).toEqual({ is_accepted: false, body: 'top', score: 30 })
  })

  it('returns null on empty items array', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    })
    const ans = await source.fetchAcceptedAnswer(789)
    expect(ans).toBeNull()
  })

  it('returns null when the HTTP response is not ok (line 158)', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 })
    const ans = await source.fetchAcceptedAnswer(890)
    expect(ans).toBeNull()
  })

  it('returns null when the fetch itself throws (line 165 catch)', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const ans = await source.fetchAcceptedAnswer(901)
    expect(ans).toBeNull()
  })
})

describe('StackOverflowSource — extractHtmlCodeBlocks length + keyword filters (issue #3130)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('drops a <pre><code> block shorter than 21 chars even when it contains apiVersion:', async () => {
    // Guards the `block.length > 20` false arm at line 205. A block that
    // is otherwise valid (has apiVersion:) but too short must NOT be
    // pushed into yamlSnippets, so extractSnippetsFromSteps has nothing
    // to add to codeSnippets from the HTML.
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: '<pre><code>apiVersion: v1</code></pre>',
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 2001,
      title: 'too-short block',
      body: '<p>problem</p>',
      link: 'https://stackoverflow.com/q/2001',
      tags: ['kubernetes'],
      score: 5,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    const snippets = mission.mission?.resolution?.codeSnippets ?? []
    // Reject the 20-char block. Any other snippets (from step markdown
    // fences) are unrelated — we only check the too-short one is not
    // present verbatim.
    expect(snippets.some(s => s === 'apiVersion: v1')).toBe(false)
  })

  it('drops a <pre><code> block that lacks every k8s keyword', async () => {
    // Guards the false arm of the inner `apiVersion: || kind: || kubectl || helm`
    // OR chain at line 206. A block that satisfies the length window
    // but contains no k8s keyword must not be attached — otherwise SO
    // JavaScript stack traces would poison KB YAML snippets.
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const nonK8sBlock =
      'function foo(bar) { throw new Error("no yaml here just javascript") }'
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: `<pre><code>${nonK8sBlock}</code></pre>`,
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 2002,
      title: 'non-k8s code block',
      body: '<p>problem</p>',
      link: 'https://stackoverflow.com/q/2002',
      tags: ['kubernetes'],
      score: 5,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    const snippets = mission.mission?.resolution?.codeSnippets ?? []
    expect(snippets.some(s => s.includes('function foo'))).toBe(false)
  })

  it('drops a <pre><code> block longer than 5000 chars', async () => {
    // Guards the false arm of the `block.length < 5000` upper bound at
    // line 205. Removing or loosening the cap would let a giant SO
    // paste through into KB storage; assert the guard fires.
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const filler = 'a'.repeat(4990)
    // Length ~5031 chars, still contains `apiVersion:` and `kind:`, so
    // the only reason to reject is the length cap.
    const oversized = `${filler} apiVersion: v1 kind: Deployment`
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: `<pre><code>${oversized}</code></pre>`,
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 2003,
      title: 'oversized block',
      body: '<p>problem</p>',
      link: 'https://stackoverflow.com/q/2003',
      tags: ['kubernetes'],
      score: 5,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    const snippets = mission.mission?.resolution?.codeSnippets ?? []
    expect(snippets.some(s => s.includes(filler))).toBe(false)
  })
})

describe('StackOverflowSource — extractStepsFromHtml 10-item cap (issue #3130)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('caps step extraction at 10 <li> items even when the answer supplies more', async () => {
    // Guards the `steps.length >= 10` true arm at line 231. The
    // extractor stops after 10 items to protect downstream mission
    // storage from very long SO <ol> lists.
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const items = Array.from({ length: 12 }, (_, i) =>
      `<li>Step ${String(i + 1).padStart(2, '0')} inspect the resource carefully with kubectl</li>`,
    ).join('')
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: `<ol>${items}</ol>`,
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 2004,
      title: '>10 li items',
      body: '<p>problem</p>',
      link: 'https://stackoverflow.com/q/2004',
      tags: ['kubernetes'],
      score: 5,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    const steps = mission.mission?.steps ?? []
    // The 11th and 12th items must not be present. Their bodies contain
    // "Step 11" / "Step 12" — assert neither appears anywhere in the
    // final step objects. buildMission() may pass through fewer than 10
    // (validation/dedup), but must not exceed the cap.
    const combined = JSON.stringify(steps)
    expect(combined).not.toContain('Step 11')
    expect(combined).not.toContain('Step 12')
    // At least Step 01 should have survived — sanity check that the
    // extractor is actually populating steps, not returning [].
    expect(combined).toContain('Step 01')
  })
})
