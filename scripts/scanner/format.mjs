/**
 * Markdown report formatting for scan results (used in PR comments).
 * Extracted from scripts/scanner.mjs (console-kb#3195).
 */

/**
 * Formats a scan result as a markdown section for PR comments.
 */
export function formatScanResultAsMarkdown(filename, result) {
  const lines = [];
  lines.push(`### 📄 \`${filename}\``);
  lines.push('');

  if (result.error) {
    lines.push(`❌ **Parse error:** ${result.error}`);
    return lines.join('\n');
  }

  // Schema validation
  if (result.schema.valid) {
    lines.push('✅ **Schema:** Valid kc-mission-v1');
  } else {
    lines.push('❌ **Schema errors:**');
    for (const err of result.schema.errors) {
      lines.push(`  - ${err}`);
    }
  }
  lines.push('');

  // Sensitive data
  const sensitiveCount = result.scan.sensitive.findings.length;
  if (sensitiveCount === 0) {
    lines.push('✅ **Sensitive data:** None detected');
  } else {
    lines.push(`⚠️ **Sensitive data:** ${sensitiveCount} finding(s)`);
    lines.push('');
    lines.push('| Type | Value |');
    lines.push('|------|-------|');
    for (const f of result.scan.sensitive.findings) {
      const escapedValue = f.value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
      lines.push(`| ${f.type} | \`${escapedValue}\` |`);
    }
  }
  lines.push('');

  // Malicious content
  const maliciousCount = result.scan.malicious.findings.length;
  if (maliciousCount === 0) {
    lines.push('✅ **Security:** No malicious content detected');
  } else {
    lines.push(`🚨 **Security:** ${maliciousCount} finding(s)`);
    lines.push('');
    lines.push('| Type | Match |');
    lines.push('|------|-------|');
    for (const f of result.scan.malicious.findings) {
      const escapedValue = f.value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
      lines.push(`| ${f.type} | \`${escapedValue}\` |`);
    }
  }

  return lines.join('\n');
}
