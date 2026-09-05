// Minimal structured logging helper for CI batch scripts.
// Emits a single JSON-payload line per event so GitHub Actions logs stay
// both human-scannable and machine-parseable — no external backend required.
const VALID_LEVELS = new Set(['info', 'warn', 'error']);

export function logEvent(event, fields = {}) {
  const { level = 'info', ...rest } = fields;
  const record = { ts: new Date().toISOString(), event, ...rest };
  const line = `[kb] ${JSON.stringify(record)}`;
  const resolvedLevel = VALID_LEVELS.has(level) ? level : 'info';

  if (resolvedLevel === 'error') {
    console.error(line);
  } else if (resolvedLevel === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
