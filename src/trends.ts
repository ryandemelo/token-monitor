import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';

/**
 * Week-over-week direction: the report answers "where do tokens go",
 * trends answer "is it getting better". Current window vs the previous
 * same-length window, straight from stored events — no new state.
 */

export interface TrendRow {
  label: string;
  prev: number;
  now: number;
  fmt: 'tokens' | 'usd' | 'pct' | 'ratio' | 'int';
  /** Direction that counts as an improvement; undefined = neutral (volume). */
  good?: 'up' | 'down';
}

/** Partition events loaded over a 2×days window at the days boundary. */
export function splitWindow(
  events: StoredEvent[],
  days: number,
  nowMs: number = Date.now(),
): { current: StoredEvent[]; previous: StoredEvent[] } {
  const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
  const current: StoredEvent[] = [];
  const previous: StoredEvent[] = [];
  for (const e of events) (e.ts >= cutoff ? current : previous).push(e);
  return { current, previous };
}

export function trendRows(now: Metrics, prev: Metrics): TrendRow[] {
  return [
    { label: 'Spend tokens', prev: prev.spendTokens, now: now.spendTokens, fmt: 'tokens' },
    { label: 'Est. cost', prev: prev.costUsd, now: now.costUsd, fmt: 'usd' },
    { label: 'Sessions', prev: prev.sessions, now: now.sessions, fmt: 'int' },
    { label: 'Cache hit', prev: prev.cacheHitRatio, now: now.cacheHitRatio, fmt: 'pct', good: 'up' },
    { label: 'Rework', prev: prev.reworkRatio, now: now.reworkRatio, fmt: 'pct', good: 'down' },
    { label: 'Think:code', prev: prev.thinkToCodeRatio, now: now.thinkToCodeRatio, fmt: 'ratio' },
    { label: 'Context bloat', prev: prev.contextBloatShare, now: now.contextBloatShare, fmt: 'pct', good: 'down' },
    { label: 'Cold restarts', prev: prev.coldRestartShare, now: now.coldRestartShare, fmt: 'pct', good: 'down' },
    { label: 'Premium on exploration/chat', prev: prev.premiumWasteShare, now: now.premiumWasteShare, fmt: 'pct', good: 'down' },
    { label: 'Retry loops', prev: prev.retryShare, now: now.retryShare, fmt: 'pct', good: 'down' },
  ];
}

/** Flat-change tolerance so rounding noise doesn't get an arrow. */
const FLAT = 0.005;

export type TrendVerdict = 'better' | 'worse' | 'flat' | 'neutral';

export function verdictOf(r: TrendRow): TrendVerdict {
  const d = r.now - r.prev;
  // Flat when the change wouldn't even show at display precision.
  if (r.fmt === 'pct' && Math.abs(d) < 0.0005) return 'flat';
  if (r.fmt === 'ratio' && Math.abs(d) < 0.005) return 'flat';
  const base = Math.max(Math.abs(r.prev), Math.abs(r.now), 1e-9);
  if (Math.abs(d / base) < FLAT) return 'flat';
  if (!r.good) return 'neutral';
  return (d > 0) === (r.good === 'up') ? 'better' : 'worse';
}

export function fmtTrendValue(r: TrendRow, v: number): string {
  switch (r.fmt) {
    case 'usd':
      return '$' + v.toFixed(2);
    case 'pct':
      return (v * 100).toFixed(1) + '%';
    case 'ratio':
      return v.toFixed(2);
    case 'int':
      return String(Math.round(v));
    case 'tokens':
      if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
      if (v >= 1_000) return (v / 1_000).toFixed(1) + 'k';
      return String(Math.round(v));
  }
}

export interface ProjectMove {
  project: string;
  prev: number;
  now: number;
  delta: number;
}

/** Top projects by absolute spend-token change between the windows. */
export function projectMovers(
  current: StoredEvent[],
  previous: StoredEvent[],
  top = 5,
): ProjectMove[] {
  const spend = (evs: StoredEvent[]) =>
    new Map([...groupBy(evs, 'project')].map(([p, e]) => [p, computeMetrics(e).spendTokens]));
  const nowBy = spend(current);
  const prevBy = spend(previous);
  const projects = new Set([...nowBy.keys(), ...prevBy.keys()]);
  return [...projects]
    .map((project) => {
      const now = nowBy.get(project) ?? 0;
      const prev = prevBy.get(project) ?? 0;
      return { project, prev, now, delta: now - prev };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, top);
}
