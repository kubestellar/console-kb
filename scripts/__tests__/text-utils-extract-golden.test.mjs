import { afterEach, describe, expect, it } from 'vitest'
import {
  CODE_FENCE_LANGS,
  TYPE_KEYWORDS,
  extractCodeBlocks,
  detectType,
} from '../lib/text-utils.mjs'
import { slugify as textUtilsSlugify } from '../lib/text-utils.mjs'
import { slugify as missionFileSlugify } from '../lib/mission-file.mjs'

// Golden tests (kubestellar/console-kb#3807). The LEGACY_* functions are
// verbatim copies of the pre-consolidation implementations in
// sources/github-discussions.mjs and sources/reddit.mjs. The unified
// functions must match them everywhere except the enumerated deltas.

function legacyGithubExtractCodeBlocks(text) {
  const blocks = []
  const regex = /```(?:yaml|yml|bash|sh)?\n([\s\S]*?)```/gi
  let match
  while ((match = regex.exec(text)) !== null) {
    const block = match[1].trim()
    if (block.length > 20 && block.length < 5000) blocks.push(block)
  }
  return blocks
}

function legacyRedditExtractCodeBlocks(text) {
  const blocks = []
  const regex = /```(?:yaml|yml)?\n([\s\S]*?)```/gi
  let match
  while ((match = regex.exec(text)) !== null) {
    const block = match[1].trim()
    if (block.length > 20 && block.length < 5000) blocks.push(block)
  }
  return blocks
}

function legacyGithubDetectType(text) {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('crash') || lower.includes('fail')) return 'troubleshooting'
  if (lower.includes('how to') || lower.includes('best practice')) return 'best-practice'
  if (lower.includes('performance') || lower.includes('slow')) return 'performance'
  if (lower.includes('security') || lower.includes('rbac')) return 'security'
  return 'troubleshooting'
}

function legacyRedditDetectType(text) {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('crash') || lower.includes('fail')) return 'troubleshooting'
  if (lower.includes('how to') || lower.includes('best practice') || lower.includes('recommend')) return 'best-practice'
  if (lower.includes('performance') || lower.includes('slow') || lower.includes('latency')) return 'performance'
  if (lower.includes('security') || lower.includes('rbac') || lower.includes('tls')) return 'security'
  return 'troubleshooting'
}

const BODY = 'kubectl get pods -n kube-system --watch'
const fence = (lang) => '```' + lang + '\n' + BODY + '\n```'

const FENCE_CORPUS = [
  { name: 'yaml', text: fence('yaml'), github: [BODY], reddit: [BODY] },
  { name: 'yml', text: fence('yml'), github: [BODY], reddit: [BODY] },
  { name: 'bash', text: fence('bash'), github: [BODY], reddit: [] }, // delta: reddit now captures
  { name: 'sh', text: fence('sh'), github: [BODY], reddit: [] }, // delta: reddit now captures
  { name: 'unlabelled', text: fence(''), github: [BODY], reddit: [BODY] },
  { name: 'other language', text: fence('python'), github: [], reddit: [] },
  { name: 'too short', text: '```yaml\nshort: 1\n```', github: [], reddit: [] },
  { name: 'too long', text: '```yaml\n' + 'a'.repeat(5000) + '\n```', github: [], reddit: [] },
  { name: 'no fences', text: 'plain prose only', github: [], reddit: [] },
  { name: 'mixed', text: fence('yaml') + '\ntext\n' + fence('sh'), github: [BODY, BODY], reddit: [BODY] },
]

const TYPE_CORPUS = [
  { name: 'error', text: 'Pod crash with an Error', github: 'troubleshooting', reddit: 'troubleshooting' },
  { name: 'how to', text: 'How to scale', github: 'best-practice', reddit: 'best-practice' },
  { name: 'best practice', text: 'a best practice guide', github: 'best-practice', reddit: 'best-practice' },
  { name: 'recommend', text: 'what do you recommend', github: 'troubleshooting', reddit: 'best-practice' }, // delta
  { name: 'performance', text: 'performance tuning', github: 'performance', reddit: 'performance' },
  { name: 'slow', text: 'it is slow', github: 'performance', reddit: 'performance' },
  { name: 'latency', text: 'high latency', github: 'troubleshooting', reddit: 'performance' }, // delta
  { name: 'security', text: 'security hardening', github: 'security', reddit: 'security' },
  { name: 'rbac', text: 'rbac roles', github: 'security', reddit: 'security' },
  { name: 'tls', text: 'enable tls', github: 'troubleshooting', reddit: 'security' }, // delta
  { name: 'default', text: 'nothing relevant here', github: 'troubleshooting', reddit: 'troubleshooting' },
]

describe('legacy behaviour pinned (golden)', () => {
  for (const c of FENCE_CORPUS) {
    it(`fence: ${c.name}`, () => {
      expect(legacyGithubExtractCodeBlocks(c.text)).toEqual(c.github)
      expect(legacyRedditExtractCodeBlocks(c.text)).toEqual(c.reddit)
    })
  }
  for (const c of TYPE_CORPUS) {
    it(`type: ${c.name}`, () => {
      expect(legacyGithubDetectType(c.text)).toBe(c.github)
      expect(legacyRedditDetectType(c.text)).toBe(c.reddit)
    })
  }
})

describe('unified extractCodeBlocks / detectType', () => {
  afterEach(() => {
    delete process.env.CODE_FENCE_LANGS
  })

  it('exports the superset constants', () => {
    expect([...CODE_FENCE_LANGS]).toEqual(['yaml', 'yml', 'bash', 'sh'])
    expect(TYPE_KEYWORDS.map(([t]) => t)).toEqual(['troubleshooting', 'best-practice', 'performance', 'security'])
  })

  for (const c of FENCE_CORPUS) {
    it(`fence: ${c.name} matches github-discussions legacy`, () => {
      expect(extractCodeBlocks(c.text)).toEqual(c.github)
    })
  }

  it('reddit-style explicit yaml/yml langs reproduce legacy reddit output', () => {
    for (const c of FENCE_CORPUS) {
      expect(extractCodeBlocks(c.text, ['yaml', 'yml'])).toEqual(c.reddit)
    }
  })

  it('env var overrides the default fence set', () => {
    process.env.CODE_FENCE_LANGS = 'yaml'
    expect(extractCodeBlocks(fence('sh'))).toEqual([])
    expect(extractCodeBlocks(fence('yaml'))).toEqual([BODY])
  })

  for (const c of TYPE_CORPUS) {
    it(`type: ${c.name} matches reddit legacy (superset)`, () => {
      expect(detectType(c.text)).toBe(c.reddit)
    })
  }

  it('only enumerated cases differ from github-discussions legacy', () => {
    const deltas = TYPE_CORPUS.filter((c) => detectType(c.text) !== legacyGithubDetectType(c.text)).map((c) => c.name)
    expect(deltas).toEqual(['recommend', 'latency', 'tls'])
  })
})

describe('slugify consolidation', () => {
  it('mission-file re-exports the text-utils slugify', () => {
    expect(missionFileSlugify).toBe(textUtilsSlugify)
  })
})
