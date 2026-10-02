/**
 * Thin re-export shim over scripts/catalogs/k8s-platforms.mjs (console-kb#3637)
 * kept so existing imports (generators, tests) don't break.
 * See scripts/catalogs/k8s-platforms.mjs for the implementation.
 */

export * from './catalogs/k8s-platforms.mjs';
