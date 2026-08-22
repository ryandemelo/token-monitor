import type { Metrics } from '../metrics.js';
import type { StoredEvent } from '../store.js';
import type { MetricKey } from '../followthrough.js';

/**
 * The contract for a waste rule.
 *
 * One rule per file in this directory, listed once in index.ts. Everything a
 * rule needs is passed in; a rule imports nothing from the report, the CLI, or
 * the recommendation engine, so it can be written and tested on its own.
 *
 * The type import above is erased at runtime, which is what keeps
 * followthrough.ts -> rules/index.ts -> rules/<key>.ts a straight line rather
 * than a cycle. Keep runtime imports here pointed at leaf modules
 * (metrics, pricing, fmt) only.
 */

/** The improvement goal a savings estimate is priced against. */
export interface Target {
  value: number;
  /** True when derived from the user's own top-quartile sessions. */
  personal: boolean;
}

/** $/token rates blended over the user's actual model mix in the window. */
export interface BlendedRates {
  input: number;
  cacheRead: number;
  /** Average realized $/spend-token across all priced usage. */
  spend: number;
  /** Realized $/spend-token on premium models only. */
  premium: number;
  /** Cheapest priced non-premium model the user already runs; tier-assumed when absent. */
  cheap: number;
  /**
   * Blended $/token surcharge for writing to the 1-hour cache instead of the
   * 5-minute one; 0 when no model in the mix publishes an extended-tier price.
   */
  extendedWritePremium: number;
  estimated: boolean;
}

/** One session (or one subagent run) with its own metrics and turns. */
export interface SessionInfo {
  sessionId: string;
  project: string;
  date: string;
  m: Metrics;
  events: StoredEvent[];
  /**
   * This "session" is one subagent run, not a conversation. Evidence and
   * personalized targets skip these — see the comments at their call sites.
   */
  isSidechain: boolean;
}

export interface SavingsArgs {
  m: Metrics;
  rates: BlendedRates;
  /** Every session in the window, subagent runs included. */
  sessions: SessionInfo[];
  /** The target this estimate is priced against, when the rule declares one. */
  target?: Target;
}

export interface ClauseArgs {
  events: StoredEvent[];
  rates: BlendedRates;
  /** Multiplier turning a window figure into a monthly one. */
  monthly: number;
}

/**
 * Savings families. Levers inside one family overlap (cold-restart tokens are
 * part of the cache-hit gap; misroute tokens are a subset of overuse tokens),
 * so `potentialBill` takes the max within a family and sums across families.
 * A rule with no family contributes evidence and advice but no headline $.
 */
export type RuleFamily = 'caching' | 'routing' | 'rework';

export interface Rule {
  /** Stable id. Follow-through baselines key on it — never rename a shipped key. */
  key: string;
  /** The tracked metric this rule wants to move. */
  metric: MetricKey;
  direction: 'up' | 'down';
  family?: RuleFamily;
  /** Short human name for `token-monitor rules`. */
  title: string;
  /** What it measures, why it costs money, and what to change. Printed by `rules <key>`. */
  docs: string;
  /**
   * The firing condition. Return the finding's message, or undefined to stay
   * quiet. Gets ONLY the metrics — it is also called on merged team metrics,
   * where no events exist.
   */
  fires(m: Metrics): string | undefined;
  /** How bad is this session for this rule (higher = worse), and its evidence label. */
  score?(s: SessionInfo): { score: number; label: string };
  /** Static improvement target for the savings math. */
  target?: number;
  /**
   * Personalized target: with enough qualifying sessions, the user's own
   * top-quartile value replaces `target` ("your best sessions prove this is
   * reachable"). Only for per-session skills — model choice is not one.
   */
  personalTarget?: { metric: (m: Metrics) => number; direction: 'up' | 'down' };
  /** Estimated $ saved over the window if the metric hit its target. */
  savings?(a: SavingsArgs): number | undefined;
  /** Extra sentence appended to the message when the rule fires (needs events). */
  clause?(a: ClauseArgs): string;
}
