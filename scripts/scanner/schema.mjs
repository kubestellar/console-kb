/**
 * Schema validation for kc-mission-v1 exports.
 * Extracted from scripts/scanner.mjs (console-kb#3195).
 */

const REQUIRED_FIELDS = ['version', 'name', 'mission'];
const VALID_VERSIONS = ['kc-mission-v1'];

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
