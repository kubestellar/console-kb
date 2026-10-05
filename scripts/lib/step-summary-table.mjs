/**
 * Shared "## <title>\n\n| Metric | Value |\n|--------|-------|\n..." markdown
 * table builder for in-process scripts that mirror a bounded run summary
 * into `$GITHUB_STEP_SUMMARY`.
 *
 * GITHUB_STEP_SUMMARY is an environment variable the Actions runner sets
 * for every job step; writing to it needs no `.github/workflows/*.yml`
 * change. build-index.mjs and score-and-merge-mission-prs.mjs each grew an
 * identical copy of the table-building + conditional-append logic below
 * (see console-kb#3630 for the analogous, previously-fixed split between
 * render-ci-step-summary.mjs and render-step-summary.mjs, and
 * console-kb#3684 for this in-process variant). This module is the single
 * shared implementation both now call.
 *
 * Deliberately NOT the same thing as render-ci-step-summary.mjs: that is a
 * standalone CLI invoked as an extra workflow step (reads a log from
 * stdin); this is a plain importable function for scripts that already
 * build their own summary fields in-process and append them directly,
 * without any separate workflow step.
 */

/**
 * Builds the markdown table body (not including the surrounding newline),
 * e.g.:
 *
 *   ## 📇 Mission Index Build Summary
 *
 *   | Metric | Value |
 *   |--------|-------|
 *   | Files scanned | 42 |
 *
 * @param {string} title - Heading text, including any leading emoji.
 * @param {Array<[string, string|number]>} rows - Ordered (label, value) pairs.
 * @returns {string} The rendered markdown, terminated by a single newline.
 */
export function buildStepSummaryTable(title, rows) {
  const lines = [
    `## ${title}`,
    '',
    '| Metric | Value |',
    '|--------|-------|',
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Appends the table from {@link buildStepSummaryTable} to
 * `env.GITHUB_STEP_SUMMARY`, when set. No-op otherwise (e.g. local runs,
 * unit tests that don't set the var).
 *
 * `env` and `appendFile` are injectable so callers' existing tests can keep
 * driving this in-process without a real $GITHUB_STEP_SUMMARY file.
 */
export function appendStepSummaryTable(
  title,
  rows,
  { env = process.env, appendFile } = {},
) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  appendFile(env.GITHUB_STEP_SUMMARY, buildStepSummaryTable(title, rows), 'utf8');
}
