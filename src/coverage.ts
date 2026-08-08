/**
 * Data completeness (#68) — how much of the window the numbers actually cover.
 *
 * Agent tools rotate their logs: Claude Code deletes transcripts after
 * `cleanupPeriodDays` (default 30). A user who collects less often than
 * retention silently loses history, and until now nothing said so — a report
 * over a holey window read exactly like a report over a full one, and
 * `--trend` drew confident arrows across windows that could be mostly empty.
 * Silent truncation reading as "covered everything" is the failure this
 * project's own no-silent-caps rule exists to prevent.
 *
 * Everything here is derived from stored events plus one optional local file
 * read. No schema change, no network, and nothing that isn't already in the
 * database: source names, day counts, and dates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StoredEvent } from './store.js';

/**
 * Claude Code's documented default transcript retention, used when
 * settings.json is absent or unreadable. Source:
 * code.claude.com/docs/en/settings (`cleanupPeriodDays`).
 */
export const DEFAULT_RETENTION_DAYS = 30;

export interface SourceCoverage {
  source: string;
  /** Distinct calendar days (UTC) with at least one event. */
  activeDays: number;
  windowDays: number;
  /** activeDays / windowDays — NOT a claim that the rest is missing data. */
  ratio: number;
  /** ISO dates (YYYY-MM-DD) of the first and last event seen in the window. */
  first: string;
  last: string;
  /** Longest run of consecutive event-free days strictly inside first..last. */
  largestGapDays: number;
  /** Whole days between the last event and the end of the window. */
  staleDays: number;
}

const DAY = 86_400_000;
const dayOf = (ts: string) => ts.slice(0, 10);

/**
 * Per-source coverage over the window. A day with no events is not proof of
 * missing data — people take weekends — so this reports what was observed and
 * leaves the interpretation to the caller, who has the retention context.
 */
export function computeCoverage(
  events: StoredEvent[],
  windowDays: number,
  now: number = Date.now(),
): SourceCoverage[] {
  const bySource = new Map<string, Set<string>>();
  for (const e of events) {
    let days = bySource.get(e.source);
    if (!days) bySource.set(e.source, (days = new Set()));
    days.add(dayOf(e.ts));
  }
  const endDay = dayOf(new Date(now).toISOString());
  return [...bySource.entries()]
    .map(([source, daySet]) => {
      const days = [...daySet].sort();
      let largestGapDays = 0;
      for (let i = 1; i < days.length; i++) {
        const gap = Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY) - 1;
        if (gap > largestGapDays) largestGapDays = gap;
      }
      return {
        source,
        activeDays: days.length,
        windowDays,
        ratio: windowDays > 0 ? days.length / windowDays : 0,
        first: days[0],
        last: days[days.length - 1],
        largestGapDays,
        staleDays: Math.max(0, Math.round((Date.parse(endDay) - Date.parse(days[days.length - 1])) / DAY)),
      };
    })
    .sort((a, b) => (a.source < b.source ? -1 : 1));
}

/**
 * Claude Code's configured transcript retention. Read locally, fail-soft: a
 * missing, unreadable, or malformed settings file falls back to the
 * documented default rather than refusing to say anything.
 */
export function readRetentionDays(
  path: string = join(homedir(), '.claude', 'settings.json'),
): number {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))?.cleanupPeriodDays;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

/**
 * How far past nominal retention a record may reach and still look like it was
 * truncated by deletion rather than simply being short.
 */
export const RETENTION_SLACK = 1.5;

/** Coverage below this fraction of the window is called out rather than passed over. */
export const COVERAGE_WARN_RATIO = 0.6;
/** A source silent this long is probably a broken collect, not a quiet week. */
export const STALE_WARN_DAYS = 3;

/** One compact line for the report header; empty when there is nothing to show. */
export function fmtCoverage(rows: SourceCoverage[]): string {
  if (rows.length === 0) return '';
  return rows
    .map((r) => {
      const flags = [
        r.ratio < COVERAGE_WARN_RATIO || r.largestGapDays >= STALE_WARN_DAYS ? '⚠' : '',
        r.largestGapDays >= STALE_WARN_DAYS ? `${r.largestGapDays}d gap` : '',
        r.staleDays >= STALE_WARN_DAYS ? `last data ${r.staleDays}d ago` : '',
      ].filter(Boolean);
      return `${r.source} ${r.activeDays}/${r.windowDays}d${flags.length ? ' ' + flags.join(' · ') : ''}`;
    })
    .join('  ·  ');
}

/**
 * The explanation for a window that starts abruptly: history the tool had
 * already deleted before it was ever collected. Deliberately worded as a
 * likelihood — a window can also start late because the user simply wasn't
 * working — and only offered when the evidence fits: the requested window
 * reaches past retention, and the record itself is no longer than retention
 * plus slack, i.e. it runs out about where deletion would have cut it.
 */
export function retentionNote(
  rows: SourceCoverage[],
  windowDays: number,
  retentionDays: number,
  now: number = Date.now(),
): string {
  if (windowDays <= retentionDays) return '';
  const claude = rows.find((r) => r.source === 'claude-code');
  if (!claude) return '';
  const age = Math.round((now - Date.parse(claude.first)) / DAY);
  // Fire only when the record runs out roughly where retention would have cut
  // it. Deletion is not punctual — files linger past the nominal window — so
  // the test is "history is no longer than retention plus slack", not "starts
  // exactly at the boundary". A user who collects regularly accumulates a
  // record far longer than retention and never sees this.
  if (age > retentionDays * RETENTION_SLACK) return '';
  return `history before ~${age}d ago was likely deleted by Claude Code's ${retentionDays}-day retention before it could be collected — collect at least weekly (\`token-monitor schedule\` automates it) to keep a longer record`;
}

/**
 * Whether a trend comparison is worth drawing. A previous window with far
 * less coverage than the current one produces arrows that measure collection
 * gaps, not behaviour change — and a false "improving" is worse than no
 * arrow at all.
 */
export function trendIsComparable(
  current: StoredEvent[],
  previous: StoredEvent[],
): { comparable: boolean; currentDays: number; previousDays: number } {
  const days = (evs: StoredEvent[]) => new Set(evs.map((e) => dayOf(e.ts))).size;
  const currentDays = days(current);
  const previousDays = days(previous);
  return {
    comparable: previousDays >= currentDays * COVERAGE_WARN_RATIO,
    currentDays,
    previousDays,
  };
}
