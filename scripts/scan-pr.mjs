#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { scanMissionFile, formatScanResultAsMarkdown } from './scanner.mjs';

const files = process.argv.slice(2);

if (files.length === 0) {
  console.log('No mission files to scan.');
  process.exit(0);
}

let hasFailures = false;
const sections = ['## 🔍 Mission Scan Results\n'];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    sections.push(`### 📄 \`${file}\`\n\n❌ **Error:** Could not read file: ${err.message}\n`);
    hasFailures = true;
    continue;
  }

  const result = scanMissionFile(content);
  sections.push(formatScanResultAsMarkdown(file, result));

  if (result.error) {
    hasFailures = true;
  } else {
    if (!result.schema.valid) hasFailures = true;
    if (result.scan.malicious.findings.length > 0) hasFailures = true;
  }
}

const report = sections.join('\n\n');
writeFileSync('scan-results.md', report, 'utf8');
console.log(report);

if (hasFailures) {
  console.error('\n❌ Scan completed with failures.');
  process.exit(1);
} else {
  console.log('\n✅ All missions passed scanning.');
  process.exit(0);
}
