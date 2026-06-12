import type { StoredEvent } from './store.js';
import type { Activity } from './types.js';
import { ACTIVITIES } from './types.js';
import { costOf, PREMIUM_MODEL_RE } from './pricing.js';

/** Anthropic's default prompt-cache TTL — gaps past this re-pay the context. */
export const CACHE_TTL_MS = 5 * 60_000;
/** Sessions need this many turns before a context-bloat trend is measurable. */
export const BLOAT_MIN_TURNS = 8;
const BLOAT_GROWTH = 2; // late-half avg context ≥ 2× early half
const BLOAT_FRESH_SHARE = 0.3; // ...and ≥30% of late context is re-paid fresh

export interface Metrics {
  events: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
  /** input + output — the "work" tokens used for activity shares. */
  spendTokens: number;
  costUsd: number;
  costEstimated: boolean;
  costUnpricedTokens: number;
  cacheHitRatio: number;
  /** Tokens spent on code/test turns after the first failure in a session. */
  reworkTokens: number;
  /** Share of spend after the first test failure in a session (fix loops). */
  reworkRatio: number;
  errorEvents: number;
  byActivity: Record<Activity, { tokens: number; share: number; events: number }>;
  byModel: Record<string, { tokens: number; costUsd: number }>;
  thinkToCodeRatio: number;
  /** Sessions long enough (≥ BLOAT_MIN_TURNS) to measure a context trend. */
  trendSessions: number;
  /** Trend sessions whose late-half context grew ≥2× without cache keeping pace. */
  bloatedSessions: number;
  contextBloatShare: number;
  /** Turns arriving after a gap past the cache TTL, and the input-side tokens they re-paid. */
  coldRestartTurns: number;
  coldRestartTokens: number;
  /** Re-paid tokens as a share of all fresh-paid input (input + cache writes). */
  coldRestartShare: number;
  /** Premium-model tokens spent on exploration/conversation turns. */
  premiumWasteTokens: number;
  premiumWasteShare: number;
  /** Tokens on turns re-running a tool that errored in the immediately previous turn. */
  retryTokens: number;
  retryShare: number;
}

