import { readFileSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';
import { ACTIVITIES } from './types.js';
import type { Activity } from './types.js';

/**
 * Mergeable per-developer export. Contains aggregate numbers only — no
 * prompts, no code, no file paths beyond project basenames — so it is safe
 * to share for a team rollup.
 */
export interface ExportV1 {
  version: 1;
  user: string;
  host: string;
  generatedAt: string;
  days: number;
  overall: Metrics;
  byProject: Record<string, Metrics>;
}

export function buildExport(events: StoredEvent[], days: number): ExportV1 {
  return {
    version: 1,
    user: userInfo().username,
    host: hostname(),
    generatedAt: new Date().toISOString(),
    days,
    overall: computeMetrics(events),
    byProject: Object.fromEntries(
      [...groupBy(events, 'project')].map(([p, evs]) => [p, computeMetrics(evs)]),
    ),
  };
}

/**
 * Team config maps usernames to disciplines. Accepts JSON
 * (`{"alice": "frontend"}`) or flat YAML (`alice: frontend` per line,
 * `#` comments allowed). Nested YAML is intentionally unsupported.
 */
export function parseTeamConfig(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null) throw new Error('team config must be an object');
    return data as Record<string, string>;
  }
  const map: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^["']?([\w.@-]+)["']?\s*:\s*["']?([\w -]+?)["']?$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

/** Recombine Metrics by summing absolutes and recomputing ratios. */
export function mergeMetrics(list: Metrics[]): Metrics {
  const byActivity = Object.fromEntries(
    ACTIVITIES.map((a) => [a, { tokens: 0, share: 0, events: 0 }]),
  ) as Metrics['byActivity'];
  const byModel: Metrics['byModel'] = {};
  const out: Metrics = {
    events: 0, sessions: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
    spendTokens: 0, costUsd: 0, costEstimated: false, costUnpricedTokens: 0,
    cacheHitRatio: 0, reworkTokens: 0, reworkRatio: 0, errorEvents: 0,
    byActivity, byModel, thinkToCodeRatio: 0,
  };
  for (const m of list) {
    out.events += m.events;
    out.sessions += m.sessions;
    out.inputTokens += m.inputTokens;
    out.outputTokens += m.outputTokens;
    out.cacheReadTokens += m.cacheReadTokens;
    out.cacheCreationTokens += m.cacheCreationTokens;
    out.thinkingTokens += m.thinkingTokens;
    out.spendTokens += m.spendTokens;
    out.costUsd += m.costUsd;
    out.costEstimated ||= m.costEstimated;
    out.costUnpricedTokens += m.costUnpricedTokens;
    out.reworkTokens += m.reworkTokens ?? 0;
    out.errorEvents += m.errorEvents;
    for (const a of ACTIVITIES) {
      byActivity[a].tokens += m.byActivity[a]?.tokens ?? 0;
      byActivity[a].events += m.byActivity[a]?.events ?? 0;
    }
    for (const [model, v] of Object.entries(m.byModel)) {
      const t = (byModel[model] ??= { tokens: 0, costUsd: 0 });
      t.tokens += v.tokens;
      t.costUsd += v.costUsd;
    }
  }
  for (const a of ACTIVITIES) {
    byActivity[a].share = out.spendTokens ? byActivity[a].tokens / out.spendTokens : 0;
  }
  const denom = out.cacheReadTokens + out.inputTokens + out.cacheCreationTokens;
  out.cacheHitRatio = denom ? out.cacheReadTokens / denom : 0;
  out.reworkRatio = out.spendTokens ? out.reworkTokens / out.spendTokens : 0;
  out.thinkToCodeRatio =
    (byActivity.thinking.tokens + byActivity.exploration.tokens) / (byActivity.coding.tokens || 1);
  return out;
}

export interface DisciplineRollup {
  discipline: string;
  users: string[];
  metrics: Metrics;
}

export function rollupByDiscipline(
  exports: ExportV1[],
  team: Record<string, string>,
): DisciplineRollup[] {
  const groups = new Map<string, { users: Set<string>; metrics: Metrics[] }>();
  for (const ex of exports) {
    const discipline = team[ex.user] ?? 'unassigned';
    let g = groups.get(discipline);
    if (!g) groups.set(discipline, (g = { users: new Set(), metrics: [] }));
    g.users.add(ex.user);
    g.metrics.push(ex.overall);
  }
  return [...groups.entries()]
    .map(([discipline, g]) => ({
      discipline,
      users: [...g.users].sort(),
      metrics: mergeMetrics(g.metrics),
    }))
    .sort((a, b) => b.metrics.spendTokens - a.metrics.spendTokens);
}

export function dominantActivity(m: Metrics): Activity {
  return ACTIVITIES.reduce((best, a) =>
    m.byActivity[a].tokens > m.byActivity[best].tokens ? a : best,
  );
}
