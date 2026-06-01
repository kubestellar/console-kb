# Contributing to Console KB

Welcome! The Console KB (Knowledge Base) is the community hub for sharing AI mission fixes created in the [KubeStellar Console](https://github.com/kubestellar/console). This repository contains mission definition files that users can import directly into their Console to solve common Kubernetes challenges.

We're grateful for your interest in contributing! Whether you're sharing a fix that saved you hours of debugging, improving an existing mission, or enhancing documentation, your contributions help the entire community.

If you have any questions, please reach out to us on [Slack](https://cloud-native.slack.com/archives/C097094RZ3M).

## What is Console KB?

This repository stores **fixer mission files** — self-contained AI mission definitions that include:

- AI prompt and mission parameters
- Step-by-step instructions for solving a specific Kubernetes problem
- Prerequisites (cluster setup, CRDs, tools)
- Validation commands to verify success
- Tags and metadata for discovery

Users import these fixes into KubeStellar Console to:
- Save tokens by reusing proven fixes instead of re-prompting AI
- Discover community-tested solutions to common challenges
- Learn from real-world multi-cluster Kubernetes problem-solving

## How to Contribute a Fix

### 1. Create or Refine a Mission in KubeStellar Console

1. Use KubeStellar Console's AI Missions to solve a Kubernetes problem
2. Test and validate the mission works in your environment
3. Export the mission via **AI Missions → Export**

### 2. Prepare Your Fixer File

Your fixer file must conform to the `kc-mission-v1` format:

- **Format**: JSON (`.json`) or YAML (`.yaml` / `.yml`)
  - YAML is preferred for hand-authored fixes because it supports comments
- **Naming**: Use kebab-case for the filename and `name` field (e.g., `install-cert-manager.yaml`)
- **Required fields**: `version`, `name`, `mission`
- **Schema reference**: [`docs/fixer-schema.yaml`](docs/fixer-schema.yaml) contains the complete annotated field reference and example
- **Local validation**: Before opening a PR, run the mission validator described in Step 3 (`npm run validate` or `node scripts/validate-schema.mjs <path>`) to catch schema issues early

**Minimal example:**

```yaml
version: "kc-mission-v1"
name: "install-cert-manager"
missionClass: "install"

mission:
  title: "Install cert-manager"
  description: "Install cert-manager for automated TLS certificate management"
  type: "deploy"
  status: "completed"
  estimatedMinutes: 10

  steps:
    - title: "Apply cert-manager manifests"
      description: "Install cert-manager using kubectl"
      commands:
        - "kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml"

  resolution:
    summary: "cert-manager installed successfully and all pods are running"
    codeSnippets:
      - "kubectl get pods -n cert-manager"

metadata:
  tags:
    - "cert-manager"
    - "tls"
    - "security"
  difficulty: "beginner"
  platform: "kubernetes"

prerequisites:
  kubernetes: ">=1.24"
  tools:
    - "kubectl"
```

### 3. Validate Your Fix or Runbook Locally

Before submitting, run the mission validation and repository checks that back the automation in `scripts/`.

#### Install validation tooling

```bash
cd scripts
npm install
```

#### Validate schema for your changed file

Run schema validation from the repository root so paths match CI:

```bash
# From the repository root
node scripts/validate-schema.mjs fixes/your-category/your-fix.yaml

# Runbooks use the same validator
node scripts/validate-schema.mjs runbooks/your-runbook.json
```

If you prefer npm scripts, the equivalent command is:

```bash
cd scripts
npm run validate -- ../fixes/your-category/your-fix.yaml
# or
npm run validate -- ../runbooks/your-runbook.json
```

#### Run the script test suite

```bash
cd scripts
npm run test
```

#### Run integration testing for install missions

For install missions, run the mission executor against a disposable cluster (for example, Kind) before opening your PR. This mirrors the integration-style validation done by automation.

```bash
# From the repository root
export GITHUB_TOKEN=<github-token-with-models-access>
export KUBECONFIG=~/.kube/config
node scripts/mission-executor.mjs fixes/your-category/your-install-mission.json
```

You can validate command extraction without executing cluster changes by enabling dry-run mode:

```bash
DRY_RUN=true node scripts/mission-executor.mjs fixes/your-category/your-install-mission.json
```

#### Optional: run the mission scanner locally

This mirrors the PR scanning workflow and catches schema or safety issues before you open a pull request:

```bash
# From the repository root
node scripts/scan-pr.mjs fixes/your-category/your-fix.yaml
# or
node scripts/scan-pr.mjs runbooks/your-runbook.json
```

#### What CI checks run on pull requests?

The repository runs these checks automatically on PRs:

- **Validate Mission Schema** (`.github/workflows/validate-schema.yml`) — checks changed `fixes/` and `runbooks/` files with `scripts/validate-schema.mjs`
- **Scan Mission Files** (`.github/workflows/scan-missions.yml`) — runs `scripts/scan-pr.mjs` against changed mission files
- **Mission Content Validation** (`.github/workflows/mission-content-validation.yml`) — validates changed JSON mission content and referenced assets
- **KB Quality Enforcement** (`.github/workflows/kb-quality-enforcement.yml`) — scores changed JSON KB entries against the quality threshold

**Checklist:**
- [ ] File uses `kc-mission-v1` format
- [ ] `name` field matches filename (without extension) in kebab-case
- [ ] All required fields are present (`version`, `name`, `mission`)
- [ ] `node scripts/validate-schema.mjs <path>` passes for every changed fix or runbook
- [ ] `cd scripts && npm run test` passes
- [ ] Install missions have integration validation via `node scripts/mission-executor.mjs <path>`
- [ ] Mission has been tested in a real environment
- [ ] Tags and metadata accurately describe the fix
- [ ] Prerequisites clearly state what's needed to run the mission

## Generated Automation Files

Two tracked files in the repository root are written by the CNCF mission generation automation. They are intentionally committed artifacts, but they are **not** hand-authored content files.

### `generation-report.md`

- **Purpose:** Human-readable summary of a CNCF mission generation run.
- **Produced by:** `node scripts/generate-cncf-missions.mjs` from the repository root and the `.github/workflows/cncf-mission-gen.yml` workflow.
- **What it contains:** Run timestamp, mission/PR counts, skipped/error totals, per-project summary rows, and links to created Copilot issues or PRs. Batched CI runs also create `generation-report-<batch>.md` artifacts before merging them into the top-level report.
- **How to maintain it:** Do **not** edit it manually. Only regenerate it when you are intentionally working on the CNCF mission generation pipeline.
- **PR expectation:** Do not refresh this file for ordinary fix, runbook, or documentation PRs. If you changed generation logic and reran the generator, include the updated report only when the diff is an expected result of that work.

### `search-state.json`

- **Purpose:** Persistent search ledger for incremental mission generation.
- **Produced by:** `scripts/sources/search-state.mjs`, which is used by `scripts/generate-cncf-missions.mjs`.
- **What it contains:** A versioned JSON object keyed by source repository and knowledge source (`github-issues`, `github-discussions`, `reddit`, `stackoverflow`). Each entry stores `lastSearched`, `processedIds`, and `cursor` so later runs can skip already-processed items and continue pagination safely.
- **How to maintain it:** Do **not** edit it manually unless you are intentionally resetting or repairing generator state. The GitHub Actions workflow merges batch outputs and commits updated search state automatically when generation runs succeed.
- **PR expectation:** For normal contributor PRs, leave this file alone. Only include changes when your work specifically targets the generator or its state-management behavior.

### Regenerating these files

If you are working on the generation pipeline itself:

```bash
cd scripts
npm install
cd ..
node scripts/generate-cncf-missions.mjs
```

Run the generator from the **repository root** so it updates the tracked root-level files (`generation-report.md`, `search-state.json`) and the generated mission directories in the correct locations.

### CI enforcement status

- Normal contribution PR checks do **not** require contributors to regenerate these files.
- The CNCF mission generation workflow is the automation that updates them.
- `search-state.json` is the file that the workflow currently persists back to the repository; reports are also used as workflow artifacts and summaries.

### 4. Add Your Fix to the Repository

1. **Fork this repository**
2. **Choose the appropriate category** under `fixes/`:

   | Category | Description |
   |----------|-------------|
   | `multi-cluster/` | Cross-cluster deployment, federation, sync patterns |
   | `security/` | RBAC, network policies, secret management |
   | `networking/` | Service mesh, ingress, DNS, connectivity |
   | `observability/` | Monitoring, logging, alerting |
   | `workloads/` | Application deployment strategies |
   | `troubleshooting/` | Diagnostic missions for common issues |
   | `cost-optimization/` | Resource right-sizing, cluster efficiency |
   | `orbit/` | KubeStellar-specific orbit configuration |
   | `cncf-generated/` | Auto-generated fixes from CNCF projects (managed by automation) |

3. **Add your file** to the appropriate category:
   ```bash
   # Example: adding a cert-manager installation fix
   cp my-fix.yaml fixes/security/install-cert-manager.yaml
   ```

4. **Test the file can be imported**: If you have access to a KubeStellar Console instance, test importing your fix to ensure it loads correctly

### 5. Submit Your Pull Request

1. **Commit with DCO sign-off** (required):
   ```bash
   git add fixes/your-category/your-fix-file.yaml
   git commit -s -m "Add [mission name] fix"
   git push origin your-branch-name
   ```

2. **Create a pull request** with:
   - **Title**: Brief description of the fix (e.g., "Add cert-manager installation fix")
   - **Description**: Include:
     - What problem the mission solves
     - What Kubernetes version(s) you tested it on
     - Any special prerequisites or environment requirements
     - Link to any related issues

**Example PR description:**

```markdown
## Summary
Adds a mission fix for installing cert-manager on Kubernetes clusters.

## Problem Solved
Automates cert-manager installation and verification, saving users from manual YAML application and pod checking.

## Testing
- Tested on Kubernetes 1.28 and 1.29
- Verified in GKE and EKS clusters
- All cert-manager pods start successfully

## Prerequisites
- Kubernetes cluster >=1.24
- kubectl configured
```

## Developer Certificate of Origin (DCO)

All commits must be signed off to indicate your agreement with the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "Your commit message"
```

The `-s` flag adds a "Signed-off-by" line to your commit message automatically.

## Improving Existing Fixes

Found a bug or improvement in an existing fix?

1. Open an issue describing the problem
2. Submit a PR with your improvements
3. Include testing details in your PR description

## Repository Structure

```
console-kb/
├── fixes/                    # Community-contributed mission fixes
│   ├── multi-cluster/        # Cross-cluster patterns
│   ├── security/             # Security-related fixes
│   ├── networking/           # Network configuration
│   ├── observability/        # Monitoring and logging
│   ├── workloads/            # Application deployment
│   ├── troubleshooting/      # Diagnostic missions
│   ├── cost-optimization/    # Resource optimization
│   ├── orbit/                # KubeStellar orbit configs
│   └── cncf-generated/       # Auto-generated from CNCF repos
├── docs/                     # Documentation
│   └── fixer-schema.yaml     # Authoritative format reference
├── scripts/                  # Validation and automation scripts
└── README.md                 # Repository overview
```

## Slash Commands for Issue/PR Management

KubeStellar uses Prow and GitHub bots to help manage issues and pull requests:

**Issue Management:**
- `/assign` - Assign the issue to yourself
- `/unassign` - Remove your assignment
- `/good-first-issue` - Add the "good first issue" label
- `/help-wanted` - Add the "help wanted" label

**Pull Request Review:**
- `/lgtm` - Indicate "looks good to me"
- `/approve` - Approve the PR for merging
- `/hold` - Prevent the PR from being merged
- `/unhold` - Remove the hold

## Getting Help

- **Slack**: [#kubestellar on CNCF Slack](https://cloud-native.slack.com/archives/C097094RZ3M)
- **Issues**: [GitHub Issues](https://github.com/kubestellar/console-kb/issues)
- **Documentation**: [Console Documentation](https://github.com/kubestellar/console#readme)

## Code of Conduct

Please refer to the KubeStellar [Code of Conduct](https://github.com/kubestellar/.github/blob/main/CODE_OF_CONDUCT.md).

---

Thank you for contributing to Console KB! Every fix you share helps developers worldwide solve Kubernetes challenges more efficiently. 🚀
