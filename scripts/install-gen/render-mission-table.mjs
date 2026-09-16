#!/usr/bin/env node
// Extracted from the duplicated "Post Kind test summary" / "Determine final
// action" markdown-table rendering blocks in
// .github/workflows/cncf-install-gen.yml (see kubestellar/console-kb#3164).
// Renders a markdown table row per mission execution result.
//
// Reads the report path from the REPORT_PATH env var (defaults to
// mission-execution-report.json, matching both call sites' prior behavior).
// LABEL_LEN controls the mission label truncation length, since the two
// original call sites used different lengths (50 and 60).
import { readFileSync } from 'fs';

const reportPath = process.env.REPORT_PATH || 'mission-execution-report.json';
const labelLen = Number(process.env.LABEL_LEN || '60');
const r = JSON.parse(readFileSync(reportPath, 'utf-8'));

for (const m of r.results) {
  const icon = { pass: '✅', partial: '⚠️', pass_unverified: '⚠️', fail: '❌', error: '💥' }[m.verdict] || '❓';
  const dur = m.duration_ms ? (m.duration_ms / 1000).toFixed(1) + 's' : '-';
  console.log('| ' + (m.mission || m.file).slice(0, labelLen) + ' | ' + icon + ' ' + m.verdict + ' | ' + dur + ' |');
}
