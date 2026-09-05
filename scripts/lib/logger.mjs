/**
 * Minimal structured logger for CI/CLI scripts.
 *
 * Emits one bounded JSON line per event to stderr (level, timestamp,
 * component, message, and a small set of caller-supplied fields) so that
 * CI log tooling can parse pipeline events mechanically. Human-readable
 * console.log output on stdout is left untouched by design — this is an
 * additive, local-only helper with no network calls, no external
 * dependencies, and no secret values.
 *
 * Field values are not free-form: callers pass primitives (strings,
 * numbers, booleans) as fields, keeping cardinality bounded and avoiding
 * accidental high-cardinality or sensitive data in log output.
 */

const LEVELS = ['debug', 'info', 'warn', 'error']

function sanitizeFields(fields) {
  const safe = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      safe[key] = value
    }
  }
  return safe
}

export function createLogger(component) {
  function emit(level, message, fields) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      component,
      message,
      ...sanitizeFields(fields),
    }
    process.stderr.write(`${JSON.stringify(entry)}\n`)
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}

export const LOG_LEVELS = LEVELS
