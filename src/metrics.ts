import type { StoredEvent } from './store.js';
import type { Activity } from './types.js';
import { ACTIVITIES } from './types.js';
import { costOf, PREMIUM_MODEL_RE } from './pricing.js';

/** Anthropic's default prompt-cache TTL — gaps past this re-pay the context. */
export const CACHE_TTL_MS = 5 * 60_000;
/** The opt-in extended TTL. A gap under this is still a cache hit, not a re-pay. */
export const EXTENDED_CACHE_TTL_MS = 60 * 60_000;

/**
 * Which TTL a session's gaps should be measured against.
 *
 * A session that writes most of its cache against the 1-hour ephemeral tier
 * genuinely keeps its context warm for an hour, so scoring its 20-minute gaps
 * as "re-paid the whole context" invents a problem the user does not have —
 * and a false finding costs more trust than a missed one. The decision is made
 * once per session rather than per turn: one number the report can name and a
 * user can check by hand, instead of a per-turn rule nobody can reproduce.
 *
 * Rows without the split (every non-Claude-Code source, and everything
 * collected before 0.13) report 0 here and land on the 5-minute default — the
 * exact assumption they were already measured under, so no history moves.
 */
export function effectiveCacheTtlOf(rows: StoredEvent[]): number {
  let writes = 0, extended = 0;
  for (const e of rows) {
    writes += e.cache_creation_tokens;
    extended += e.cache_creation_1h_tokens ?? 0;
  }
  return writes > 0 && extended * 2 >= writes ? EXTENDED_CACHE_TTL_MS : CACHE_TTL_MS;
}
/** Sessions need this many turns before a context-bloat trend is measurable. */
export const BLOAT_MIN_TURNS = 8;
export const BLOAT_GROWTH = 2; // late-half avg context ≥ 2× early half
export const BLOAT_FRESH_SHARE = 0.3; // ...and ≥30% of late context is re-paid fresh

/**
 * The conversation a turn belongs to from the user's point of view: a subagent
 * run counts under the session that spawned it, everything else under itself.
 * `sessions` counts these, so a fan-out of 40 agents stays ONE session in the
 * report while each run keeps its own chronology for per-session math.
 */
export function rootSessionOf(e: StoredEvent): string {
  return e.parent_session_id || e.session_id;
}

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
  /**
   * Turns arriving after a gap past the cache TTL, and the input-side tokens
   * they re-paid. Main-loop only, numerator AND denominator: a subagent run is
   * a back-to-back burst that never idles, so counting its fresh input in the
   * denominator would dilute the ratio toward zero while contributing almost
   * nothing to the top — and its remedy (batch prompts, split idle work) is
   * not something anyone can apply to a run that is spawned and exits.
   */
  coldRestartTurns: number;
  coldRestartTokens: number;
  /** Re-paid tokens as a share of main-loop fresh-paid input (input + cache writes). */
  coldRestartShare: number;
  /** That denominator, carried so a team merge can recombine the ratio exactly. */
  coldRestartBaseTokens: number;
  /** Premium-model tokens spent on exploration/conversation turns. */
  premiumWasteTokens: number;
  premiumWasteShare: number;
  /** Tokens on turns re-running a tool that errored in the immediately previous turn. */
  retryTokens: number;
  retryShare: number;
  /**
   * Cache-write tokens on the 1-hour ephemeral tier, and their share of all
   * cache writes — main loop AND subagent runs, which routinely sit on
   * different tiers, so this window-wide share is NOT the per-session
   * classifier. Sessions are classified individually (effectiveCacheTtlOf).
   */
  extendedCacheTokens: number;
  extendedCacheShare: number;
  /** Sessions whose gaps were scored against the 1-hour TTL, not 5 minutes. */
  extendedCacheSessions: number;
  /** Subagent (sidechain) runs seen in the window, and what they spent. */
  subagentSessions: number;
  subagentSpendTokens: number;
  /**
   * Subagent spend as a share of all spend. Descriptive, NOT a waste signal:
   * fan-out is often exactly the right way to do the work. It is here because
   * every other number moves when it is counted — and until this release it
   * was not counted at all.
   */
  subagentShare: number;
}

/**
 * Premium-model share of spend. Lives here rather than in followthrough.ts so
 * a rule can use it without importing the module that imports the rules.
 * Re-exported from followthrough.js for the existing call sites.
 */
