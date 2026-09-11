# Postmortem: `stale.yml` (and sibling reusable-workflow callers) `startup_failure`

## Summary

A security-hardening PR repinned `.github/workflows/stale.yml` (and eight
other reusable-workflow callers) to a `kubestellar/infra` SHA whose
`reusable-stale.yml` no longer declared a `secrets:` input contract. Passing
the now-undeclared `secrets.token` caused GitHub Actions to reject the
workflow at parse time (`startup_failure`) before any step ran. The daily
`Stale Issues` sweep (and, at times, `add-help-wanted.yml`) silently stopped
running for up to three days with no automated alert.

## Impact

- **User-facing effect:** none directly for Console KB end users (this
  workflow only labels/closes stale GitHub issues repo-wide); the impact was
  entirely on repository maintenance hygiene — stale issues stopped being
  swept.
- **Duration:** regression landed 2026-08-26T12:19Z (PR #3022 merge); first
  confirmed `startup_failure` run 2026-08-27; detected and filed
  2026-08-29T01:22Z; mitigated 2026-08-29T02:18Z (~2 days 14 hours from
  regression to fix, ~2 days from first failure to fix). A related
  pin-consistency gap affecting `add-help-wanted.yml` and 7 other callers
  persisted until 2026-08-30T02:35Z (partial) / follow-up tracked
  separately.
- **Scope:** internal only — `stale.yml` and `add-help-wanted.yml` in
  `kubestellar/console-kb`. Not the mission-catalog publish pipeline covered
  by `docs/slo.md`.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-08-26T12:19Z | PR #3022 ("fix: address security findings in workflow files") merged, repinning reusable-workflow callers to `kubestellar/infra` SHA `1a04a3fd`, whose `reusable-stale.yml` declares only `inputs:` (no `secrets:` block) |
| 2026-08-26T00:19Z | Last successful `stale.yml` run before the regression (predates the merge; next scheduled run was the first to hit the new pin) |
| 2026-08-27 – 2026-08-29 | 3 consecutive nightly `stale.yml` runs fail with `startup_failure` (runs 33031314050, 33138192299, 33224222564) — GitHub Actions rejects the undeclared `secrets.token` input at parse time, before any job step executes, so the run log has no diagnostic step output |
| 2026-08-29T01:22Z | Incident detected and filed as #3057 (root cause identified by inspecting the caller/callee reusable-workflow schemas, since `startup_failure` itself carries no diagnostic output) |
| 2026-08-29T02:18Z | PR #3058 merged: removed the invalid `secrets: token: ${{ secrets.GITHUB_TOKEN }}` block from `stale.yml`'s call to `reusable-stale.yml` — 2-line diff, no other behavioral change |
| 2026-08-30T01:17Z | Follow-up #3071 filed: 9 workflow files repo-wide (including `stale.yml` itself, already fixed by #3058 for the secrets issue but still on the stale SHA) remained pinned at the same stale `1a04a3fd` SHA; 2 of them (`add-help-wanted.yml`, `stale.yml`) were still intermittently hitting `startup_failure` |
| 2026-08-30T02:35Z | PR #3074 merged: repinned 5 of the 9 files (`add-help-wanted.yml`, `ai-fix.yml`, `copilot-automation.yml`, `scorecard.yml`, `stale.yml`) to `220beeeb`, the SHA already in use by sibling repos (`console-marketplace`, `kubestellar-mcp`, `homebrew-tap`, `docs`), and converted their `secrets: token: ...` blocks to `secrets: inherit` to match the sibling-repo baseline |
| 2026-08-30T03:40Z | #3071 closed; 4 remaining SHA-only updates (`assignment-helper.yml`, `copilot-dco.yml`, `greetings.yml`, `pr-verifier.yml`) tracked as a residual follow-up in the issue |

## Root cause

`kubestellar/infra`'s `reusable-stale.yml` was updated (or the caller's pin
was moved to a commit) such that the reusable workflow's declared interface
no longer included a `secrets:` block — it uses `github.token` internally by
default and declares `permissions: issues: write` itself. `console-kb`'s
`stale.yml` caller, however, still passed `secrets: token: ${{
secrets.GITHUB_TOKEN }}`. GitHub Actions validates a reusable-workflow call
against the callee's declared `on.workflow_call` interface at parse time,
before any job runs; passing an undeclared secret causes the entire run to
be rejected as `startup_failure` rather than fail inside a step. This is
*why* the failure was silent and low-signal: `startup_failure` runs produce
no step logs, so the only way to find the root cause was to diff the
caller's `secrets:` block against the pinned callee's `on.workflow_call`
schema directly — grepping run logs for an error string does not work for
this failure mode.

