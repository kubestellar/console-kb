/**
 * Mission scanner — self-contained security and schema validation module
 * for KubeStellar Console KB contributed missions.
 *
 * This file is a thin re-export shim over scripts/scanner/ (console-kb#3195)
 * kept so existing imports (workflows, generators, and tests) don't break.
 * See scripts/scanner/index.mjs for the implementation.
 */

export * from './scanner/index.mjs';
