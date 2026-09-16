/**
 * Mission scanner — barrel module wiring together schema validation,
 * sensitive/malicious content scanning, YAML fallback parsing, and report
 * formatting into the file-level orchestration functions.
 *
 * Split out of the former monolithic scripts/scanner.mjs (console-kb#3195).
 * scripts/scanner.mjs remains as a thin re-export shim so existing imports
 * keep working unchanged.
 */

import { validateMissionExport } from './schema.mjs';
import { scanForSensitiveData } from './sensitive.mjs';
import { scanForMaliciousContent } from './malicious.mjs';
import { tryParseYamlSimple } from './yaml-fallback.mjs';
import { formatScanResultAsMarkdown } from './format.mjs';

export { validateMissionExport } from './schema.mjs';
export { scanForSensitiveData } from './sensitive.mjs';
export { scanForMaliciousContent } from './malicious.mjs';
export { formatScanResultAsMarkdown } from './format.mjs';

/**
 * Runs both sensitive-data and malicious-content scans.
 * Returns { sensitive: {...}, malicious: {...} }
 */
export function fullScan(mission) {
  return {
    sensitive: scanForSensitiveData(mission),
    malicious: scanForMaliciousContent(mission),
  };
}

/**
 * Parses a JSON or YAML string, validates schema, and runs full scan.
 * Returns { parsed, schema, scan, error? }
 */
export function scanMissionFile(content) {
  let parsed;

  // Try JSON first, then YAML
  try {
    parsed = JSON.parse(content);
  } catch {
    try {
      // Dynamic import is messy in sync context; try simple YAML parse
      // For YAML support the caller should pre-parse or this falls back
      const yamlLike = tryParseYamlSimple(content);
      if (yamlLike) {
        parsed = yamlLike;
      } else {
        return { parsed: null, schema: null, scan: null, error: 'Failed to parse as JSON or YAML' };
      }
    } catch {
      return { parsed: null, schema: null, scan: null, error: 'Failed to parse as JSON or YAML' };
    }
  }

  const schema = validateMissionExport(parsed);
  const scan = fullScan(parsed);

  return { parsed, schema, scan, error: null };
}