export function computeMetrics(events: StoredEvent[]): Metrics {
  const byActivity = Object.fromEntries(
    ACTIVITIES.map((a) => [a, { tokens: 0, share: 0, events: 0 }]),
  ) as Metrics['byActivity'];
  const byModel: Metrics['byModel'] = {};
  const sessions = new Set<string>();

  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, thinking = 0;
  let costUsd = 0, costEstimated = false, unpriced = 0, errorEvents = 0;
  let premiumWasteTokens = 0;

  // Rework: group by session, walk chronologically, count spend after first failed event.
  const bySession = new Map<string, StoredEvent[]>();

  for (const e of events) {
    sessions.add(e.session_id);
    input += e.input_tokens;
    output += e.output_tokens;
    cacheRead += e.cache_read_tokens;
    cacheCreate += e.cache_creation_tokens;
    thinking += e.thinking_tokens;
    if (e.is_error) errorEvents++;

    const spend = e.input_tokens + e.output_tokens;
    const act = (ACTIVITIES.includes(e.activity as Activity) ? e.activity : 'conversation') as Activity;
    byActivity[act].tokens += spend;
    byActivity[act].events++;
    if ((act === 'exploration' || act === 'conversation') && PREMIUM_MODEL_RE.test(e.model)) {
      premiumWasteTokens += spend;
    }

    const cost = costOf(e.model, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_creation_tokens);
    if (cost.priced) {
      costUsd += cost.usd;
      if (cost.estimated) costEstimated = true;
    } else {
      unpriced += spend;
    }
    const m = (byModel[e.model] ??= { tokens: 0, costUsd: 0 });
    m.tokens += spend;
    m.costUsd += cost.usd;

    let arr = bySession.get(e.session_id);
    if (!arr) bySession.set(e.session_id, (arr = []));
    arr.push(e);
  }

  const spendTokens = input + output;
  for (const a of ACTIVITIES) {
    byActivity[a].share = spendTokens ? byActivity[a].tokens / spendTokens : 0;
  }

  let reworkTokens = 0;
  let trendSessions = 0, bloatedSessions = 0;
  let coldRestartTurns = 0, coldRestartTokens = 0;
  let retryTokens = 0;
  for (const arr of bySession.values()) {
    const firstFail = arr.findIndex((e) => e.is_error && (e.activity === 'testing' || e.activity === 'coding'));
    if (firstFail !== -1) {
      for (let i = firstFail + 1; i < arr.length; i++) {
        const e = arr[i];
        if (e.activity === 'coding' || e.activity === 'testing') {
          reworkTokens += e.input_tokens + e.output_tokens;
        }
      }
    }

    // Session hygiene: a gap past the cache TTL means this turn re-paid its
    // context as fresh input / a new cache write instead of a cheap read.
    for (let i = 1; i < arr.length; i++) {
      if (Date.parse(arr[i].ts) - Date.parse(arr[i - 1].ts) > CACHE_TTL_MS) {
        coldRestartTurns++;
        coldRestartTokens += arr[i].input_tokens + arr[i].cache_creation_tokens;
      }
    }

    // Context bloat trend: late-half avg context vs early half.
    const growth = contextGrowthOf(arr);
    if (growth !== undefined) {
      trendSessions++;
      if (growth.ratio >= BLOAT_GROWTH && growth.lateFreshShare >= BLOAT_FRESH_SHARE) bloatedSessions++;
    }

    // Retry loops: a turn re-running a tool that just errored is paying for a retry.
    let prevErrTools: Set<string> | undefined;
    for (const e of arr) {
      const tools = parseTools(e.tools);
      if (prevErrTools !== undefined && tools.some((t) => prevErrTools!.has(t))) {
        retryTokens += e.input_tokens + e.output_tokens;
      }
      prevErrTools = e.is_error ? new Set(tools) : undefined;
    }
  }

  const codingTokens = byActivity.coding.tokens || 1;
  return {
    events: events.length,
    sessions: sessions.size,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    thinkingTokens: thinking,
    spendTokens,
    costUsd,
    costEstimated,
    costUnpricedTokens: unpriced,
    cacheHitRatio: cacheRead + input + cacheCreate ? cacheRead / (cacheRead + input + cacheCreate) : 0,
    reworkTokens,
    reworkRatio: spendTokens ? reworkTokens / spendTokens : 0,
    errorEvents,
    byActivity,
    byModel,
    thinkToCodeRatio: (byActivity.thinking.tokens + byActivity.exploration.tokens) / codingTokens,
    trendSessions,
    bloatedSessions,
    contextBloatShare: trendSessions ? bloatedSessions / trendSessions : 0,
    coldRestartTurns,
    coldRestartTokens,
    coldRestartShare: input + cacheCreate ? coldRestartTokens / (input + cacheCreate) : 0,
    premiumWasteTokens,
    premiumWasteShare: spendTokens ? premiumWasteTokens / spendTokens : 0,
    retryTokens,
    retryShare: spendTokens ? retryTokens / spendTokens : 0,
  };
}

export function parseTools(tools: string): string[] {
  try {
    const arr = JSON.parse(tools);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Late-half vs early-half context per turn for one session, plus how much of
 * the late context is paid fresh (input + cache writes) rather than read from
 * cache. Undefined when the session is too short to show a trend.
 */
export function contextGrowthOf(
  arr: StoredEvent[],
): { ratio: number; lateFreshShare: number } | undefined {
  if (arr.length < BLOAT_MIN_TURNS) return undefined;
  const ctx = (e: StoredEvent) => e.input_tokens + e.cache_read_tokens + e.cache_creation_tokens;
  const half = Math.floor(arr.length / 2);
  const early = arr.slice(0, half);
  const late = arr.slice(arr.length - half);
  const earlyCtx = early.reduce((s, e) => s + ctx(e), 0) / half;
  const lateCtxTotal = late.reduce((s, e) => s + ctx(e), 0);
  if (!earlyCtx || !lateCtxTotal) return undefined;
  const lateFresh = late.reduce((s, e) => s + e.input_tokens + e.cache_creation_tokens, 0);
  return { ratio: lateCtxTotal / half / earlyCtx, lateFreshShare: lateFresh / lateCtxTotal };
}

export function groupBy<K extends keyof StoredEvent>(events: StoredEvent[], key: K): Map<string, StoredEvent[]> {
  const map = new Map<string, StoredEvent[]>();
  for (const e of events) {
    const k = String(e[key]);
    let arr = map.get(k);
    if (!arr) map.set(k, (arr = []));
    arr.push(e);
  }
  return map;
}
