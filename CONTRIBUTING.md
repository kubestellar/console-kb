# Contributing to KubeStellar

Greetings! We are grateful for your interest in joining the KubeStellar community and making a positive impact. Whether you're raising issues, enhancing documentation, fixing bugs, or developing new features, your contributions are essential to our success.

To get started, kindly read through this document and familiarize yourself with our code of conduct. If you have any inquiries, please feel free to reach out to us on [Slack](https://cloud-native.slack.com/archives/C097094RZ3M).

We can't wait to collaborate with you!

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
