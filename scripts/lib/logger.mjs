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
 *
 * `summary()` is a second, narrower emit path for scripts (e.g.
 * `validate-schema.mjs`) that need a single end-of-run JSON line on
 * *stdout* rather than per-event lines on stderr, matching the shape
 * already relied on by existing CI log parsing (`{ event, ...fields }`,
 * no added `ts`/`component`/`message` wrapper). It exists so those
 * scripts can share this helper instead of re-implementing their own
 * one-line JSON emitter.
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

  function summary(event, fields) {
    process.stdout.write(`${JSON.stringify({ event, ...sanitizeFields(fields) })}\n`)
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    summary,
  }
}

export const LOG_LEVELS = LEVELS
