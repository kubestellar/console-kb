# KubeStellar Operational Runbooks

This directory contains **production-grade, execution-ready operational runbooks** for KubeStellar core operations.

## What Are Runbooks?

Unlike the community-contributed `fixes/` (which resolve Kubernetes issues), runbooks here are **SRE-authored, deterministic, step-by-step guides** for critical lifecycle operations. Each runbook:

- Is idempotent — safe to re-run at any point
- Includes validation after every critical step
- Uses `kubectl wait` instead of `sleep`
- Provides explicit failure handling and remediation
- Is compatible with KubeStellar Console's Mission Control agent

## Format

All runbooks follow the `kc-mission-v1` schema with `missionClass: "runbook"`. They are indexed alongside the `fixes/` directory and discoverable by the Console's Mission Control AI.

## Available Runbooks

| File | Operation | Difficulty |
|------|-----------|------------|
| [`install-kubestellar-controller.json`](./install-kubestellar-controller.json) | Install KubeStellar core controllers via Helm (`kubestellar/kubestellar-core` chart, standalone mode). **Does NOT provision KubeFlex, ITS, or WDS.** | Intermediate |
| [`upgrade-kubestellar-controller.json`](./upgrade-kubestellar-controller.json) | In-place Helm upgrade of `kubestellar-core` with health gates, dry-run diff, and `--atomic` rollback safety. | Intermediate |
| [`rollback-kubestellar-controller.json`](./rollback-kubestellar-controller.json) | Helm rollback of `kubestellar-core` to a known-good revision after a failed upgrade. Pairs with `upgrade-kubestellar-controller.json`. | Intermediate |
| [`certificate-rotation.json`](./certificate-rotation.json) | Rotate kubeadm control-plane certificates and refresh kubeconfig. Resolves preflight `EXPIRED_CREDENTIALS`. | Intermediate |
| [`cluster-upgrade.json`](./cluster-upgrade.json) | Upgrade a kubeadm-managed cluster with health gates. | Intermediate |
| [`node-drain.json`](./node-drain.json) | Cordon, drain, and uncordon a node for maintenance. | Beginner |
| [`rbac-audit.json`](./rbac-audit.json) | Audit and remediate `RBAC_DENIED` with least-privilege bindings. | Beginner |
| [`disaster-recovery.json`](./disaster-recovery.json) | Back up and restore etcd state on a kubeadm cluster. Validated end-to-end on kind v1.35 / etcd v3.6.6. | Advanced |
| [`restore-etcd-snapshot.json`](./restore-etcd-snapshot.json) | Restore a kubeadm-managed control plane from a previously captured etcd snapshot. | Advanced |
| [`restore-velero-backup.json`](./restore-velero-backup.json) | Restore namespaces, volumes, and workloads from an existing Velero backup. | Intermediate |

> **⚠️ Deprecation notice — legacy `kubestellar/kubestellar` Helm components**
>
> The `kubestellar/kubestellar` Helm chart and its associated components (BindingPolicy, WECs,
> ITSs, `control.kubestellar.io`) are **deprecated and no longer actively maintained**.
> Users should migrate to [kubestellar/console](https://github.com/kubestellar/console) as the
> actively maintained replacement. Runbooks that target the legacy chart should carry this notice
> and link readers to the migration guide at <https://docs.kubestellar.io/main/direct/get-started/>.

## Repository Incident Response

Unlike the runbooks above (which target KubeStellar cluster/controller
operations), the following documents cover incidents in **this repository's
own publish pipeline**:

| File | Purpose |
|------|---------|
| [`incident-response-index-publish-failure.md`](./incident-response-index-publish-failure.md) | Detect and recover from a bad `fixes/index.json` auto-publish (the `Build Mission Index` workflow pushes directly to `master`, bypassing PR review and safety/schema checks). |
| [`incident-response-search-state-corruption.md`](./incident-response-search-state-corruption.md) | Detect and recover from a corrupted `search-state.json` (the `CNCF Mission Generation` workflow pushes it directly to `master` daily, bypassing PR review and *all* content-validation gates, with a silent parse-failure fallback that can reset scan dedup state). |
| [`incident-response-unsafe-mission-merge.md`](./incident-response-unsafe-mission-merge.md) | Detect and recover from a mission merged to `master` via the `CNCF Mission Generation` workflow's `--admin` auto-merge bypassing `Mission Safety Scan`/`Validate Mission Schema` (fixed in #3418) and from `Validate Mission Schema` never validating `runbooks/**` (fixed in #3410) — retained for historical incident recovery — plus the still-open false-green gaps in `Mission Safety Scan`, `KB Quality Enforcement`, and `Mission Content Validation` on `runbooks/**`-only PRs. |
| [`incident-response-scheduled-workflow-failure.md`](./incident-response-scheduled-workflow-failure.md) | Manually detect and respond to a silent job failure (or missing run) in `build-index.yml`, `validate-schema.yml`, `cncf-mission-gen.yml`, `cncf-install-gen.yml`, `scan-missions.yml`, `platform-install-gen.yml`, `fuzz.yml`, `codeql.yml`, `scorecard.yml`, or `stale.yml` — none of which currently alert on the job itself failing — plus the same failure mode in event-triggered reusable-workflow callers, with `pr-verifier.yml`'s 100% `startup_failure` rate from 2026-08-30 to 2026-09-17 (#3336, fixed by #3441) as a worked example. |
| [`fuzz-yml-ci-summary-gap.md`](./fuzz-yml-ci-summary-gap.md) | Ready-to-apply, validated diff adding `$GITHUB_STEP_SUMMARY` output, step `id`s, and `if: always()` to `fuzz.yml`'s three test steps, preserved here because the GitHub App token lacks the `workflows` permission needed to land the edit directly. |
| [`POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md) | Template for writing up any repository-operations incident. |
| [`postmortem-2026-08-stale-workflow-startup-failure.md`](./postmortem-2026-08-stale-workflow-startup-failure.md) | Filled-in postmortem for the `stale.yml`/`add-help-wanted.yml` `startup_failure` incident (2026-08-27 to 2026-08-30, #3057/#3058/#3071/#3074) — a worked example of the gap this runbook and `docs/slo.md` still track today (no automated alert on a scheduled workflow's own job failure). |
| [`postmortem-2026-09-pr-verifier-chronic-startup-failure.md`](./postmortem-2026-09-pr-verifier-chronic-startup-failure.md) | Retrospective covering `pr-verifier.yml`'s five recorded `startup_failure` incidents since 2026-06-29 (#2704, #2780, #2883, #2975, #3336) — the first four produced no postmortem or safeguard against the recurring caller/callee pin-drift pattern; the fifth was finally fixed by #3441, which replaced the reusable-workflow call with a self-contained check. |
| [`../docs/slo.md`](../docs/slo.md) | SLIs/SLOs for the mission index publish/validation pipeline (publish integrity, content safety, time-to-detect, time-to-rollback). |

## Planned Runbooks

_All originally planned runbooks have been delivered. Future additions tracked via `runbooks/` directory contributions._

## Contributing a Runbook

Runbooks must pass the following quality bar before merge:

1. **No `sleep` commands** — use `kubectl wait --for=condition=... --timeout=Xs`
2. **Every step has `validation`** — a deterministic command that exits 0 on success
3. **Every step has `failureHandling`** — actionable remediation, not "check the docs"
4. **All commands are namespace-explicit** — never rely on the default namespace
5. **All commands are idempotent** — `helm upgrade --install`, not `helm install`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for submission guidelines.
