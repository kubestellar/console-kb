import { describe, it, expect } from 'vitest';

import * as shim from '../../sources/llm-synthesizer.mjs';
import * as impl from '../../sources/llm-synthesizer/index.mjs';

describe('scripts/sources/llm-synthesizer.mjs re-export shim (console-kb#3196)', () => {
  it('re-exports every named export from llm-synthesizer/index.mjs by identity', () => {
    const implKeys = Object.keys(impl).sort();
    const shimKeys = Object.keys(shim).sort();

    expect(shimKeys).toEqual(implKeys);
    for (const key of implKeys) {
      expect(shim[key]).toBe(impl[key]);
    }
  });

  it('exposes the documented public surface consumed by base-source.mjs and tests', () => {
    expect(typeof shim.synthesizeMission).toBe('function');
    expect(typeof shim.sleep).toBe('function');
  });
});
