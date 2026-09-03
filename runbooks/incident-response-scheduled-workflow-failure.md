# Incident Response: Scheduled/Publish Workflow Job Failure

## Scope

This runbook covers the case where the *job itself* fails outright (not a
bad-but-green publish) in one of the workflows that generate or gate the
published mission catalog:

| Workflow | Schedule | Role |
|----------|----------|------|
| `Build Mission Index` (`.github/workflows/build-index.yml`) | on push to `master` touching `fixes/**`/`runbooks/**` | Rebuilds and publishes `fixes/index.json` |
| `Validate Mission Schema` (`.github/workflows/validate-schema.yml`) | weekly, Monday 05:30 UTC | Re-validates all mission files on a cadence |
| `CNCF Mission Generation` (`.github/workflows/cncf-mission-gen.yml`) | daily, 06:00 UTC | Generates and auto-merges new missions |
| `CNCF Install Mission Generation` (`.github/workflows/cncf-install-gen.yml`) | weekly, Wednesday 06:00 UTC | Generates install/configure missions |
| `Scan Mission Files` (`.github/workflows/scan-missions.yml`) | weekly, Monday 06:00 UTC | Re-scans all mission files for safety issues |
| `Generate Platform Install Missions` (`.github/workflows/platform-install-gen.yml`) | 4x daily, `0 0,6,12,18 * * *` | Generates platform-install missions under `fixes/platform-install/**` and opens a PR against `master` |

None of these workflows currently notify anyone when the job itself fails
(no `if: failure()` step, issue/comment creation, or webhook — confirmed via
`grep -n "if: failure\|create-issue\|slack\|notify\|issues.create\|actions/github-script" .github/workflows/*.yml`).
A red run is visible only via the Actions tab or an easily-missed default
GitHub notification email. Adding an automated alert requires editing
`.github/workflows/*.yml` (tracked separately as a `[operations]` issue,
since it needs `workflows` permission). Until that lands, use this runbook
to manually check for and respond to a silent failure.

## Symptoms

- `fixes/index.json` (or `search-state.json`) has not been updated in
  longer than its expected cadence (see schedule column above).
- A mission file merged via PR does not appear in `fixes/index.json` after
  the next expected `Build Mission Index` run.
- No new `cncf-mission-gen` or `install-missions` labeled PR has appeared
  in the last 24h/7d despite open upstream CNCF activity.
- `docs/slo.md` section 3 ("Time-to-detect a bad publish") cannot be
  evaluated because there is no signal that a run happened at all.

## Detection

Manually check each workflow's recent run history (requires repo read
access, run from a checkout or via `gh`):

```bash
for wf in build-index.yml validate-schema.yml cncf-mission-gen.yml \
          cncf-install-gen.yml scan-missions.yml platform-install-gen.yml; do
  echo "== $wf =="
  gh run list --repo kubestellar/console-kb --workflow "$wf" --limit 3 \
    --json status,conclusion,createdAt,url
done
```

Treat any `conclusion` of `failure`, `cancelled`, or `timed_out` on the
most recent scheduled run as a confirmed incident — as is a *missing* run
past its expected cadence (e.g. no `cncf-mission-gen.yml` run in the last
~30 hours, no `validate-schema.yml`/`scan-missions.yml` run in the last
~8 days, or no `platform-install-gen.yml` run in the last ~8 hours given
its 4x/day cadence — the most frequent of any scheduled workflow in this
repo), which indicates the schedule trigger itself stopped firing.

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
   silent failure persisted long enough to cause user-facing staleness.

## Prevention (tracked, not implemented by this runbook)

Adding an `if: failure()` step (e.g. via `actions/github-script`, matching
the pattern already used for PR comments in `scan-missions.yml`) to each
workflow above, to open/update a tracking issue on job failure, requires
editing `.github/workflows/*.yml` — tracked as a separate `[operations]`
issue since it needs `workflows` permission this runbook's authoring
credentials do not have.
