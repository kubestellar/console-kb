/**
 * Single declaration site for the "shell/interpreter" alternation used by
 * every dangerous-pipe check in the repo (kubestellar/console-kb#3758).
 *
 * Before this module existed, `scripts/scanner/malicious.mjs` and
 * `scripts/mission-safety-scan.mjs` each hardcoded their own copy of "which
 * interpreters can a downloaded script be piped into". The two copies
 * drifted: `scanner/malicious.mjs` was broadened to 17 interpreters across
 * #3493 and #2693 (after `| zsh`/`| python`/`| pwsh` payloads were found to
 * bypass a bash/sh-only check), but `mission-safety-scan.mjs` — the actual
 * CI gate that reviews human-submitted PRs under `fixes/**`, `runbooks/**`,
 * `solutions/**` — was never updated and had no `wget` check at all.
 *
 * Both call sites now build their curl/wget-pipe regex from this one list,
 * so a future hardening pass only has to land here once.
 */

/** Interpreters a downloaded script can be piped into to execute it. */
export const SHELL_INTERPRETERS =
  'bash|sh|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|python\\d*|perl|ruby|node|php|deno|bun'

/** Matches `curl ... | <interpreter>`. */
export const CURL_PIPE_TO_SHELL = new RegExp(
  `curl\\s[^|\\n]*\\|\\s*(?:${SHELL_INTERPRETERS})\\b`,
  'gi',
)

/** Matches `wget ... | <interpreter>`. */
export const WGET_PIPE_TO_SHELL = new RegExp(
  `wget\\s[^|\\n]*\\|\\s*(?:${SHELL_INTERPRETERS})\\b`,
  'gi',
)
