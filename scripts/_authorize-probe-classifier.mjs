/**
 * Response-shape classifier for the authorize-URL probe.
 *
 * Compatibility re-export: the source of truth moved to
 * src/cc-authorize-probe.ts in v3.32.0 so `dario doctor --probe` could
 * reuse the same logic. This file re-exports the classifier so existing
 * imports in scripts/check-cc-authorize-probe.mjs and test/cc-authorize-
 * probe-classifier.mjs continue to work unchanged.
 */

export {
  classifyAuthorizeResponse,
  combineVerdicts,
  REJECT_MARKER,
} from '../dist/cc-authorize-probe.js';
