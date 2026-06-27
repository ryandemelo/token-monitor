/**
 * `categorize` — what tasks the team uses the agent for, where work repeats,
 * and which recurring tasks are worth codifying as a shared "org skill".
 *
 * Path A (local scrape), fully offline and deterministic by default — no agent,
 * no network. The pipeline:
 *   1. spend per session from the DB (StoredEvent), so $ is canonical & auditable;
 *   2. user-intent TEXT per session re-collected in-memory from the adapter and
 *      reduced to a redacted fingerprint ON-DEVICE (intent.ts) — raw prompt text
 *      never lands in the DB, the result, or stdout;
 *   3. join on session_id, persist the intent first-wins, cluster the frozen
 *      fingerprints (cluster.ts), then derive the duplicate-work / skill signals
 *      DETERMINISTICALLY from cluster membership — never asked of an LLM.
 *
 * PR1 scope: claude-code only for text. Other already-collected sources still
 * get a coarse activity-based fallback label so their spend is accounted for.
 */
import type { DatabaseSync } from 'node:sqlite';
import { loadEvents, recordIntents, loadIntents } from './store.js';
import type { StoredEvent, IntentRow } from './store.js';
import { groupBy, parseTools } from './metrics.js';
import { costOf } from './pricing.js';
import { ADAPTERS } from './adapters/index.js';
import type { Source } from './types.js';
import { deriveSessionIntent, fnv1a } from './intent.js';
import { clusterLabels } from './cluster.js';
import type { ClusterItem } from './cluster.js';

export interface CategoryRow {
  id: string;
  name: string;
  sessions: number;
  projects: string[];
  tokens: number;
  cost: number;
  estimated: boolean;
  /** True when at least one member was derived from real user text. */
  hasText: boolean;
  /** Recurring task spanning ≥2 projects — a redundant-work signal. */
  duplicate: boolean;
}

export interface CategorizeResult {
  days: number;
  totalSessions: number;
  textSessions: number;
  categories: CategoryRow[];
  duplicates: CategoryRow[];
  skillCandidates: CategoryRow[];
}

interface SessionAgg {
  sessionId: string;
  source: string;
  project: string;
  tokens: number;
  cost: number;
  estimated: boolean;
  activity: string;
  tools: string[];
}

