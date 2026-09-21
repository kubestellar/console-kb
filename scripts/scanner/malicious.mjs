/**
 * Malicious-content detection (XSS, privileged YAML, RBAC wildcards,
 * command injection, obfuscation bypasses) for mission content.
 * Extracted from scripts/scanner.mjs (console-kb#3195).
 */

import { deepStringValues } from './scan-utils.mjs';

const MALICIOUS_PATTERNS = [
  // XSS
  { name: 'XSS: script tag', pattern: /<script[\s>]/gi },
  { name: 'XSS: event handler', pattern: /\bon\w+\s*=\s*["']/gi },
  { name: 'XSS: javascript: URI', pattern: /javascript\s*:/gi },
  { name: 'XSS: data: URI', pattern: /data\s*:\s*text\/html/gi },
  { name: 'XSS: eval()', pattern: /\beval\s*\(/gi },
  { name: 'XSS: document.cookie', pattern: /document\.cookie/gi },
  { name: 'XSS: innerHTML', pattern: /\.innerHTML\s*=/gi },

  // Privileged Kubernetes YAML
  { name: 'Privileged container', pattern: /privileged\s*:\s*true/gi },
  { name: 'hostNetwork enabled', pattern: /hostNetwork\s*:\s*true/gi },
  { name: 'hostPID enabled', pattern: /hostPID\s*:\s*true/gi },
  { name: 'hostPath mount', pattern: /hostPath\s*:\s*\n?\s*path\s*:/gi },
  { name: 'hostPath reference', pattern: /hostPath\s*:/gi },

  // RBAC wildcards
  { name: 'RBAC wildcard resources', pattern: /resources\s*:\s*\[?\s*["']?\*["']?\s*\]?/gi },
  { name: 'RBAC wildcard verbs', pattern: /verbs\s*:\s*\[?\s*["']?\*["']?\s*\]?/gi },

  // Command injection (safe CLI tools like kubectl/helm/jq are allowlisted)
  // Use [^`\n] to avoid matching across line boundaries, which causes false positives
  // when markdown inline-code spans in natural-language descriptions happen to contain
  // ; or || somewhere between two backticks in the joined text.
  { name: 'Command injection: backtick', pattern: /`[^`\n]*(?:\$\(|;|&&|\|\|)[^`\n]*`/g, allowSafeCLI: true },
  { name: 'Command injection: $() in string', pattern: /\$\([^)\n]{4,}\)/g, allowSafeCLI: true },
  // The right-hand side of the pipe must cover every shell/interpreter a
  // mission could redirect a downloaded script into — a `curl … | zsh` (or
  // `| python`, `| perl`, `| pwsh`) attack landed in the KB just as easily
  // as `| bash` before this list was broadened (kubestellar/console-kb#3493).
  { name: 'Suspicious curl pipe', pattern: /curl\s[^|\n]*\|\s*(?:bash|sh|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|python\d*|perl|ruby|node|php|deno|bun)\b/gi },
  { name: 'Suspicious wget pipe', pattern: /wget\s[^|\n]*\|\s*(?:bash|sh|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|python\d*|perl|ruby|node|php|deno|bun)\b/gi },
  // env / xargs / find shell-interpreter escapes
  // `env bash -c '...'` bypasses binary allowlists even when shell:false is set.
  // env(1) accepts three token shapes before the command:
  //   * short/long option flags     (`-i`, `--ignore-environment`)
  //   * flags whose value is a separate argv token (`-u VAR`, `-C DIR`, `-S 'a b'`)
  //   * `NAME=value` variable assignments (posix), of which there can be many
  // The earlier regex only accepted dash-prefixed tokens, so
  // `env FOO=bar bash -c evil` and `env -u PATH bash -c evil` slipped past
  // the scanner even though they are the standard shapes for this bypass.
  // Use a negative lookahead: skip any non-interpreter token, then require
  // one of the known interpreter binaries.
  // The interpreter list must stay in sync across env/xargs/find so
  // `env FOO=bar csh -c evil` (or tcsh/fish/pwsh/powershell) can't slip
  // through only because the classic POSIX shells are enumerated
  // (kubestellar/console-kb#3493).
  { name: 'Allowlist escape via env', pattern: /\benv\b(?:\s+(?!(?:bash|sh|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|python\d*|ruby|perl|node|php|deno|bun)\b)\S+)*\s+(?:bash|sh|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|python\d*|ruby|perl|node|php|deno|bun)\b/gi },
  { name: 'Allowlist escape via xargs', pattern: /\bxargs\s+(?:-\S+\s+)*(?:bash|sh|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|python\d*|ruby|perl|node|php|deno|bun)\b/gi },
  { name: 'Allowlist escape via find -exec', pattern: /\bfind\s[^;]*-exec\s+(?:bash|sh|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|python\d*|ruby|perl|node|php|deno|bun)\b/gi },
  // awk / sed carry their own DSL execute primitives — the wrapper binaries
  // are in SAFE_CLI_COMMANDS (they're used legitimately as text filters), so
  // detection has to fire on the specific execute forms, not the invocation.
  { name: 'Interpreter shell escape via awk system', pattern: /\bawk\s+[^\n]*['"][^'"\n]*\bsystem\s*\(/gi },
  // sed's `e` command runs shell — both the `s/pat/repl/e` substitution flag
  // and the `<addr>e <cmd>` standalone command. Match either form inside a
  // quoted sed program.
  { name: 'sed execute flag (arbitrary shell)', pattern: /\bsed\b[^\n]*(?:s\/[^\/\n]*\/[^\/\n]*\/[gI]*e\b|['"](?:\d+|\$|\/[^\/\n]+\/)?\s*e\s+\S)/g },
  // Non-shell interpreters given `-c`/`-e` reach into the shell only when the
  // script literal calls a shell-execution primitive. Narrowed so legitimate
  // one-liners (`python -c 'import yaml; ...'`, `node -e 'console.log(...)'`)
  // don't false-positive — the rule fires when the script contains one of
  // the language-specific execute primitives. The alternation covers:
  //   * Python:  system(, os.system, subprocess, os.popen, os.exec, exec(
  //   * Node:    child_process (+ its destructured import shapes)
  //   * Perl:    IO::Socket, piped open(FH, "| cmd")
  //   * Ruby:    Kernel.exec / Kernel.spawn / Kernel.system, %x{...}, backticks
  //   * generic: TCPSocket, backticks
  // Missing any of these lets `python -c 'import subprocess; subprocess.run(...)'`
  // or `ruby -e 'Kernel.exec("evil")'` sneak past the scanner
  // (kubestellar/console-kb#3493).
  { name: 'Interpreter -c/-e invokes shell primitive', pattern: /\b(?:python\d*|ruby|perl|node|php|deno|bun)\s+(?:-\S+\s+)*-[ceE]\b[\s\S]{0,300}?(?:\bsystem\s*\(|\bos\.system\b|\bsubprocess\b|\bos\.popen\b|\bos\.exec\w*\b|\bexec\s*\(|child_process|IO::Socket|TCPSocket|Kernel\.(?:exec|spawn|system)\b|\bopen\s*\([^)\n]{0,80}["'`]\s*\||`[^`\n]+`|%x\s*[({])/gi },

  // Obfuscation bypass techniques (issue #2693)
  // Base64 decode piped to shell execution
  { name: 'Obfuscation: base64 decode pipe to shell', pattern: /\b(?:base64|openssl\s+(?:enc|base64))\s+(?:-d|-D|--decode)[^|\n]*\|\s*(?:ba)?sh\b/gi },
  { name: 'Obfuscation: echo base64 pipe', pattern: /\becho\s+[^|\n]*\|\s*base64\s+(?:-d|-D|--decode)[^|\n]*\|\s*(?:ba)?sh\b/gi },
  // Printf with escape sequences piped to shell
  { name: 'Obfuscation: printf escape sequences', pattern: /\bprintf\s+["'][^"']*\\x[0-9a-fA-F]{2}[^"']*["'][^|\n]*\|\s*(?:ba)?sh\b/gi },
  // Shell variable construction of interpreter names (e.g., VAR=ba; ${VAR}sh or $VARsh)
  { name: 'Obfuscation: variable shell interpreter', pattern: /(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)(?:bash|sh|zsh|ksh|dash)\b/g },
  { name: 'Obfuscation: concatenated interpreter name', pattern: /["'](?:ba|z|k|da)?["']\s*\+\s*["']sh["']/gi },

  // Crypto mining indicators
  { name: 'Crypto miner reference', pattern: /\b(?:xmrig|cryptonight|stratum\+tcp|minerd|coinhive)\b/gi },
];

// Safe CLI commands that are expected inside $() in mission code snippets.
// Shell interpreters (bash, sh, zsh, ksh) are intentionally excluded: they accept
// a -c flag and can execute arbitrary strings, which would defeat injection detection.
// Fenced code blocks (```bash, ```sh, etc.) are already handled by CODE_FENCE_LANGS.
const SAFE_CLI_COMMANDS = new Set([
  'kubectl', 'helm', 'jq', 'awk', 'grep', 'sed', 'cut', 'tr', 'sort',
  'uniq', 'wc', 'head', 'tail', 'cat', 'echo', 'date', 'basename',
  'dirname', 'xargs', 'find', 'ls', 'yq', 'kustomize', 'istioctl',
  'age', 'sops', 'systemd-run',  // encryption/secret management tools in CNCF docs
  'curl', 'wget', 'podman', 'docker', 'openssl', 'sha256sum', 'md5sum',  // common CNCF doc CLI tools
]);

// Markdown code fence language identifiers — these appear after backticks
// in fenced code blocks and are not commands.
const CODE_FENCE_LANGS = new Set([
  'yaml', 'yml', 'json', 'console', 'bash', 'sh', 'shell', 'zsh',
  'powershell', 'ps1', 'python', 'py', 'go', 'javascript', 'js',
  'typescript', 'ts', 'ruby', 'java', 'c', 'cpp', 'rust', 'toml',
  'ini', 'xml', 'html', 'css', 'sql', 'dockerfile', 'makefile',
  'text', 'plain', 'diff', 'log', 'output',
]);

/**
 * Checks if a matched string only contains safe CLI tool invocations.
 * Returns true if the match should be skipped (is safe).
 */
function isSafeCLIMatch(value) {
  // Extract content inside $(...) blocks
  const subshells = [...value.matchAll(/\$\(([^)\n]+)\)/g)].map(m => m[1].trim());
  if (subshells.length === 0) {
    // For backtick pattern: check all command invocations
    // Remove backticks and normalize whitespace (handles multi-line code blocks)
    const content = value.replace(/^`|`$/g, '').trim();

    // If the content starts with a markdown code fence language identifier
    // followed by a newline, it's a fenced code block — not injection.
    const firstLine = content.split(/\n/)[0].trim().toLowerCase();
    if (CODE_FENCE_LANGS.has(firstLine)) return true;
    
    // Split by command separators (; && ||) to get individual commands
    const segments = content.split(/[\s]*(?:;|&&|\|\|)[\s]*/).map(s => s.trim()).filter(Boolean);
    
    return segments.every(seg => {
      // Extract the first word/command from each segment
      // Handle potential bash redirects and arguments
      const firstWord = seg.split(/[\s\|>]+/)[0].trim();
      // Empty segments are safe (can happen with extra separators)
      return !firstWord || SAFE_CLI_COMMANDS.has(firstWord);
    });
  }
  
  // For $() subshells — skip PowerShell variable access patterns like $variable.Property
  return subshells.every(inner => {
    // PowerShell $variable or $variable.Property is not command injection
    if (/^\$\w+/.test(inner)) return true;

    // Split by command separators to get all commands in the pipeline
    const segments = inner.split(/[\s]*(?:;|&&|\|\|)[\s]*/).map(s => s.trim()).filter(Boolean);
    return segments.every(seg => {
      // Extract the first word from each segment
      const firstWord = seg.split(/[\s\|>]+/)[0].trim();
      return !firstWord || SAFE_CLI_COMMANDS.has(firstWord);
    });
  });
}

/**
 * Decodes base64 content and scans for malicious patterns.
 * Returns findings from decoded content.
 */
function scanBase64DecodedContent(text) {
  const findings = [];
  // Find base64-like strings that might contain encoded commands
  const base64Pattern = /\b[A-Za-z0-9+/]{20,}={0,2}\b/g;
  let match;
  
  while ((match = base64Pattern.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(match[0], 'base64').toString('utf-8');
      // Check if decoded content contains shell commands or suspicious patterns
      const suspiciousPatterns = [
        /\b(?:curl|wget|bash|sh|eval|exec|nc|netcat|chmod|chown)\b/gi,
        /\$\([^)\n]+\)/g,
        /`[^`\n]+`/g,
      ];
      
      for (const pattern of suspiciousPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(decoded)) {
          findings.push({
            type: 'Obfuscation: base64-encoded command',
            value: `${match[0].slice(0, 40)}... → ${decoded.slice(0, 60)}...`,
            context: text.substring(Math.max(0, match.index - 30), match.index + match[0].length + 30).trim(),
          });
          break;
        }
      }
    } catch {
      // Not valid base64 or not UTF-8 — ignore
    }
  }
  
  return findings;
}

/**
 * Scans a parsed mission object for malicious content (XSS, privileged YAML, injection).
 * Returns { findings: Array<{ type, value, context }> }
 */
export function scanForMaliciousContent(mission) {
  const findings = [];
  const text = deepStringValues(mission).join('\n');

  for (const { name, pattern, allowSafeCLI } of MALICIOUS_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // Skip safe CLI tool invocations in mission code snippets
      if (allowSafeCLI && isSafeCLIMatch(match[0])) continue;
      findings.push({
        type: name,
        value: match[0],
        context: text.substring(Math.max(0, match.index - 30), match.index + match[0].length + 30).trim(),
      });
    }
  }

  // Add base64 decode + re-scan for mission fields that execute commands
  const base64Findings = scanBase64DecodedContent(text);
  findings.push(...base64Findings);

  return { findings };
}