export function premiumShare(m: Metrics): number {
  const premium = Object.entries(m.byModel).filter(([name]) => PREMIUM_MODEL_RE.test(name));
  if (!premium.length) return 0;
  return premium.reduce((s, [, v]) => s + v.tokens, 0) / (m.spendTokens || 1);
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
  let subagentSpendTokens = 0;
  let mainFreshPaid = 0;
  let extendedCacheTokens = 0;
  let extendedCacheSessions = 0;
  const subagentSessions = new Set<string>();

  // Rework: group by session, walk chronologically, count spend after first failed event.
  const bySession = new Map<string, StoredEvent[]>();

  for (const e of events) {
    sessions.add(rootSessionOf(e));
    if (e.is_sidechain) {
      // A legacy inlined sidechain turn has no transcript of its own, so its
      // session id IS the parent's — counting it would invent a run.
      if (e.session_id !== e.parent_session_id) subagentSessions.add(e.session_id);
      subagentSpendTokens += e.input_tokens + e.output_tokens;
    } else {
      mainFreshPaid += e.input_tokens + e.cache_creation_tokens;
    }
    extendedCacheTokens += e.cache_creation_1h_tokens ?? 0;
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

    // Both hygiene signals below describe the CONVERSATION, so they run over
    // the group's main-loop turns only. Filtering per row rather than per
    // group also handles the legacy transcripts that inlined sidechain turns
    // under the main session id, where the group is mixed.
    const mainRows = arr.some((e) => e.is_sidechain) ? arr.filter((e) => !e.is_sidechain) : arr;

    // Session hygiene: a gap past the cache TTL means this turn re-paid its
    // context as fresh input / a new cache write instead of a cheap read.
    // Subagent runs sit out both sides of this ratio — see coldRestartShare.
    const ttl = effectiveCacheTtlOf(mainRows);
    if (ttl === EXTENDED_CACHE_TTL_MS) extendedCacheSessions++;
    for (let i = 1; i < mainRows.length; i++) {
      if (Date.parse(mainRows[i].ts) - Date.parse(mainRows[i - 1].ts) > ttl) {
        coldRestartTurns++;
        coldRestartTokens += mainRows[i].input_tokens + mainRows[i].cache_creation_tokens;
      }
    }

    // Context bloat trend: late-half avg context vs early half. Subagent runs
    // are deliberately NOT trend sessions. They are long enough to qualify and
    // there are far more of them than there are conversations, so counting
    // them would bury the signal in a denominator of runs nobody can act on:
    // the remedy for bloat is to compact or restart, and a subagent is spawned
    // fresh, does one job, and exits. (Their spend still counts everywhere
    // else — this is about which sessions the ratio describes.)
    const growth = mainRows.length ? contextGrowthOf(mainRows) : undefined;
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
    coldRestartShare: mainFreshPaid ? coldRestartTokens / mainFreshPaid : 0,
    coldRestartBaseTokens: mainFreshPaid,
    premiumWasteTokens,
    premiumWasteShare: spendTokens ? premiumWasteTokens / spendTokens : 0,
    retryTokens,
    retryShare: spendTokens ? retryTokens / spendTokens : 0,
    extendedCacheTokens,
    extendedCacheShare: cacheCreate ? extendedCacheTokens / cacheCreate : 0,
    extendedCacheSessions,
    subagentSessions: subagentSessions.size,
    subagentSpendTokens,
    subagentShare: spendTokens ? subagentSpendTokens / spendTokens : 0,
  };
}

/**
 * What switching to the 1-hour cache could recover, for the sessions still on
 * the 5-minute default: the input they re-paid resuming after a gap that the
 * extended TTL would have covered (5 min < gap <= 1 h).
 *
 * Gaps longer than an hour are excluded — the extended cache would not have
 * saved those either, so counting them would oversell the switch. Sessions
 * already on the extended tier contribute nothing: they have the feature.
 *
 * `writeTokens` is the cost side, and it deliberately covers EVERY 5-minute
 * session, including those with no recoverable gap at all. The cache tier is
 * a setting, not a per-session choice: turning it on makes all of those
 * sessions pay the higher write premium, so charging only the ones that
 * benefit would quote a net saving the user cannot actually get.
 */
export function extendedCacheOpportunity(events: StoredEvent[]): {
  recoverableTokens: number;
  writeTokens: number;
  sessions: number;
} {
  let recoverableTokens = 0, writeTokens = 0, sessions = 0;
  for (const [, all] of groupBy(events, 'session_id')) {
    const arr = all.filter((e) => !e.is_sidechain);
    if (arr.length === 0 || effectiveCacheTtlOf(arr) !== CACHE_TTL_MS) continue;
    // Cost side: every 5-minute session starts paying the premium.
    writeTokens += arr.reduce((t, e) => t + e.cache_creation_tokens, 0);
    let recovered = 0;
    for (let i = 1; i < arr.length; i++) {
      const gap = Date.parse(arr[i].ts) - Date.parse(arr[i - 1].ts);
      if (gap > CACHE_TTL_MS && gap <= EXTENDED_CACHE_TTL_MS) {
        recovered += arr[i].input_tokens + arr[i].cache_creation_tokens;
      }
    }
    if (recovered === 0) continue;
    sessions++;
    recoverableTokens += recovered;
  }
  return { recoverableTokens, writeTokens, sessions };
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

/**
 * Group turns under the conversation a person actually had: a session plus
 * every subagent run it spawned. Used where the unit of analysis is the TASK
 * (what did this piece of work cost, what was it about) rather than the
 * chronology of one transcript.
 */
export function groupByRootSession(events: StoredEvent[]): Map<string, StoredEvent[]> {
  const map = new Map<string, StoredEvent[]>();
  for (const e of events) {
    const k = rootSessionOf(e);
    let arr = map.get(k);
    if (!arr) map.set(k, (arr = []));
    arr.push(e);
  }
  return map;
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
