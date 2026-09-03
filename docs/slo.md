# Service Level Objectives: `kubestellar/console-kb`

This repository has no runtime backend of its own — no confirmed OTel/Prometheus/commercial
backend is wired up in this repo. Its user-facing product is the **published mission
catalog**: `fixes/index.json` on `master`, fetched live by the KubeStellar Console frontend
on every KB page load (see `scripts/build-index.mjs`, and `kubestellar/console#8148`, which
serves these index fields via `/api/missions/scores`). CI health on `master` for the
publish/validation pipeline is therefore the closest available user-facing signal, in the
same spirit as `kubestellar/homebrew-tap`'s `docs/slo.md` (formula CI health as SLI proxy).

No exporter or external data flow is added by this document — recommendations only.

## SLIs and SLOs

### 1. Index publish integrity

- **SLI**: `fixes/index.json` on `master` parses as valid JSON and its mission `count`
  matches the number of valid mission files under `fixes/**` and `runbooks/**`.
- **SLO**: 100% of commits to `master` leave `fixes/index.json` valid and in sync.
  Any bad publish is a confirmed incident (see
  [`runbooks/incident-response-index-publish-failure.md`](../runbooks/incident-response-index-publish-failure.md)),
  not a tolerated error budget — this file is read on every Console KB page load.
- **Source**: `Build Mission Index` workflow (`.github/workflows/build-index.yml`) run
  status, plus the manual detection commands in the incident-response runbook.

### 2. Mission content safety

- **SLI**: percentage of merged mission files (`fixes/**`, `runbooks/**`) that pass
  `Mission Safety Scan` (`.github/workflows/mission-safety-scan.yml`) and
  `Validate Mission Schema` (`.github/workflows/validate-schema.yml`) on their
  introducing pull request.
- **SLO**: 100% — these checks run `on: pull_request` only, and nothing merged by a
  human reviewer should bypass both (see `docs/BRANCH_PROTECTION.md`). **Known
  exception**: the `CNCF Mission Generation` workflow's `auto-merge` job
  (`.github/workflows/cncf-mission-gen.yml`) merges `cncf-mission-gen`-labeled PRs
  with `gh pr merge --admin`, which unconditionally bypasses branch protection and
  any required status checks, based solely on a content-heuristic quality score
  (`scripts/quality-scorer.mjs`, threshold 70) that never inspects `Mission Safety
  Scan` or `Validate Mission Schema` results. A mission JSON can reach `master`
  without either check having run or passed. Tracked as a follow-up (see below);
  this document does not add the fix itself. Recovery steps for this scenario
  are documented in
  [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md).

### 3. Time-to-detect a bad publish

- **SLI**: elapsed time from a bad `fixes/index.json` commit landing on `master` to
  the first confirmed detection (manual validation per the incident-response runbook,
  or a future automated check).
- **SLO target**: detect within 24 hours. There is currently no automated alert on
  `Build Mission Index` job failure or on a passing-but-corrupt publish — detection
  today relies on a maintainer noticing a broken Console KB page or a failed
  scheduled workflow run. Tracked as a follow-up (see below); this document does not
  add the alert itself. Until that alert exists, use
  [`runbooks/incident-response-scheduled-workflow-failure.md`](../runbooks/incident-response-scheduled-workflow-failure.md)
  to manually check for a silent job failure.

### 4. Time-to-rollback

- **SLI**: elapsed time from confirmed detection to a reverted `fixes/index.json` on
  `master`.
- **SLO target**: rollback within 1 hour of detection, via
  `git revert --no-edit <bad-commit-sha>` as documented in the incident-response
  runbook's "Immediate mitigation" section.

## Follow-up not covered by this document

None of the scheduled workflows that publish or validate content on a cadence
(`build-index.yml` on every qualifying push, `validate-schema.yml` weekly,
`mission-safety-scan.yml` per-PR, `cncf-mission-gen.yml` daily, `cncf-install-gen.yml`
weekly, `scan-missions.yml` weekly, `platform-install-gen.yml` 4x daily) alert anyone
when the *job itself* fails — a red run there means the SLI in section 3 above cannot
be measured at all beyond a maintainer noticing the Actions tab. Adding that alert
requires editing `.github/workflows/*.yml`, which needs `workflows` permission this
contribution's credentials do not have; filed separately as a `[operations]` issue
instead of included in this docs-only change.

Separately, the section 2 "known exception" above (`cncf-mission-gen.yml`'s
`--admin` auto-merge bypassing `Mission Safety Scan` and `Validate Mission Schema`)
also requires editing that workflow to either drop `--admin` in favor of a
mergeable-state/required-checks check, or gate the scorer step on those two checks
having completed and passed first. Also filed separately as a `[operations]` issue
for the same `workflows`-permission reason.

## References

- [`runbooks/incident-response-index-publish-failure.md`](../runbooks/incident-response-index-publish-failure.md)
- [`runbooks/incident-response-search-state-corruption.md`](../runbooks/incident-response-search-state-corruption.md) — covers the `CNCF Mission Generation` workflow's separate direct-to-`master` push of `search-state.json`, which (unlike `fixes/index.json`) has no content-validation gate at all
- [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md) — covers the `CNCF Mission Generation` workflow's `--admin` auto-merge bypassing `Mission Safety Scan` and `Validate Mission Schema`
- [`runbooks/incident-response-scheduled-workflow-failure.md`](../runbooks/incident-response-scheduled-workflow-failure.md) — manual detection for a silent job failure (or missing run) in any of the six scheduled/publish workflows above, pending the automated alert tracked as a follow-up
- [`runbooks/POSTMORTEM_TEMPLATE.md`](../runbooks/POSTMORTEM_TEMPLATE.md)
- [`docs/BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md)
