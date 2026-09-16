/**
 * Shared helpers used by both the sensitive-data and malicious-content scans.
 * Extracted from scripts/scanner.mjs (console-kb#3195).
 */

/**
 * Flattens all string values found anywhere inside `obj` (recursively
 * walking arrays and plain objects) into a single array.
 */
export function deepStringValues(obj) {
  const values = [];
  const stack = [obj];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') {
      values.push(item);
    } else if (Array.isArray(item)) {
      stack.push(...item);
    } else if (item && typeof item === 'object') {
      stack.push(...Object.values(item));
    }
  }
  return values;
}
