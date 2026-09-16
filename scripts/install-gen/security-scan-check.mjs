#!/usr/bin/env node
// Extracted from the "Review: Security scan" step of
// .github/workflows/cncf-install-gen.yml (see kubestellar/console-kb#3164).
// Scans a single mission file for sensitive/malicious content findings.
//
// Reads the target file path from the FILE env var instead of interpolating
// it directly into inline JS source, removing a script-injection surface.
import { readFileSync } from 'fs';
import { scanMissionFile } from '../scanner.mjs';

const file = process.env.FILE;
if (!file) {
  console.error('FILE env var is required');
  process.exit(2);
}

const r = scanMissionFile(readFileSync(file, 'utf-8'));
const s = r.scan?.sensitive?.findings?.length || 0;
const m = r.scan?.malicious?.findings?.length || 0;

if (s + m > 0) {
  console.log(`FAIL:${s} sensitive, ${m} malicious`);
  process.exit(1);
} else {
  console.log('PASS');
}
