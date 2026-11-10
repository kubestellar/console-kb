/**
 * Schema validation for kc-mission-v1 exports.
 * Extracted from scripts/scanner.mjs (console-kb#3195).
 */

const REQUIRED_FIELDS = ['version', 'name', 'mission'];
const VALID_VERSIONS = ['kc-mission-v1'];
const RFC1123_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAMESPACE_FLAG = /(?:^|\s)(?:-n|--namespace)[ =]([^\s`"'\\]+)/g;

/**
 * Validates that `data` conforms to the kc-mission-v1 export schema.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateMissionExport(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Input is not an object'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in data)) {
      errors.push(`Missing required field: "${field}"`);
    }
  }

  if (data.version && !VALID_VERSIONS.includes(data.version)) {
    errors.push(`Invalid version "${data.version}". Expected one of: ${VALID_VERSIONS.join(', ')}`);
  }

  if (data.name && typeof data.name !== 'string') {
    errors.push('"name" must be a string');
  }

  if (data.mission) {
    if (typeof data.mission !== 'object') {
      errors.push('"mission" must be an object');
    } else {
      if (!data.mission.title || typeof data.mission.title !== 'string') {
        errors.push('"mission.title" is required and must be a string');
      }
      if (!data.mission.steps || !Array.isArray(data.mission.steps)) {
        errors.push('"mission.steps" is required and must be an array');
      }
      if (Array.isArray(data.mission.steps)) {
        const badNamespaces = new Set();
        for (const step of data.mission.steps) {
          const text = `${step?.description ?? ''}`;
          for (const m of text.matchAll(NAMESPACE_FLAG)) {
            if (!m[1].startsWith('$') && !/^<[^<>]+>$/.test(m[1]) && !RFC1123_LABEL.test(m[1])) badNamespaces.add(m[1]);
          }
        }
        for (const ns of badNamespaces) {
          errors.push(`Invalid namespace "${ns}" in step command (must be an RFC 1123 label)`);
        }
      }
    }
  }

  if (data.tags && !Array.isArray(data.tags)) {
    errors.push('"tags" must be an array');
  }

  if (data.compatibility) {
    if (typeof data.compatibility !== 'object') {
      errors.push('"compatibility" must be an object');
    }
  }

  return { valid: errors.length === 0, errors };
}
