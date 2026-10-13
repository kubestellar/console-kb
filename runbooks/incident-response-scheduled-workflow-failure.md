# Incident Response: Scheduled/Publish Workflow Job Failure

## Scope

This runbook covers the case where the *job itself* fails outright (not a
bad-but-green publish) in one of the workflows that generate or gate the
published mission catalog, plus (see the dedicated section below) the same
failure mode in event-triggered reusable-workflow callers like
`pr-verifier.yml`:

| Workflow | Schedule | Role |
|----------|----------|------|
| `Build Mission Index` (`.github/workflows/build-index.yml`) | on push to `master` touching `fixes/**`/`runbooks/**` | Rebuilds and publishes `fixes/index.json` |
| `Validate Mission Schema` (`.github/workflows/validate-schema.yml`) | weekly, Monday 05:30 UTC | Re-validates all mission files on a cadence |
| `CNCF Mission Generation` (`.github/workflows/cncf-mission-gen.yml`) | daily, 06:00 UTC | Generates and auto-merges new missions |
| `CNCF Install Mission Generation` (`.github/workflows/cncf-install-gen.yml`) | weekly, Wednesday 06:00 UTC | Generates install/configure missions |
| `Scan Mission Files` (`.github/workflows/scan-missions.yml`) | weekly, Monday 06:00 UTC | Re-scans all mission files for safety issues |
| `Platform Install Mission Generation` (`.github/workflows/platform-install-gen.yml`) | 4x daily, 00:00/06:00/12:00/18:00 UTC | Generates install missions, writes `fixes/platform-install/**` and `fixes/index.json` directly to `master` |
| `Fuzzing` (`.github/workflows/fuzz.yml`) | daily, 06:00 UTC | Fuzzes the JSON parsers/schema/scanner that gate mission content safety |
| `CodeQL Security Analysis` (`.github/workflows/codeql.yml`) | nightly, 05:30 UTC | Recurring JavaScript/TypeScript security scan of `master` |
| `OpenSSF Scorecard` (`.github/workflows/scorecard.yml`) | weekly, Monday 06:00 UTC | Recurring supply-chain security posture scan of `master` |
| `Stale Issues` (`.github/workflows/stale.yml`) | daily, midnight UTC | Sweeps and labels/closes stale issues repo-wide |

