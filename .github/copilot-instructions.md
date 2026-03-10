# Copilot Coding Agent Instructions

## Repository Structure

This is a knowledge-base repository containing **kc-mission-v1** troubleshooting mission files as JSON.

```
solutions/
  cncf-generated/<project-name>/<slug>.json   # Auto-generated missions
  cncf-install/<slug>.json                     # Install missions
  llm-d/<slug>.json                            # LLM-D missions
  platform-install/<slug>.json                 # Platform install missions
  index.json                                   # Auto-generated index
scripts/
  quality-scorer.mjs                           # Scores missions 0-100
  scanner.mjs                                  # Validates mission schema
```

## Mission Generation Tasks

When assigned an issue with the `cncf-mission-gen` label, your job is to create a single JSON file at the path specified in the issue.

### Steps

1. Read the issue body for the file path, source issue context, and JSON template
2. Create the JSON file with **real, specific content** based on the source issue
3. Run `node scripts/scanner.mjs` to validate the file
4. Commit with message: `🌱 Add <project>: <short description> mission`

### Critical Quality Rules

- **Steps MUST contain kubectl commands, YAML blocks, or file paths** — not generic advice
- **Description MUST include the exact error message or symptom** from the source issue
- **Resolution summary MUST explain the root cause** (use "because", "the root cause is", etc.)
- **Minimum 4 steps**, at least 2 with commands or code blocks
- **Never include**: Codecov reports, CI status, bot comments, PR template text, git diffs
- **Step titles must be specific**: "Update Cloudflare DNS record deletion to use zone ID" not "Apply the fix"

### JSON Schema

Every file must be valid `kc-mission-v1`:

```json
{
  "version": "kc-mission-v1",
  "name": "slug-name",
  "missionClass": "solution",
  "author": "KubeStellar Bot",
  "authorGithub": "kubestellar",
  "mission": {
    "title": "project: Short descriptive title",
    "description": "1-3 sentences with exact error/symptom.",
    "type": "troubleshooting|configuration|networking|security|storage|scaling",
    "status": "completed",
    "steps": [
      { "title": "Imperative verb phrase", "description": "Detailed with commands" }
    ],
    "resolution": {
      "summary": "2-4 sentences explaining WHY the fix works.",
      "codeSnippets": ["actual YAML or code"]
    }
  },
  "metadata": { ... },
  "prerequisites": { ... },
  "security": { ... }
}
```
