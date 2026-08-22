import type { Rule } from './types.js';
import lowCacheHit from './low-cache-hit.js';
import highRework from './high-rework.js';
import lowThinkCode from './low-think-code.js';
import premiumModelOveruse from './premium-model-overuse.js';
import contextBloat from './context-bloat.js';
import coldRestarts from './cold-restarts.js';
import premiumMisroute from './premium-misroute.js';
import toolRetryLoops from './tool-retry-loops.js';
import toolResultBloat from './tool-result-bloat.js';
import contextFloorCreep from './context-floor-creep.js';
import abandonedWork from './abandoned-work.js';
import errorCascade from './error-cascade.js';

/**
 * The rule registry.
 *
 * Adding a finding: write `src/rules/<key>.ts` exporting a default Rule (see
 * types.ts for the contract), add it to this list, and add a test with a
 * fixture. Nothing else in the pipeline changes — the report, the dashboard,
 * follow-through, savings and the LLM payload all read from here.
 *
 * Order is the order findings fire in, which is the order they appear when
 * savings can't rank them. Keep new rules at the end unless there is a reason.
 */
export const RULES: Rule[] = [
  lowCacheHit,
  highRework,
  lowThinkCode,
  premiumModelOveruse,
  contextBloat,
  coldRestarts,
  premiumMisroute,
  toolRetryLoops,
  toolResultBloat,
  contextFloorCreep,
  abandonedWork,
  errorCascade,
];

export const RULE_BY_KEY: Map<string, Rule> = new Map(RULES.map((r) => [r.key, r]));

// A duplicate key would silently shadow a rule and corrupt follow-through
// baselines (they are keyed on it). Fail at import instead — the contributor
// who just copied a rule file sees it on the first `npm test`.
if (RULE_BY_KEY.size !== RULES.length) {
  const seen = new Set<string>();
  const dup = RULES.map((r) => r.key).find((k) => seen.size === seen.add(k).size);
  throw new Error(`duplicate rule key "${dup}" in src/rules/index.ts`);
}

export type { Rule } from './types.js';
