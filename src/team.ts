import { readFileSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import type { Metrics } from './metrics.js';
import type { SourceCoverage } from './coverage.js';
import { computeCoverage, STALE_WARN_DAYS } from './coverage.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';
import { ACTIVITIES } from './types.js';
import type { Activity } from './types.js';
import { fingerprint } from './sign.js';
import type { Signature } from './sign.js';

/**
 * One task category as it crosses the wire — the aggregate-only projection of
 * a categorize cluster. `terms` are the ≤8 redacted keyword tokens from
 * intent.ts (the ONLY text-derived artifact categorize ever persists); they
 * are the cross-user match key at merge time. Deliberately not hashed:
 * a dictionary-reversible hash would be false comfort, whereas readable terms
 * keep the privacy surface auditable by the member shipping them.
 */
export interface ExportCategory {
  /** fnv1a of sorted member session ids — stable, one-way. */
  id: string;
  /** ≤3-term redacted label (cluster name). */
  name: string;
  /** Cluster top terms, ≤8 — the cross-user match key. */
  terms: string[];
  sessions: number;
  /** Canonical project basenames — same data class ExportV1.byProject ships. */
  projects: string[];
  tokens: number;
  cost: number;
  estimated: boolean;
  /** Member-local same-user cross-≥2-projects flag, carried for display. */
  duplicate: boolean;
}

/**
 * Mergeable per-developer export. Contains aggregate numbers only — no
 * prompts, no code, no file paths beyond project basenames — so it is safe
 * to share for a team rollup.
 *
 * `categories`/`categorizeDays` are ADDITIVE optional fields on version 1
 * (the persona/recommendations precedent): a version bump would make every
 * pre-0.11 lead reject every 0.11 member's scheduled push overnight, while
 * unknown fields are ignored-but-signed by old binaries — full two-way
 * compatibility with zero negotiation code.
 */
export interface ExportV1 {
  version: 1;
  user: string;
  host: string;
  generatedAt: string;
  days: number;
  overall: Metrics;
  byProject: Record<string, Metrics>;
  categories?: ExportCategory[];
  categorizeDays?: number;
  /**
   * Per-source day counts and dates — additive on version 1, same as
   * `categories`. This closes a real failure mode: `schedule`/`push` keeps
   * delivering signed exports even when a member's adapter has collected
   * nothing new for weeks, and until now the lead had no way to tell that
   * apart from a genuinely quiet member.
   */
  coverage?: SourceCoverage[];
  /**
   * Self-declared subscription plan id (see plans.ts) — additive and optional
   * on version 1, like `categories`. It is the ONLY new field the seat lens
   * needs, it is a string the member chose from a fixed list, and no account
   * data is read from anywhere to produce it.
   */
  plan?: string;
}

export function buildExport(
  events: StoredEvent[],
  days: number,
  opts: { plan?: string; prSessions?: Set<string> } = {},
): ExportV1 {
  return {
    ...(opts.plan ? { plan: opts.plan } : {}),
    version: 1,
    user: userInfo().username,
    host: hostname(),
    generatedAt: new Date().toISOString(),
    days,
    overall: computeMetrics(events, { prSessions: opts.prSessions }),
    coverage: computeCoverage(events, days),
    byProject: Object.fromEntries(
      [...groupBy(events, 'project')].map(([p, evs]) => [p, computeMetrics(evs, { prSessions: opts.prSessions })]),
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
    coldRestartTurns: 0, coldRestartTokens: 0, coldRestartShare: 0, coldRestartBaseTokens: 0,
    premiumWasteTokens: 0, premiumWasteShare: 0,
    retryTokens: 0, retryShare: 0,
    megaTurns: 0, megaTurnTokens: 0, megaTurnShare: 0,
    largestTurnOutput: 0, megaTurnExcessTokens: 0, megaTurnThreshold: 0,
    subagentSessions: 0, subagentSpendTokens: 0, subagentShare: 0,
    extendedCacheTokens: 0, extendedCacheShare: 0, extendedCacheSessions: 0,
    toolResultTokens: 0, toolResultTurns: 0,
    toolResultCarryTokens: 0, toolResultCarryShare: 0,
    sessionFloorTokens: 0, floorSessions: 0, floorTurns: 0, floorBaseTokens: 0, floorShare: 0,
    shippedSessions: 0, conversations: 0, shippedShare: 0,
    costPerShippedSession: 0, tokensPerShippedSession: 0,
    abandonedTokens: 0, abandonedShare: 0, abandonedStreams: 0, openStreams: 0, openTokens: 0,
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
    // Pre-0.13 exports have no main-loop denominator because they had no
    // subagent data at all — their own fresh-paid input IS the right base.
    out.coldRestartBaseTokens += m.coldRestartBaseTokens ?? (m.inputTokens + m.cacheCreationTokens);
    out.premiumWasteTokens += m.premiumWasteTokens ?? 0;
    out.retryTokens += m.retryTokens ?? 0;
    out.megaTurns += m.megaTurns ?? 0;
    out.megaTurnTokens += m.megaTurnTokens ?? 0;
    out.megaTurnExcessTokens += m.megaTurnExcessTokens ?? 0;
    // Counts and tokens add across members, but each member counted against
    // its OWN bar (percentile of its own turns), so the merged threshold is
    // reported as the strictest bar any member used. The share below is the
    // honest recombination over pooled spend.
    out.largestTurnOutput = Math.max(out.largestTurnOutput, m.largestTurnOutput ?? 0);
    out.megaTurnThreshold = Math.max(out.megaTurnThreshold, m.megaTurnThreshold ?? 0);
    out.subagentSessions += m.subagentSessions ?? 0;
    out.subagentSpendTokens += m.subagentSpendTokens ?? 0;
    out.extendedCacheTokens += m.extendedCacheTokens ?? 0;
    out.extendedCacheSessions += m.extendedCacheSessions ?? 0;
    out.toolResultTokens += m.toolResultTokens ?? 0;
    out.toolResultTurns += m.toolResultTurns ?? 0;
    out.toolResultCarryTokens += m.toolResultCarryTokens ?? 0;
    out.floorSessions += m.floorSessions ?? 0;
    out.floorTurns += m.floorTurns ?? 0;
    out.floorBaseTokens += m.floorBaseTokens ?? 0;
    // Medians don't add. The composable pieces are the numerator (this
    // member's floor charged over their own turns) and the denominator, which
    // is why both are carried; the merged "floor" below is therefore a
    // turn-weighted mean of member medians, not a team median.
    out.sessionFloorTokens += (m.sessionFloorTokens ?? 0) * (m.floorTurns ?? 0);
    // Outcomes: counts and token sums compose; the shares and per-shipped
    // figures are recomputed from the merged totals below.
    out.shippedSessions += m.shippedSessions ?? 0;
    out.conversations += m.conversations ?? 0;
    out.costPerShippedSession += (m.costPerShippedSession ?? 0) * (m.shippedSessions ?? 0);
    out.tokensPerShippedSession += (m.tokensPerShippedSession ?? 0) * (m.shippedSessions ?? 0);
    out.abandonedTokens += m.abandonedTokens ?? 0;
    out.abandonedStreams += m.abandonedStreams ?? 0;
    out.openStreams += m.openStreams ?? 0;
    out.openTokens += m.openTokens ?? 0;
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
  out.coldRestartShare = out.coldRestartBaseTokens
    ? out.coldRestartTokens / out.coldRestartBaseTokens
    : 0;
  out.premiumWasteShare = out.spendTokens ? out.premiumWasteTokens / out.spendTokens : 0;
  out.retryShare = out.spendTokens ? out.retryTokens / out.spendTokens : 0;
  out.megaTurnShare = out.spendTokens ? out.megaTurnTokens / out.spendTokens : 0;
  // Pre-0.13 exports carry no subagent fields at all, so a team share is a
  // floor over the members who can actually see their fan-out.
  out.subagentShare = out.spendTokens ? out.subagentSpendTokens / out.spendTokens : 0;
  out.toolResultCarryShare = denom ? out.toolResultCarryTokens / denom : 0;
  out.shippedShare = out.conversations ? out.shippedSessions / out.conversations : 0;
  out.costPerShippedSession = out.shippedSessions ? out.costPerShippedSession / out.shippedSessions : 0;
  out.tokensPerShippedSession = out.shippedSessions ? out.tokensPerShippedSession / out.shippedSessions : 0;
  out.abandonedShare = out.spendTokens ? out.abandonedTokens / out.spendTokens : 0;
  // Finish the turn-weighted mean started in the loop, then recombine the
  // share from the summed numerator/denominator rather than from the mean.
  const floorNumerator = out.sessionFloorTokens;
  out.sessionFloorTokens = out.floorTurns ? floorNumerator / out.floorTurns : 0;
  out.floorShare = out.floorBaseTokens ? floorNumerator / out.floorBaseTokens : 0;
  out.extendedCacheShare = out.cacheCreationTokens
    ? out.extendedCacheTokens / out.cacheCreationTokens
    : 0;
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

/**
 * Members whose newest data predates their export by more than a few days.
 * Reported as an observation, not an accusation: a quiet week and a dead
 * collect job look identical from here, and only the member can tell them
 * apart. Exports without coverage (pre-0.13) are simply absent from the list.
 */
export function staleMembers(
  exports: SignedExport[],
  keyring?: Record<string, string>,
): Array<{ name: string; source: string; staleDays: number }> {
  const out: Array<{ name: string; source: string; staleDays: number }> = [];
  for (const ex of exports) {
    for (const c of ex.coverage ?? []) {
      if (c.staleDays >= STALE_WARN_DAYS) {
        out.push({ name: displayName(ex, keyring), source: c.source, staleDays: c.staleDays });
      }
    }
  }
  return out.sort((a, b) => b.staleDays - a.staleDays || (a.name < b.name ? -1 : 1));
}
