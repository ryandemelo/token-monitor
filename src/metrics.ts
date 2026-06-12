import type { StoredEvent } from './store.js';
import type { Activity } from './types.js';
import { ACTIVITIES } from './types.js';
import { costOf } from './pricing.js';

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
  /** Share of spend after the first test failure in a session (fix loops). */
  reworkRatio: number;
  errorEvents: number;
  byActivity: Record<Activity, { tokens: number; share: number; events: number }>;
  byModel: Record<string, { tokens: number; costUsd: number }>;
  thinkToCodeRatio: number;
}

export function computeMetrics(events: StoredEvent[]): Metrics {
  const byActivity = Object.fromEntries(
    ACTIVITIES.map((a) => [a, { tokens: 0, share: 0, events: 0 }]),
  ) as Metrics['byActivity'];
  const byModel: Metrics['byModel'] = {};
  const sessions = new Set<string>();

  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, thinking = 0;
  let costUsd = 0, costEstimated = false, unpriced = 0, errorEvents = 0;

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
  for (const arr of bySession.values()) {
    const firstFail = arr.findIndex((e) => e.is_error && (e.activity === 'testing' || e.activity === 'coding'));
    if (firstFail === -1) continue;
    for (let i = firstFail + 1; i < arr.length; i++) {
      const e = arr[i];
      if (e.activity === 'coding' || e.activity === 'testing') {
        reworkTokens += e.input_tokens + e.output_tokens;
      }
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
    reworkRatio: spendTokens ? reworkTokens / spendTokens : 0,
    errorEvents,
    byActivity,
    byModel,
    thinkToCodeRatio: (byActivity.thinking.tokens + byActivity.exploration.tokens) / codingTokens,
  };
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
