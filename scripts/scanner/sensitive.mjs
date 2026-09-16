/**
 * Sensitive-data detection (IPs, secrets, tokens, certs) for mission content.
 * Extracted from scripts/scanner.mjs (console-kb#3195).
 */

import { deepStringValues } from './scan-utils.mjs';

const SENSITIVE_PATTERNS = [
  { name: 'IPv4 address', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { name: 'IPv6 address', pattern: /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}/g },
  { name: 'JWT / Bearer token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'Bearer token header', pattern: /[Bb]earer\s+[A-Za-z0-9_\-.~+/]+=*/g },
  { name: 'GitHub PAT (classic)', pattern: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: 'GitHub PAT (fine-grained)', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { name: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*\S+/gi },
  { name: 'PEM certificate / key', pattern: /-----BEGIN\s(?:RSA\s)?(?:PRIVATE\sKEY|CERTIFICATE|PUBLIC\sKEY)-----/g },
  { name: 'Generic secret assignment', pattern: /(?:password|secret|token|api_key|apikey)\s*[=:]\s*["'][^"']{8,}["']/gi },
  { name: 'Base64-encoded long blob', pattern: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g },
];

// IPs to ignore (common examples / documentation ranges)
const SAFE_IPS = new Set([
  '0.0.0.0', '127.0.0.1', '255.255.255.255',
  '10.0.0.1', '192.168.1.1', '172.16.0.1',
]);

/**
 * Scans a parsed mission object for sensitive data (IPs, secrets, tokens, certs).
 * Returns { findings: Array<{ type, value, context }> }
 */
export function scanForSensitiveData(mission) {
  const findings = [];
  const text = deepStringValues(mission).join('\n');

  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0];
      // Skip safe/example IPs
      if (name === 'IPv4 address' && SAFE_IPS.has(value)) continue;
      findings.push({
        type: name,
        value: value.length > 80 ? value.slice(0, 77) + '...' : value,
        context: text.substring(Math.max(0, match.index - 30), match.index + value.length + 30).trim(),
      });
    }
  }

  return { findings };
}