The same silent-failure gap applies to the two security-scan workflows above,
even though they don't publish or gate mission content — a broken CodeQL or
Scorecard run has no automated time-to-detect signal either. The same gap also
applies to `stale.yml`, which has already had a confirmed real-world silent
failure in this repo (`startup_failure` due to an invalid `secrets:` token
passed to `reusable-stale.yml`, see #3057/#3071) — a repeat of that failure
mode today would again go unnoticed beyond the Actions tab.

**Fixed**: all ten workflows in the table above now page a maintainer
automatically. `.github/workflows/scheduled-workflow-failure-issue.yml`
("Open Issue on Scheduled Workflow Failure", added in
[#3719](https://github.com/kubestellar/console-kb/pull/3719) and extended
to full coverage in [#3728](https://github.com/kubestellar/console-kb/pull/3728)
and [#3754](https://github.com/kubestellar/console-kb/pull/3754)/[#3762](https://github.com/kubestellar/console-kb/pull/3762))
listens for `workflow_run` completion on every workflow name in this table
and files (or comments on) a `kind/bug` + `lifecycle/frozen` tracking issue
whenever `conclusion == 'failure'` — confirmed on current `master`: its
`on.workflow_run.workflows` list contains all ten workflow names above.
A red run is therefore no longer visible only via the Actions tab; it
produces a tracked GitHub issue within minutes. This runbook's manual
detection steps below remain useful as a fallback (e.g. to corroborate an
auto-filed issue, or if the alerting workflow itself silently fails — it
has the same `startup_failure` blind spot as everything else here), and as
the only detection method for `mission-safety-scan.yml`, which this
alerting workflow cannot safely cover (see `docs/slo.md`'s "Follow-up not
covered by this document" section for why that one workflow is different).

## Event-triggered reusable-workflow callers (same gap, different trigger)

The silent-failure gap above is not limited to cron-triggered workflows.
`PR Verifier` (`.github/workflows/pr-verifier.yml`, `on: pull_request_target`)
called a reusable workflow via a pinned `uses:` SHA
(`kubestellar/infra/.github/workflows/reusable-pr-verifier.yml@1a04a3fd...`)
and had a **100% `startup_failure`/`failure` rate on every run from at least
2026-08-30 through 2026-09-17** (100+ consecutive runs, `0` jobs ever created
on any of them) — tracked in
[#3336](https://github.com/kubestellar/console-kb/issues/3336). Every PR
opened, edited, synced, or reopened in that window received zero verifier
feedback, with nothing distinguishing that from a healthy "no issues found"
result.

**Fixed**: the target `reusable-pr-verifier.yml` did not exist in
`kubestellar/infra` at *any* pin (confirmed org-wide across several
KubeStellar repos calling the same reusable workflow), so no SHA repin could
have worked. PR [#3441](https://github.com/kubestellar/console-kb/pull/3441)
(merged 2026-09-17) replaced the call with a minimal self-contained
title/body check instead, closing #3336. Runs have created real jobs and
returned `success`/`failure` based on actual PR content since
2026-09-17T14:20 UTC. This history is kept here as a worked example of the
detection technique below, and because the underlying gap it demonstrates —
no alert distinguishing a `startup_failure` from a healthy run — is still
open for event-triggered reusable-workflow callers generally.

Detection for this class of failure differs from the scheduled table above
because there is no fixed cadence to check against — instead, check the
*failure rate* across the workflow's own run history:

```bash
gh api repos/kubestellar/console-kb/actions/workflows/pr-verifier.yml/runs \
  --jq '.workflow_runs[:10] | .[] | {id,created_at,conclusion}'
```

A `conclusion` of `failure` or `startup_failure` with `0` jobs created
(check via `gh api repos/kubestellar/console-kb/actions/runs/<id>/jobs
--jq '.total_count'`) on **every recent run regardless of PR/commit** is the
same parse-time-rejection signature as the scheduled-workflow case above —
treat it as a confirmed incident the same way. Any other `pull_request`/
`pull_request_target`-triggered reusable-workflow caller in this repo should
be spot-checked the same way after any change to its pinned `uses:` SHA,
since a green check elsewhere in the repo does not imply this one still
works.

## Symptoms

- `fixes/index.json` (or `search-state.json`) has not been updated in
  longer than its expected cadence (see schedule column above).
- A mission file merged via PR does not appear in `fixes/index.json` after
  the next expected `Build Mission Index` run.
- No new `cncf-mission-gen` or `install-missions` labeled PR has appeared
  in the last 24h/7d despite open upstream CNCF activity.
- `docs/slo.md` section 3 ("Time-to-detect a bad publish") cannot be
  evaluated because there is no signal that a run happened at all.
- No `stale.yml` run has appeared in the last ~30 hours (expected daily),
  or the workflow shows `startup_failure`/`failure` on its most recent
  scheduled run — issues stop receiving the `stale` label/auto-close
  treatment repo-wide with no automated signal.

## Detection

An auto-filed `kind/bug` issue titled `Workflow failure: <name>` (see
"Prevention" above) is the primary signal and normally arrives before any
manual check below is needed. Use the manual history check as a fallback —
to corroborate an auto-filed issue, to catch a failure in
`mission-safety-scan.yml` (not covered by the automated alert), or in the
unlikely case the alerting workflow itself failed silently:

Manually check each workflow's recent run history (requires repo read
access, run from a checkout or via `gh`):

```bash
for wf in build-index.yml validate-schema.yml cncf-mission-gen.yml \
          cncf-install-gen.yml scan-missions.yml platform-install-gen.yml fuzz.yml \
          codeql.yml scorecard.yml stale.yml; do
  echo "== $wf =="
  gh run list --repo kubestellar/console-kb --workflow "$wf" --limit 3 \
    --json status,conclusion,createdAt,url
done
```

Treat any `conclusion` of `failure`, `cancelled`, or `timed_out` on the
most recent scheduled run as a confirmed incident — as is a *missing* run
past its expected cadence (e.g. no `cncf-mission-gen.yml` run in the last
~30 hours, no `platform-install-gen.yml` run in the last ~8 hours, no
`codeql.yml` run in the last ~30 hours, no `fuzz.yml` run in the last
~30 hours, no `stale.yml` run in the last ~30 hours, no
`cncf-install-gen.yml` run in the last ~8 days, or no
`validate-schema.yml`/`scan-missions.yml`/`scorecard.yml` run in the last
~8 days), which indicates the schedule trigger itself stopped firing. A
`startup_failure` conclusion (not just `failure`) is also a confirmed
incident — this is exactly how `stale.yml` failed previously (#3057).

## Immediate mitigation

1. Open the failed run's log (`url` field above) and identify the failing
   step (commonly `npm ci`, a script error, or a transient GitHub API
   rate-limit/auth failure).
2. Re-trigger the workflow manually once the underlying cause is understood
   or believed transient:
   ```bash
   gh workflow run <workflow-file> --repo kubestellar/console-kb
   ```
3. If the failure is `build-index.yml`, cross-check `fixes/index.json` is
   not left stale relative to `fixes/**`/`runbooks/**` using the detection
   steps in
   [`incident-response-index-publish-failure.md`](./incident-response-index-publish-failure.md).
4. If the failure is `cncf-mission-gen.yml`'s `collect` job specifically,
   also check `search-state.json` for corruption per
   [`incident-response-search-state-corruption.md`](./incident-response-search-state-corruption.md).

## Root-cause follow-up

1. Fix the underlying failure (dependency bump, script bug, expired
   credential, upstream API change) through a normal reviewed pull
   request.
2. Re-run the detection commands above to confirm the workflow now
   completes successfully on its normal schedule.
3. File a postmortem using
   [`runbooks/POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md) if the
   silent failure persisted long enough to cause user-facing staleness. See
   [`postmortem-2026-08-stale-workflow-startup-failure.md`](./postmortem-2026-08-stale-workflow-startup-failure.md)
   for a worked example — a `stale.yml`/`add-help-wanted.yml`
   `startup_failure` from an invalid `secrets:` block that went undetected
   for 3 consecutive nightly runs before being filed as #3057.

## Prevention (fixed for every workflow in the table above; one workflow outside it remains tracked separately)

An `if: failure()`-equivalent alert (`workflow_run` completion watching for
`conclusion == 'failure'`) now exists for all ten scheduled/publish
workflows in the table above — see "Fixed" in the Scope section. The one
workflow in this repo that still has no automated alert, `mission-safety-scan.yml`,
is not in that table at all — it runs `on: pull_request` only, with no
schedule or push trigger, and gating it on plain `conclusion == 'failure'`
would incorrectly alert on every routine content rejection. That gap is
tracked as `[operations]`/`[telemetry]` issue
[#3774](https://github.com/kubestellar/console-kb/issues/3774) with the
exact `startup_failure`-gated diff, still blocked on `workflows`
permission these contribution credentials don't have.
