# Postmortem: `pr-verifier.yml` — five `startup_failure` incidents since June 2026, never a retrospective

## Status: ongoing — durable fix blocked on `workflows` permission

Tracked in [#3348](https://github.com/kubestellar/console-kb/issues/3348) (this
retrospective) and [#3336](https://github.com/kubestellar/console-kb/issues/3336)
(current active outage).

## Summary

`pr-verifier.yml`'s reusable-workflow call has failed with `startup_failure`
(rejected at parse time, zero jobs ever created, no step logs) in **five**
separate recorded incidents since 2026-06-29. Every PR opened, edited,
synced, or reopened during each outage window received **zero** verifier
feedback (title/label conformance checks silently disabled), with no alert
distinguishing this from a healthy "no issues found" result. Each incident
was closed as an isolated point-fix; none produced a postmortem, so the
same class of regression — an unpinned or mismatched
`kubestellar/infra` reusable-workflow reference — has recurred five times
over roughly ten weeks with no compounding safeguard added after any of the
first four fixes.

## Impact

- **User-facing effect:** none for Console KB end users; impact is entirely
  on contributor experience and PR-hygiene enforcement — PR title/label
  conformance checks silently stopped running during each outage window.
- **Duration:** cumulative across five incidents (see Timeline); the
  current (fifth) outage alone has run **12+ consecutive days** as of
  2026-09-11/12 (100+ runs, 0 jobs ever created), confirmed still failing.
- **Scope:** internal only — `pr-verifier.yml` in `kubestellar/console-kb`.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-06-29 | Incident 1 filed as #2704: `pr-verifier.yml` calls a `reusable-pr-verifier.yml` that does not exist in `kubestellar/infra` at the pinned ref — PR title check disabled. Closed same day. |
| 2026-07-06 | Incident 2 filed as #2780: same failure signature (reusable target missing) recurs. Closed same day. |
| 2026-07-13 | Incident 3 filed as #2883: `startup_failure` specifically on Dependabot `pull_request_target` runs, zero jobs created. Closed same day. |
| 2026-08-07 | Incident 4 filed as #2975: same failure signature again — reusable target missing, 100% failure rate. Closed same day. |
| 2026-08-26 | A security-hardening PR (#3022) repins `pr-verifier.yml` and eight sibling reusable-workflow callers to `kubestellar/infra` SHA `1a04a3fd` (see the sibling postmortem, `postmortem-2026-08-stale-workflow-startup-failure.md`, for the `stale.yml`-specific consequences of this same repin). |
| 2026-08-29 – 2026-08-30 | `stale.yml` incident (separate postmortem) triggers a repo-wide pin audit; #3071 finds 9 files still on the stale `1a04a3fd` SHA. 5 of 9 are repinned by #3074; `pr-verifier.yml` is one of 4 files left on the stale pin as a residual follow-up. |
| 2026-08-30 onward | Incident 5 (current, ongoing): `pr-verifier.yml` begins failing `startup_failure` on the stale `1a04a3fd` pin. Confirmed still failing as of 2026-09-11/12 across 100+ consecutive runs, 0 jobs ever created. |
| 2026-09-11 | Incident 5 filed as an active issue, #3336. |
| 2026-09-12 | This retrospective filed (#3348) after noticing incidents 1–4 were each closed without a postmortem, despite sharing the same failure signature as incident 5. |

## Root cause

All five incidents share one underlying pattern: `pr-verifier.yml` calls a
reusable workflow (`kubestellar/infra/.github/workflows/reusable-pr-verifier.yml`)
by a pinned ref, and GitHub Actions validates that call's interface
(existence of the target, and its `on.workflow_call` `inputs`/`secrets`
contract) at parse time — before any step runs. Any drift between the pin
and the callee (the callee file not existing at that ref, or its declared
interface changing) causes an immediate, silent `startup_failure` with no
step-level diagnostics. This repo has hit that failure mode via at least two
distinct triggers — a missing/renamed callee file (incidents 1, 2, 4) and a
stale pin left behind by a partial repin sweep (incident 5, and the sibling
`stale.yml` incident) — but every fix targeted the specific symptom of that
incident rather than adding a safeguard against the *class* of regression
(e.g., a scheduled check that all `uses: kubestellar/infra/...@<sha>`
references across this repo's workflows resolve to an existing file with a
compatible `on.workflow_call` interface). No such check exists today, so
the same failure mode remains free to recur a sixth time.

## What went well

- Each individual incident was detected and fixed reasonably quickly once
  someone looked (same-day turnaround for incidents 1–4).
- The `stale.yml` incident (2026-08-27 to 2026-08-30) did produce a proper
  postmortem and did trigger a repo-wide pin audit (#3071) that correctly
  flagged `pr-verifier.yml` as still at risk — the audit's finding was
  accurate; the fix for that specific file just hadn't landed yet
  (blocked on `workflows` permission) when incident 5 began.

## What went poorly

- **No postmortem for four of five incidents.** Incidents 1–4 were each
  closed as a same-day point-fix with no retrospective asking why the same
  workflow, specifically, keeps hitting this failure class more than any
  other reusable-workflow caller in the repo.
- **No regression safeguard added after any fix.** Every incident's
  remediation repinned or corrected the one broken reference without adding
  a check that would catch the *next* drift automatically (e.g., a
  scheduled job that validates all reusable-workflow pins in this repo
  resolve and match their callee's declared interface).
  `runbooks/incident-response-scheduled-workflow-failure.md` covers
  detecting a *scheduled* workflow's silent failure, but `pr-verifier.yml`
  is `pull_request_target`-triggered, not scheduled, so it falls outside
  that runbook's scope entirely — there has never been a detection
  mechanism specific to this workflow's failure mode.
- **The fifth incident was foreseeable and specifically flagged in advance**
  (#3071 named `pr-verifier.yml` as one of 4 files left on the stale pin on
  2026-08-30) but the fix still did not land before the predicted failure
  began, because it requires `workflows` permission no current hive agent
  credential set has — the same blocker that has stalled the fix for 12+
  days since.

## Action items

| Action | Owner | Tracking issue |
|--------|-------|----------------|
| Repin `pr-verifier.yml`'s `uses:` SHA to match sibling repos' baseline | unassigned — requires `workflows` permission no current hive agent credential set has | #3336 |
| Add a scheduled check that validates every `uses: kubestellar/infra/...@<sha>` reference in this repo's workflows resolves and matches its callee's declared `on.workflow_call` interface, so a stale/broken pin is caught before (or immediately after) it starts failing, independent of any one workflow's own trigger type | unassigned — requires `workflows` permission no current hive agent credential set has | #3348 (this retrospective) |
| Write this retrospective covering all five incidents as one document, and index it in both operational-runbook tables | operations (done) | #3348 |

## Lessons for prevention

When a workflow's failure signature repeats (same error class, same file,
different calendar month), treat the *second* occurrence as a signal to
write a retrospective and look for a class-level safeguard, not just a
class-level point-fix — closing each incident same-day without ever asking
"why does this specific file keep breaking" is how a five-time recurrence
went ten weeks without anyone proposing a pin-consistency check. A
reusable-workflow `startup_failure` is a caller/callee interface mismatch,
not a runtime bug (see the sibling `stale.yml` postmortem's "Lessons for
prevention" section for the diagnostic approach), but detecting it before
it starts failing requires checking the pin's validity proactively —
reacting to each failure as it happens will keep finding this same failure
mode indefinitely.
