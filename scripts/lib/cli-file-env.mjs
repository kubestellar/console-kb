/**
 * Shared "read target file path from FILE env var, or fail loudly" guard
 * used by the install-gen single-mission-file review scripts invoked from
 * `.github/workflows/cncf-install-gen.yml`'s per-file review loop.
 *
 * Each of `install-gen/extract-commands.mjs`, `extract-freshness-info.mjs`,
 * `section-completeness.mjs`, and `security-scan-check.mjs` reads the
 * target file path from the FILE env var instead of interpolating it
 * directly into inline JS source, removing a script-injection surface —
 * and all four previously reimplemented the same env-var-missing check.
 */

/**
 * Return `process.env.FILE`, or log an error via `log` and exit the
 * process with code 2 if it is unset/empty.
 *
 * @param {object} log - logger with an `error(message)` method, e.g. from
 *   `createLogger` in `./logger.mjs`
 * @param {object} [options]
 * @param {function(number):void} [options.exit=process.exit] - injectable
 *   for in-process testing
 * @returns {string} the FILE env var value
 */
export function requireFileEnv(log, { exit = process.exit } = {}) {
  const file = process.env.FILE;
  if (!file) {
    log.error('FILE env var is required');
    exit(2);
  }
  return file;
}
