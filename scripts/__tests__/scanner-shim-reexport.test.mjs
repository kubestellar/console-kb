import { describe, it, expect } from 'vitest';

import * as shim from '../scanner.mjs';
import * as impl from '../scanner/index.mjs';

describe('scripts/scanner.mjs re-export shim (console-kb#3195)', () => {
  it('re-exports every named export from scanner/index.mjs by identity', () => {
    const implKeys = Object.keys(impl).sort();
    const shimKeys = Object.keys(shim).sort();

    expect(shimKeys).toEqual(implKeys);
    for (const key of implKeys) {
      expect(shim[key]).toBe(impl[key]);
    }
  });

  it('exposes the documented public surface used by workflows, generators and tests', () => {
    for (const name of [
      'validateMissionExport',
      'scanForSensitiveData',
      'scanForMaliciousContent',
      'formatScanResultAsMarkdown',
      'fullScan',
      'scanMissionFile',
    ]) {
      expect(typeof shim[name]).toBe('function');
    }
  });
});
