# KubeStellar Console Knowledge Base

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Part of Console Ecosystem](https://img.shields.io/badge/KubeStellar-Console%20Ecosystem-blue)](https://github.com/kubestellar/console)

Community knowledge base for [KubeStellar Console](https://github.com/kubestellar/console) AI missions — share, discover, and import proven fixes to save tokens and time.

## Overview

Console KB is the community hub for sharing AI mission fixes created in the KubeStellar Console. When you solve a complex Kubernetes problem using the Console's AI-powered missions, you can export and publish your solution here so others can:

- **Import** proven fixes directly into their Console
- **Discover** community-tested fixes to common challenges
- **Save tokens** by reusing fixes instead of re-prompting AI
- **Learn** from real-world multi-cluster Kubernetes fixes

## How It Works

```
┌─────────────────────┐     Export      ┌─────────────────────┐
│  KubeStellar        │ ──────────────▶ │  Console KB         │
│  Console            │                 │  (This Repo)        │
│                     │ ◀────────────── │                     │
│  AI Missions        │     Import      │  Community Fixes │
└─────────────────────┘                 └─────────────────────┘
```

### Fixer Format

Each fixer mission is a self-contained package that includes:

- **Mission definition** — the AI prompt and parameters
- **Expected outcomes** — what the mission produces
- **Prerequisites** — required cluster setup, CRDs, or tools
- **Tags** — categories for discovery (e.g., `multi-cluster`, `security`, `networking`)
- **Compatibility** — Console version and tested Kubernetes versions

See [CONTRIBUTING.md](CONTRIBUTING.md) for the submission flow and [`docs/fixer-schema.yaml`](docs/fixer-schema.yaml) for the annotated format reference.

## Getting Started

### Browse Fixes

Explore the [`fixes/`](fixes/) directory to find community-contributed AI mission fixes organized by category.

### Import a Fix

1. Copy the fix YAML from this repository
2. In KubeStellar Console, go to **AI Missions → Import**
3. Paste or upload the fix file
4. The mission is ready to run in your environment

### Share Your Fix

1. Create a successful AI mission in KubeStellar Console
2. Export it via **AI Missions → Export**
3. Fork this repo and add your fix to the appropriate category under `fixes/`
4. Submit a PR with a description of what the mission fixes

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed submission guidelines.

## Operational Runbooks

In addition to community-contributed fixes, this repository ships a curated `runbooks/` catalog for deterministic day-2 operations. These runbooks use the same `kc-mission-v1` format as fixes, but they are written for repeatable operational tasks such as upgrades, restores, certificate rotation, and RBAC remediation.

Browse [`runbooks/`](runbooks/) or start with [`runbooks/README.md`](runbooks/README.md) for authoring expectations and operational context.

| Runbook | Purpose |
|---------|---------|
| [`install-kubestellar-controller.json`](runbooks/install-kubestellar-controller.json) | Install the KubeStellar core controller in standalone mode with Helm. |
| [`upgrade-kubestellar-controller.json`](runbooks/upgrade-kubestellar-controller.json) | Perform an in-place KubeStellar controller Helm upgrade with health gates and rollback readiness. |
| [`rollback-kubestellar-controller.json`](runbooks/rollback-kubestellar-controller.json) | Roll back `kubestellar-core` to a known-good Helm revision after a failed or regressing upgrade. |
| [`certificate-rotation.json`](runbooks/certificate-rotation.json) | Rotate kubeadm control-plane certificates, refresh kubeconfig, and clear expired credential issues. |
| [`cluster-upgrade.json`](runbooks/cluster-upgrade.json) | Upgrade a kubeadm-managed cluster with prechecks, package updates, and post-upgrade validation. |
| [`node-drain.json`](runbooks/node-drain.json) | Cordon, drain, validate, and restore a node during planned maintenance. |
| [`rbac-audit.json`](runbooks/rbac-audit.json) | Audit RBAC access and apply least-privilege remediation for `RBAC_DENIED` failures. |
| [`disaster-recovery.json`](runbooks/disaster-recovery.json) | Back up and restore kubeadm etcd state during disaster recovery for self-managed control planes. |
| [`restore-etcd-snapshot.json`](runbooks/restore-etcd-snapshot.json) | Restore a Kubernetes control plane from an existing etcd snapshot with rollback safeguards. |
| [`restore-velero-backup.json`](runbooks/restore-velero-backup.json) | Restore namespaces, volumes, and workloads from a completed Velero backup. |

You can import runbooks into KubeStellar Console the same way you import fixes: copy the mission file, open **AI Missions → Import**, and upload or paste the JSON payload.

## Fix Categories

Add new fixes under the category whose scope best matches the problem you solved. If a fix clearly matches an existing category, keep related missions together there instead of creating a new top-level directory.

| Category | Scope | Example fix type |
|----------|-------|------------------|
| `cncf-generated/` | Auto-generated fixer missions grouped by CNCF project and maintained by repository automation. | A generated Alertmanager or Argo CD bug-fix mission sourced from upstream issue data. |
| `cncf-install/` | Install missions for CNCF projects. | Installing cert-manager, Cilium, or another CNCF project into a cluster. |
| `cost-optimization/` | Resource efficiency, right-sizing, and spend reduction guidance. | Reducing idle capacity or tuning requests and limits. |
| `llm-d/` | Missions for the LLM-D stack and related AI inference components. | Installing inference scheduling, benchmark, or prefix-cache features. |
| `multi-cluster/` | Cross-cluster deployment, federation, placement, and sync patterns. | Setting up multi-tenancy or propagating workloads across clusters. |
| `networking/` | Service mesh, ingress, DNS, traffic, and connectivity fixes. | Repairing a NetworkPolicy or cross-namespace service path. |
| `observability/` | Monitoring, logging, tracing, and alerting workflows. | Adding cluster diagnostics dashboards or alert investigation steps. |
| `orbit/` | KubeStellar Orbit operational tasks and lifecycle checks. | Orbit backup verification, certificate rotation, or version-drift checks. |
| `platform-install/` | Auto-generated install missions for Kubernetes platforms, distributions, and operators. | Installing Agones, CloudNativePG, or a managed-platform add-on. |
| `security/` | RBAC, secret management, policy, and vulnerability remediation. | Fixing an RBAC denial or remediating a published CVE. |
| `troubleshoot/` | Current home for general diagnostic and recovery missions. | Restoring expired credentials, pruning kubeconfig entries, or etcd backup checks. |
| `troubleshooting/` | Placeholder category name kept for discoverability and backward documentation references. | No missions live here today; prefer `troubleshoot/` for new general diagnostics until maintainers consolidate the naming. |
| `workloads/` | Application deployment, rollout, storage, and workload behavior fixes. | Migrating workload storage or updating deployment patterns. |

### Category Notes

- **Choosing a category:** pick the directory that matches the dominant user problem, not every tag a mission might include. For example, an RBAC error belongs in `security/` even if it happens during a multi-cluster workflow.
- **`troubleshoot/` vs. `troubleshooting/`:** the repository currently stores real diagnostic missions in `fixes/troubleshoot/`, while `fixes/troubleshooting/` only contains a README placeholder. Until the naming is consolidated, add new general diagnostic fixes to `troubleshoot/`.
- **`fixes/index.json`:** this file is auto-generated by `node scripts/build-index.mjs` and is refreshed by the `Build Mission Index` GitHub Actions workflow whenever `fixes/**` or `runbooks/**` changes land on `master` (excluding `fixes/index.json` itself). Do not edit it by hand.

## Part of the Console Ecosystem

| Repository | Description |
|------------|-------------|
| [kubestellar/console](https://github.com/kubestellar/console) | AI-powered multi-cluster Kubernetes dashboard |
| [kubestellar/console-marketplace](https://github.com/kubestellar/console-marketplace) | Community dashboards, card presets, and themes |
| **kubestellar/console-kb** (this repo) | AI mission knowledge base — share and discover fixes |

## Contributing

We welcome contributions! Whether you're sharing a fix that saved you hours of debugging or improving an existing fix, every contribution helps the community.

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on submitting fixes, local validation, and the purpose of generated repository files such as `generation-report.md` and `search-state.json`.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Community

- [Slack Channel](https://cloud-native.slack.com/archives/C097094RZ3M)
- [Website](https://kubestellar.io)
- [Console Documentation](https://github.com/kubestellar/console#readme)