The safeguard that should have caught this — the `stale.yml`/reusable-pin
change landing via a reviewed PR (#3022) — did apply (this wasn't a direct
push), but the review focused on the security-hardening intent (removing
excess token permissions) and did not catch that the accompanying SHA bump
silently broke the caller/callee secrets contract. There was, and at time of
writing still is, no automated alert on a scheduled workflow's *own* job
failing (see `runbooks/incident-response-scheduled-workflow-failure.md`);
detection depended entirely on a maintainer or agent proactively checking
the Actions tab, which is why 3 consecutive nightly failures elapsed before
filing.

## What went well

- Root cause was correctly diagnosed from schema inspection alone despite
  `startup_failure`'s lack of diagnostic step output.
- The fix (#3058) was minimal and surgical: a 2-line removal, no behavioral
  change to the reusable workflow's actual stale-issue logic.
- The follow-up scan (#3071) proactively found the same latent risk in 7
  additional workflow files pinned to the same stale SHA, rather than
  stopping at the 1 file that had already failed — catching
  `add-help-wanted.yml`'s active `startup_failure` and 7 more files with the
  same latent exposure before they broke too.

## What went poorly

- No automated signal (issue/comment/notification) fired when `stale.yml`
  first hit `startup_failure` on 2026-08-27; the gap persisted for 3
  consecutive nightly runs before a human/agent noticed and filed #3057.
  This gap is still open today — see
  [`runbooks/incident-response-scheduled-workflow-failure.md`](./incident-response-scheduled-workflow-failure.md)
  and `docs/slo.md`'s "Follow-up not covered by this document" section for
  the tracked (but not yet implemented, due to `workflows`-permission
  constraints on hive agent credentials) fix.
- The initial repin (#3022) touched 9+ reusable-workflow callers as part of
  a broader security-hardening change but did not verify each callee's
  actual `on.workflow_call` interface before landing, so the same
  caller/callee mismatch was latent in multiple files simultaneously rather
  than being caught and fixed once.
- The full remediation took two separate PRs (#3058 for the immediate
  `stale.yml` break, then #3074 for the wider pin-consistency sweep) plus a
  residual 4-file follow-up, indicating the initial fix was scoped to "stop
  the alarm" rather than "align this repo's reusable-workflow pins with the
  sibling-repo baseline" from the start.

## Action items

| Action | Owner | Tracking issue |
|--------|-------|----------------|
| Remove invalid `secrets:` block from `stale.yml` | scanner (done) | #3058 (merged) |
| Repin `add-help-wanted.yml`, `ai-fix.yml`, `copilot-automation.yml`, `scorecard.yml` to `220beeeb` + `secrets: inherit` | scanner (done) | #3074 (merged) |
| Repin remaining `assignment-helper.yml`, `copilot-dco.yml`, `greetings.yml`, `pr-verifier.yml` to the same SHA | unassigned | #3071 (residual, closed — verify current pins before reopening) |
| Add automated alert when a scheduled workflow's own job fails (`if: failure()` step or equivalent) | unassigned — requires `workflows` permission no current hive agent credential set has | tracked in `docs/slo.md` / `runbooks/incident-response-scheduled-workflow-failure.md` |

## Lessons for prevention

`startup_failure` on a reusable-workflow call is a caller/callee interface
mismatch, not a runtime bug — when investigating a `startup_failure` with no
step logs, diff the caller's `with:`/`secrets:` block against the pinned
callee's `on.workflow_call.inputs`/`secrets` declaration at that exact SHA,
rather than searching for a step-level error. Any PR that repins a
reusable-workflow SHA should be checked against that callee's interface at
the new SHA, not just against the previous pin's interface — the "Detect
Changed KB Entries"-style pathspec gaps documented elsewhere in this
repo's `docs/slo.md` are a different mechanism but the same underlying
class of risk (a change validated in isolation without re-checking its
full downstream contract). Until the automated failure-alert in
`runbooks/incident-response-scheduled-workflow-failure.md` lands, periodic
manual checks of scheduled-workflow run history (per that runbook) remain
the only detection mechanism for this failure class.
