/**
 * Shared read-once constants for the mission-generator scripts.
 *
 * Extracted from the five top-level scripts that used to re-declare the
 * same three env-var parsers at the top of their file — see
 * kubestellar/console-kb#3500. Values are captured at module load, matching
 * the previous behaviour of the inline `const DRY_RUN = ...` etc.
 *
 * Consumers can still override per-suite via the standard vitest pattern
 * (mutate `process.env.<VAR>`, `vi.resetModules()`, dynamic-import the
 * consumer script — the fresh module graph re-imports this file and
 * re-evaluates the constants against the current env).
 */

// True when DRY_RUN=true (case-sensitive). Anything else — including
// undefined, empty string, '1', 'yes' — is false. Match this exactly to
// preserve behaviour of the five previous inline copies.
export const DRY_RUN = process.env.DRY_RUN === 'true'

// Batch index for parallel workflow-matrix jobs. `null` when unset (which
// callers treat as "process all items, no slicing").
export const BATCH_INDEX =
  process.env.BATCH_INDEX != null ? parseInt(process.env.BATCH_INDEX, 10) : null

// Number of items per batch. Default 20 matches the previous inline copies.
export const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '20', 10)
