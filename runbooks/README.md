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
| [`install-kubestellar-controller.json`](./install-kubestellar-cotroller.json) | Install KubeStellar core controllers via Helm (`kubestellar/kubestellar-core` chart, standalone mode). **Does NOT provision KubeFlex, ITS, or WDS.** | Intermediate |
| [`upgrade-kubestellar-controller.json`](./upgrade-kubestellar-controller.json) | In-place Helm upgrade of `kubestellar-core` with health gates, dry-run diff, and `--atomic` rollback safety. | Intermediate |
| [`rollback-kubestellar-controller.json`](./rollback-kubestellar-controller.json) | Helm rollback of `kubestellar-core` to a known-good revision after a failed upgrade. Pairs with `upgrade-kubestellar-controller.json`. | Intermediate |
| [`certificate-rotation.json`](./certificate-rotation.json) | Rotate kubeadm control-plane certificates and refresh kubeconfig. Resolves preflight `EXPIRED_CREDENTIALS`. | Intermediate |
| [`cluster-upgrade.json`](./cluster-upgrade.json) | Upgrade a kubeadm-managed cluster with health gates. | Intermediate |
| [`node-drain.json`](./node-drain.json) | Cordon, drain, and uncordon a node for maintenance. | Beginner |
| [`rbac-audit.json`](./rbac-audit.json) | Audit and remediate `RBAC_DENIED` with least-privilege bindings. | Beginner |

> **⚠️ Deprecation notice — legacy `kubestellar/kubestellar` Helm components**
>
> The `kubestellar/kubestellar` Helm chart and its associated components (BindingPolicy, WECs,
> ITSs, `control.kubestellar.io`) are **deprecated and no longer actively maintained**.
> Users should migrate to [kubestellar/console](https://github.com/kubestellar/console) as the
> actively maintained replacement. Runbooks that target the legacy chart should carry this notice
> and link readers to the migration guide at <https://docs.kubestellar.io/main/direct/get-started/>.

## Planned Runbooks

- `disaster-recovery.json` — Full cluster backup verification and restore

## Contributing a Runbook

Runbooks must pass the following quality bar before merge:

1. **No `sleep` commands** — use `kubectl wait --for=condition=... --timeout=Xs`
2. **Every step has `validation`** — a deterministic command that exits 0 on success
3. **Every step has `failureHandling`** — actionable remediation, not "check the docs"
4. **All commands are namespace-explicit** — never rely on the default namespace
5. **All commands are idempotent** — `helm upgrade --install`, not `helm install`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for submission guidelines.
