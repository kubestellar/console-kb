#!/usr/bin/env node
// Extracted from the "Merge reports" step of .github/workflows/cncf-install-gen.yml
// (see kubestellar/console-kb#3164). Prints the average quality score across
// all generated install missions, or 0 if none have a recorded score.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const dir = 'fixes/cncf-install';
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '.gitkeep');
const scores = files
  .map((f) => {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      return d.metadata?.qualityScore || d.qualityScore || 0;
    } catch {
      return 0;
    }
  })
  .filter((s) => s > 0);

console.log(scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0);
