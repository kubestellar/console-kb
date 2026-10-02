# scripts/catalogs/

Project-catalog data modules used by the mission generators and outreach
tooling. These are data, not CLI entrypoints or library code, and are kept
separate from the rest of `scripts/` for that reason (console-kb#3637).

| file | provenance |
| --- | --- |
| `cncf-projects.mjs` | **Regenerated.** Written by `scripts/fetch-cncf-landscape.mjs`. Do not hand-edit — rerun the fetch script instead. |
| `k8s-platforms.mjs` | Hand-maintained. |
| `other-projects.mjs` | Hand-maintained. |

Back-compat shims at the old flat paths (`scripts/cncf-projects.mjs`,
`scripts/k8s-platforms.mjs`, `scripts/other-projects.mjs`) re-export from this
directory so existing imports keep working.
