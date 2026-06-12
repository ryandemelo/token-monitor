import { readFileSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';
import { ACTIVITIES } from './types.js';
import type { Activity } from './types.js';
import { fingerprint } from './sign.js';
import type { Signature } from './sign.js';

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

/** An export as it arrives at the merge step — payload plus optional signature. */
export type SignedExport = ExportV1 & { sig?: Signature };

export interface MemberInfo {
  team?: string;
  discipline?: string;
}

/** Member name -> placement. Built from teams.yaml / team.yaml / JSON. */
export type TeamConfig = Record<string, MemberInfo>;

/**
 * Team config maps members to disciplines, optionally grouped by team.
 * Accepted shapes:
 *   - flat YAML:      `alice: frontend` per line (`#` comments allowed)
 *   - two-level YAML: `platform:` header, then indented `alice: frontend`
 *   - JSON:           `{"alice": "frontend"}` or `{"platform": {"alice": "frontend"}}`
 * Flat and two-level entries can mix; deeper nesting is unsupported.
 */
export function parseTeamConfig(path: string): TeamConfig {
  const text = readFileSync(path, 'utf8');
  const out: TeamConfig = {};
  if (path.endsWith('.json')) {
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null) throw new Error('team config must be an object');
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = { discipline: value };
      else if (typeof value === 'object' && value !== null) {
        for (const [member, discipline] of Object.entries(value as Record<string, unknown>)) {
          out[member] = { team: key, discipline: String(discipline) };
        }
      }
    }
    return out;
  }
  let currentTeam: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const m = line.trim().match(/^["']?([\w.@ -]+?)["']?\s*:\s*(?:["']?([\w -]+?)["']?)?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (!value) {
      // bare `team:` header — following indented members belong to it
      currentTeam = key;
    } else if (indented && currentTeam) {
      out[key] = { team: currentTeam, discipline: value.trim() };
    } else {
      currentTeam = undefined;
      out[key] = { discipline: value.trim() };
    }
  }
  return out;
}

/**
 * Stable identity of an export: the signing-key fingerprint when signed,
 * `user@host` otherwise. Survives username collisions across teams and
 * distinguishes the same username on different machines.
 */
export function identityOf(ex: SignedExport): string {
  return ex.sig?.publicKey ? fingerprint(ex.sig.publicKey) : `${ex.user}@${ex.host}`;
}

/**
 * Human name for an export: the keyring (user -> fingerprint) is the lead's
 * source of truth, so a reverse match on the signing fingerprint wins over
 * the self-reported user field.
 */
export function displayName(ex: SignedExport, keyring?: Record<string, string>): string {
  if (ex.sig?.publicKey && keyring) {
    const fp = fingerprint(ex.sig.publicKey);
    for (const [user, pinned] of Object.entries(keyring)) {
      if (pinned === fp) return user;
    }
  }
  return ex.user;
}

/**
 * Same signer pushing repeatedly leaves stale files in the drop; keep only
 * the newest export per identity so totals aren't double-counted.
 */
export function dedupeExports(exports: SignedExport[]): {
  kept: SignedExport[];
  dropped: SignedExport[];
} {
  const newest = new Map<string, SignedExport>();
  const dropped: SignedExport[] = [];
  for (const ex of exports) {
    const id = identityOf(ex);
    const seen = newest.get(id);
    if (!seen) {
      newest.set(id, ex);
    } else if (ex.generatedAt > seen.generatedAt) {
      dropped.push(seen);
      newest.set(id, ex);
    } else {
      dropped.push(ex);
    }
  }
  return { kept: [...newest.values()], dropped };
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
    trendSessions: 0, bloatedSessions: 0, contextBloatShare: 0,
    coldRestartTurns: 0, coldRestartTokens: 0, coldRestartShare: 0,
    premiumWasteTokens: 0, premiumWasteShare: 0,
    retryTokens: 0, retryShare: 0,
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
    // `?? 0` throughout: pre-0.6 exports don't carry the signal fields.
    out.trendSessions += m.trendSessions ?? 0;
    out.bloatedSessions += m.bloatedSessions ?? 0;
    out.coldRestartTurns += m.coldRestartTurns ?? 0;
    out.coldRestartTokens += m.coldRestartTokens ?? 0;
    out.premiumWasteTokens += m.premiumWasteTokens ?? 0;
    out.retryTokens += m.retryTokens ?? 0;
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
  out.contextBloatShare = out.trendSessions ? out.bloatedSessions / out.trendSessions : 0;
  const freshPaid = out.inputTokens + out.cacheCreationTokens;
  out.coldRestartShare = freshPaid ? out.coldRestartTokens / freshPaid : 0;
  out.premiumWasteShare = out.spendTokens ? out.premiumWasteTokens / out.spendTokens : 0;
  out.retryShare = out.spendTokens ? out.retryTokens / out.spendTokens : 0;
  out.thinkToCodeRatio =
    (byActivity.thinking.tokens + byActivity.exploration.tokens) / (byActivity.coding.tokens || 1);
  return out;
}

export type RollupAxis = 'team' | 'discipline';

export interface Rollup {
  group: string;
  users: string[];
  metrics: Metrics;
}

export function rollupExports(
  exports: SignedExport[],
  config: TeamConfig,
  by: RollupAxis = 'discipline',
  keyring?: Record<string, string>,
): Rollup[] {
  const groups = new Map<string, { users: Set<string>; metrics: Metrics[] }>();
  for (const ex of exports) {
    const name = displayName(ex, keyring);
    const group = config[name]?.[by] ?? 'unassigned';
    let g = groups.get(group);
    if (!g) groups.set(group, (g = { users: new Set(), metrics: [] }));
    g.users.add(name);
    g.metrics.push(ex.overall);
  }
  return [...groups.entries()]
    .map(([group, g]) => ({
      group,
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
