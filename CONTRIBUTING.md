# Contributing to KubeStellar Console Knowledge Base

Greetings! We are grateful for your interest in joining the KubeStellar community and making a positive impact. Whether you're sharing a new fixer mission, improving documentation, or helping review submissions, your contributions are essential to this knowledge base.

To get started, kindly read through this document and familiarize yourself with our code of conduct. If you have any inquiries, please feel free to reach out to us on [Slack](https://cloud-native.slack.com/archives/C097094RZ3M).

We can't wait to collaborate with you!

## Fixer Submission Workflow

Most contributions to this repository are fixer missions shared from KubeStellar Console. Follow this workflow when submitting a new fix.

### 1. Create your fixer file

- Export a successful mission from KubeStellar Console or create a new fixer file by hand
- Save it as YAML (`.yaml` / `.yml`) or JSON (`.json`)
- YAML is preferred for hand-authored fixes because it supports comments
- Keep `name` in kebab-case and make it match the filename without the extension

Use [`docs/fixer-schema.yaml`](docs/fixer-schema.yaml) as the annotated format reference and field-by-field example for the `kc-mission-v1` schema.

### 2. Put the file in the right `fixes/` category

Add your fixer under the most specific category in `fixes/`:

- `fixes/cncf-generated/`
- `fixes/cncf-install/`
- `fixes/cost-optimization/`
- `fixes/llm-d/`
- `fixes/multi-cluster/`
- `fixes/networking/`
- `fixes/observability/`
- `fixes/orbit/`
- `fixes/platform-install/`
- `fixes/security/`
- `fixes/troubleshoot/`
- `fixes/troubleshooting/`
- `fixes/workloads/`

If more than one category seems possible, choose the one that best matches the primary problem the fixer solves.

### 3. Validate locally before opening a PR

Install the validation dependencies and run the schema validator locally:

```bash
cd scripts
npm install --no-audit
cd ..
node scripts/validate-schema.mjs fixes/<category>/<your-fix>.yaml
```

To validate every fixer in the repository, run:

```bash
node scripts/validate-schema.mjs --all
```

### 4. Submit your pull request

- Commit your fixer file in the appropriate `fixes/` category
- Open a PR describing what problem the fixer solves
- Include any relevant issue links, prerequisites, and validation notes in the PR description

## Fixer File Format

All files under `fixes/` must use the `kc-mission-v1` fixer format.

- JSON (`.json`) and YAML (`.yaml` / `.yml`) are accepted
- YAML is preferred for hand-authored fixes because it supports comments
- `name` should be kebab-case and match the filename without the extension

See [`docs/fixer-schema.yaml`](docs/fixer-schema.yaml) for the annotated field reference and a complete example.

## Getting Started

### Issues

Before reporting a new issue, please search our issue archive to see if it has already been reported or resolved.

To claim an issue that you are interested in, assign it to yourself by leaving a comment `/assign`. You may also remove yourself from an issue with `/unassign` in a comment.

### Pull Requests

When submitting a pull request, clear communication is appreciated. This can be achieved by providing:

- Detailed description of the problem you are trying to solve, along with links to related GitHub issues
- Explanation of your solution, including links to any design documentation and discussions
- Information on how you tested and validated your solution
- Updates to relevant documentation and examples, if applicable

### Commits

In conformance with CNCF expectations, we will only merge commits that indicate your agreement with the Developer Certificate of Origin. This is indicated by doing a Git "sign-off" on the commit:

```bash
git commit -s -m "Your commit message"
```

## Slash Commands

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

## Code of Conduct

Please refer to the KubeStellar [Code of Conduct](https://github.com/kubestellar/.github/blob/main/CODE_OF_CONDUCT.md).
