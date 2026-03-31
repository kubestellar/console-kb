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

## Fix Categories

| Category | Description |
|----------|-------------|
| `multi-cluster/` | Cross-cluster deployment, federation, and sync patterns |
| `security/` | RBAC, network policies, secret management across clusters |
| `networking/` | Service mesh, ingress, DNS, and connectivity fixes |
| `observability/` | Monitoring, logging, and alerting across clusters |
| `workloads/` | Application deployment strategies and patterns |
| `troubleshooting/` | Diagnostic missions for common Kubernetes issues |
| `cost-optimization/` | Resource right-sizing and cluster efficiency |

## Part of the Console Ecosystem

| Repository | Description |
|------------|-------------|
| [kubestellar/console](https://github.com/kubestellar/console) | AI-powered multi-cluster Kubernetes dashboard |
| [kubestellar/console-marketplace](https://github.com/kubestellar/console-marketplace) | Community dashboards, card presets, and themes |
| **kubestellar/console-kb** (this repo) | AI mission knowledge base — share and discover fixes |

## Contributing

We welcome contributions! Whether you're sharing a fix that saved you hours of debugging or improving an existing fix, every contribution helps the community.

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on submitting fixes.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Community

- [Slack Channel](https://cloud-native.slack.com/archives/C097094RZ3M)
- [Website](https://kubestellar.io)
- [Console Documentation](https://github.com/kubestellar/console#readme)