function aggregateSession(sessionId: string, evs: StoredEvent[]): SessionAgg {
  let tokens = 0, cost = 0, estimated = false;
  const tools = new Set<string>();
  const actCount = new Map<string, number>();
  for (const e of evs) {
    tokens += e.input_tokens + e.output_tokens;
    const c = costOf(e.model, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_creation_tokens);
    cost += c.usd;
    if (c.estimated) estimated = true;
    for (const t of parseTools(e.tools)) tools.add(t);
    actCount.set(e.activity, (actCount.get(e.activity) ?? 0) + 1);
  }
  const activity = [...actCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? 'conversation';
  return {
    sessionId,
    source: evs[0]?.source ?? 'claude-code',
    project: evs[0]?.project ?? 'unknown',
    tokens,
    cost,
    estimated,
    activity,
    tools: [...tools],
  };
}

/**
 * Per-session user-intent text, re-collected in-memory across every adapter that
 * exposes it (claude-code, cursor, copilot, gemini-cli, codex). The text is
 * carried only long enough to derive an on-device fingerprint — it is never
 * persisted. A `source` filter narrows the re-collection to one adapter so a
 * filtered `categorize` run doesn't pay to re-scan the others.
 */
function intentTextBySession(source?: string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  const sources = (source ? [source] : Object.keys(ADAPTERS)) as Source[];
  for (const src of sources) {
    const adapter = ADAPTERS[src];
    if (!adapter) continue;
    let events;
    try {
      events = adapter().events;
    } catch {
      continue; // a malformed local log in one source must never abort the others
    }
    for (const ev of events) {
      if (!ev.intentText) continue;
      let s = seen.get(ev.sessionId);
      if (!s) seen.set(ev.sessionId, (s = new Set()));
      if (s.has(ev.intentText)) continue; // consecutive turns share one prompt
      s.add(ev.intentText);
      out.set(ev.sessionId, (out.get(ev.sessionId) ? out.get(ev.sessionId) + '\n' : '') + ev.intentText);
    }
  }
  return out;
}

export function runCategorize(
  db: DatabaseSync,
  opts: { days?: number; project?: string; source?: string; threshold?: number; minCluster?: number } = {},
  now: string = new Date().toISOString(),
): CategorizeResult {
  const events = loadEvents(db, { days: opts.days, project: opts.project, source: opts.source });
  const days = opts.days ?? 30;

  const aggs = [...groupBy(events, 'session_id').entries()].map(([id, evs]) => aggregateSession(id, evs));
  if (aggs.length === 0) {
    return { days, totalSessions: 0, textSessions: 0, categories: [], duplicates: [], skillCandidates: [] };
  }

  // Derive intent on-device, then persist first-wins.
  const textMap = intentTextBySession(opts.source);
  const toRecord = aggs.map((a) => {
    const intent = deriveSessionIntent(textMap.get(a.sessionId) ?? '', { activity: a.activity, tools: a.tools });
    return {
      sessionId: a.sessionId,
      source: a.source,
      project: a.project,
      intentId: fnv1a([...intent.fingerprint].sort().join('|')),
      label: intent.label,
      fingerprint: intent.fingerprint,
      hasText: intent.hasText,
      firstSeen: now,
    };
  });
  recordIntents(db, toRecord);

  // Cluster the FROZEN (first-wins) fingerprints, so display is idempotent.
  const frozen = loadIntents(db, aggs.map((a) => a.sessionId));
  return buildResult(aggs, frozen, days, opts);
}

const byCostThenSessions = (a: CategoryRow, b: CategoryRow) =>
  b.sessions - a.sessions ||
  b.cost - a.cost ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Cluster the frozen fingerprints into category rows and derive the
 * duplicate-work / skill-candidate signals. Shared by `runCategorize` (after
 * recording) and the read-only `categorizeSummary` (no recording), so both see
 * identical clusters for the same window.
 */
function buildResult(
  aggs: SessionAgg[],
  frozen: Map<string, IntentRow>,
  days: number,
  opts: { threshold?: number; minCluster?: number },
): CategorizeResult {
  const minCluster = Math.max(2, opts.minCluster ?? 2);
  // Count from the frozen rows the categories are actually built from (not the
  // fresh re-derivation), so the header matches the per-row labels on re-runs.
  const textSessions = [...frozen.values()].filter((r) => r.has_text === 1).length;
  const aggById = new Map(aggs.map((a) => [a.sessionId, a]));
  const items: ClusterItem[] = aggs.map((a) => {
    const row = frozen.get(a.sessionId);
    return { id: a.sessionId, project: a.project, terms: row ? (JSON.parse(row.fingerprint) as string[]) : [] };
  });
  const clusters = clusterLabels(items, { threshold: opts.threshold });

  const categories: CategoryRow[] = clusters.map((c) => {
    const members = c.items.map((it) => aggById.get(it.id)!).filter(Boolean);
    const projects = [...new Set(members.map((m) => m.project))].sort();
    const tokens = members.reduce((s, m) => s + m.tokens, 0);
    const cost = members.reduce((s, m) => s + m.cost, 0);
    const estimated = members.some((m) => m.estimated);
    const hasText = c.items.some((it) => frozen.get(it.id)?.has_text === 1);
    // Only real-text clusters earn the high-trust signals: a no-text fallback
    // cluster (shared activity+tools, e.g. two "coding+edit" sessions) is NOT
    // evidence of the same task, so it must never trigger a "duplicate work"
    // accusation or an org-skill recommendation.
    const duplicate = hasText && members.length >= minCluster && projects.length >= 2;
    return { id: c.id, name: c.name, sessions: members.length, projects, tokens, cost, estimated, hasText, duplicate };
  });

  return {
    days,
    totalSessions: aggs.length,
    textSessions,
    categories: [...categories].sort(byCostThenSessions),
    duplicates: categories.filter((c) => c.duplicate).sort((a, b) => b.cost - a.cost || byCostThenSessions(a, b)),
    skillCandidates: categories.filter((c) => c.hasText && c.sessions >= minCluster).sort(byCostThenSessions),
  };
}

/** Cross-surface duplicate-work signal for `report`/`html` (see categorizeSummary). */
export interface CategorizeSummary {
  duplicateTasks: number;
  duplicateSessions: number;
  duplicateCost: number;
  estimated: boolean;
}

/**
 * Read-only duplicate-work signal for the shared `report`/`html` surfaces,
 * derived from ALREADY-FROZEN intents only — no re-collection, no recording, no
 * privacy surface beyond what `categorize` already persisted. Returns undefined
 * when `categorize` has not run for this window, or found no cross-project
 * duplicate work, so the callout only appears when there is something to say.
 */
export function categorizeSummary(
  db: DatabaseSync,
  opts: { days?: number; project?: string; source?: string; threshold?: number; minCluster?: number } = {},
): CategorizeSummary | undefined {
  const events = loadEvents(db, { days: opts.days, project: opts.project, source: opts.source });
  if (events.length === 0) return undefined;
  const aggs = [...groupBy(events, 'session_id').entries()].map(([id, evs]) => aggregateSession(id, evs));
  const frozen = loadIntents(db, aggs.map((a) => a.sessionId));
  if (frozen.size === 0) return undefined;
  const { duplicates } = buildResult(aggs, frozen, opts.days ?? 30, opts);
  if (duplicates.length === 0) return undefined;
  return {
    duplicateTasks: duplicates.length,
    duplicateSessions: duplicates.reduce((s, c) => s + c.sessions, 0),
    duplicateCost: duplicates.reduce((s, c) => s + c.cost, 0),
    estimated: duplicates.some((c) => c.estimated),
  };
}

/** Shared wording for the one-line duplicate-work callout in report/html. */
export function fmtCategorizeSummary(s: CategorizeSummary): string {
  const cost = (s.estimated ? '~' : '') + '$' + s.duplicateCost.toFixed(2);
  const tasks = s.duplicateTasks === 1 ? '1 recurring task' : `${s.duplicateTasks} recurring tasks`;
  return `${tasks} spanning ≥2 projects (${cost})`;
}
