import type { StoredEvent } from './store.js';
import { groupBy, contextGrowthOf, CACHE_TTL_MS, BLOAT_GROWTH, BLOAT_FRESH_SHARE } from './metrics.js';

/**
 * Cause decomposition (#41): a finding names a symptom ("cache hit low") but
 * not the dominant cause behind it. Each decomposer partitions the symptom's
 * tokens — already collected per session — into candidate causes so the
 * recommendation can name the biggest one with its share, e.g.
 * "low cache hit — dominant cause: cold restarts after idle gaps (52%)".
 *
 * Buckets are disjoint by construction (every token lands in exactly one
 * bucket), so the shares are an honest partition rather than overlapping
 * estimates. A "baseline" bucket (steady-state, mixed) absorbs the tokens with
 * no actionable cause; it is never reported as the dominant lever.
 */

export interface Cause {
  /** Stable id, e.g. 'cold-restarts'. */
  key: string;
  /** Human phrase for the recommendation line. */
  label: string;
  /** Tokens attributed to this cause. */
  tokens: number;
  /** tokens / total symptom tokens (0..1). */
  share: number;
}

export interface CauseBreakdown {
  /** Finding key this explains. */
  findingKey: string;
  /** Highest-share actionable cause. */
  dominant: Cause;
  /** All non-empty causes incl. the baseline bucket, sorted desc by share. */
  causes: Cause[];
}

/** Below this turn count a session never builds reusable cache. */
const SHORT_SESSION_TURNS = 4;
/** A cause has to own at least this share before it is named the dominant lever. */
const DOMINANT_FLOOR = 0.15;
/** Buckets that capture "nothing actionable" — never reported as dominant. */
const BASELINE_KEYS = new Set(['steady-state', 'other-rework']);

const freshOf = (e: StoredEvent) => e.input_tokens + e.cache_creation_tokens;
const spendOf = (e: StoredEvent) => e.input_tokens + e.output_tokens;

/**
 * Where did the fresh-paid input (input + cache writes) actually go? Each turn
 * lands in exactly one bucket, precedence cold-restart > short-session >
 * context-churn > steady-state.
 */
function decomposeCacheHit(sessions: StoredEvent[][]): Cause[] {
  const b = { cold: 0, short: 0, churn: 0, steady: 0 };
  for (const arr of sessions) {
    const short = arr.length < SHORT_SESSION_TURNS;
    const growth = contextGrowthOf(arr);
    // Mirror metrics.ts exactly: late-half growth only counts as churn when it
    // is re-paid FRESH, not served from cache. Otherwise a well-cached session
    // would be mislabelled, contradicting the tool's own contextBloatShare.
    const bloated =
      growth !== undefined && growth.ratio >= BLOAT_GROWTH && growth.lateFreshShare >= BLOAT_FRESH_SHARE;
    const lateStart = arr.length - Math.floor(arr.length / 2);
    for (let i = 0; i < arr.length; i++) {
      const f = freshOf(arr[i]);
      if (f === 0) continue;
      if (i > 0 && Date.parse(arr[i].ts) - Date.parse(arr[i - 1].ts) > CACHE_TTL_MS) {
        b.cold += f;
      } else if (short) {
        b.short += f;
      } else if (bloated && i >= lateStart) {
        b.churn += f;
      } else {
        b.steady += f;
      }
    }
  }
  return [
    { key: 'cold-restarts', label: 'cold restarts after idle gaps (>5-min cache TTL)', tokens: b.cold, share: 0 },
    { key: 'short-sessions', label: 'sessions too short to build reusable cache', tokens: b.short, share: 0 },
    { key: 'context-churn', label: 'context churn — late-session growth re-paid fresh', tokens: b.churn, share: 0 },
    { key: 'steady-state', label: 'steady-state context (first loads, necessary writes)', tokens: b.steady, share: 0 },
  ];
}

/**
 * Rework tokens are coding/testing spend after a session's first failure. Each
 * such session is classified once by its dominant profile, and its whole
 * rework contribution attributed there.
 */
function decomposeRework(sessions: StoredEvent[][]): Cause[] {
  const b = { noGate: 0, broad: 0, stacked: 0, other: 0 };
  for (const arr of sessions) {
    const firstFail = arr.findIndex(
      (e) => e.is_error && (e.activity === 'testing' || e.activity === 'coding'),
    );
    if (firstFail === -1) continue;
    let rework = 0;
    for (let i = firstFail + 1; i < arr.length; i++) {
      if (arr[i].activity === 'coding' || arr[i].activity === 'testing') rework += spendOf(arr[i]);
    }
    if (rework === 0) continue;

    // Profile the whole session to pick the most likely root cause.
    let testingTok = 0, sessSpend = 0, errors = 0, fixes = 0;
    let prev: string | undefined;
    for (const e of arr) {
      sessSpend += spendOf(e);
      if (e.activity === 'testing') testingTok += spendOf(e);
      if (e.is_error) errors++;
      if (prev === 'testing' && e.activity === 'coding') fixes++;
      prev = e.activity;
    }
    const testingShare = sessSpend ? testingTok / sessSpend : 0;
    const errorRate = arr.length ? errors / arr.length : 0;
    if (testingShare < 0.02) b.noGate += rework;
    else if (errorRate > 0.3) b.broad += rework;
    else if (fixes >= 3) b.stacked += rework;
    else b.other += rework;
  }
  return [
    { key: 'no-test-gate', label: 'code written without a test gate (failures surface late)', tokens: b.noGate, share: 0 },
    { key: 'broad-failures', label: 'broad test failures (suite failing widely)', tokens: b.broad, share: 0 },
    { key: 'stacked-corrections', label: 'stacked correction loops (repeated fix attempts)', tokens: b.stacked, share: 0 },
    { key: 'other-rework', label: 'mixed — no single dominant pattern', tokens: b.other, share: 0 },
  ];
}

const DECOMPOSERS: Record<string, (sessions: StoredEvent[][]) => Cause[]> = {
  'low-cache-hit': decomposeCacheHit,
  'high-rework': decomposeRework,
};

/**
 * Partition a finding's symptom tokens into candidate causes and name the
 * dominant actionable one. Returns undefined when the finding has no
 * decomposer, has no symptom tokens, or has no cause clearing DOMINANT_FLOOR
 * (better to stay silent than over-claim a 4%-of-the-problem "cause").
 */
export function decomposeCause(findingKey: string, events: StoredEvent[]): CauseBreakdown | undefined {
  const fn = DECOMPOSERS[findingKey];
  if (!fn) return undefined;
  const sessions = [...groupBy(events, 'session_id').values()];
  const raw = fn(sessions);
  const total = raw.reduce((s, c) => s + c.tokens, 0);
  if (total <= 0) return undefined;
  const causes = raw
    .map((c) => ({ ...c, share: c.tokens / total }))
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.share - a.share);
  const dominant = causes.find((c) => !BASELINE_KEYS.has(c.key) && c.share >= DOMINANT_FLOOR);
  if (!dominant) return undefined;
  return { findingKey, dominant, causes };
}
