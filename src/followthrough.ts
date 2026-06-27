import type { DatabaseSync } from 'node:sqlite';
import type { Metrics } from './metrics.js';
import { PREMIUM_MODEL_RE } from './pricing.js';

/**
 * Follow-through: a recommendation is only useful if you can see whether it
 * worked. Every structured finding carries the metric it targets; the first
 * time it fires we store a baseline, and each later (unfiltered) report
 * re-measures and shows the delta.
 */
export interface Finding {
  key: string;
  metric: MetricKey;
  /** Desired direction of movement. */
  direction: 'up' | 'down';
  message: string;
}

export type MetricKey =
  | 'cacheHitRatio'
  | 'reworkRatio'
  | 'thinkToCodeRatio'
  | 'premiumShare'
  | 'contextBloatShare'
  | 'coldRestartShare'
  | 'premiumWasteShare'
  | 'retryShare';

export function premiumShare(m: Metrics): number {
  const premium = Object.entries(m.byModel).filter(([name]) => PREMIUM_MODEL_RE.test(name));
  if (!premium.length) return 0;
  return premium.reduce((s, [, v]) => s + v.tokens, 0) / (m.spendTokens || 1);
}

export function metricValue(m: Metrics, key: MetricKey): number {
  if (key === 'premiumShare') return premiumShare(m);
  return m[key];
}

/**
 * The improvement direction for each tracked metric. LLM-suggested
 * interventions (#42) are scored against this, not against whatever direction
 * the model claims — the canonical direction is the source of truth.
 */
export const METRIC_DIRECTION: Record<MetricKey, 'up' | 'down'> = {
  cacheHitRatio: 'up',
  reworkRatio: 'down',
  thinkToCodeRatio: 'up',
  premiumShare: 'down',
  contextBloatShare: 'down',
  coldRestartShare: 'down',
  premiumWasteShare: 'down',
  retryShare: 'down',
};

export function structuredFindings(m: Metrics): Finding[] {
  const out: Finding[] = [];
  if (m.cacheHitRatio < 0.5 && m.spendTokens > 100_000) {
    out.push({
      key: 'low-cache-hit',
      metric: 'cacheHitRatio',
      direction: 'up',
      message: `Cache hit ratio ${(m.cacheHitRatio * 100).toFixed(0)}% — low. Cache reads cost ~10% of fresh input; long-lived sessions and stable system context raise this. Biggest single cost lever.`,
    });
  }
  if (m.reworkRatio > 0.2) {
    out.push({
      key: 'high-rework',
      metric: 'reworkRatio',
      direction: 'down',
      message: `${(m.reworkRatio * 100).toFixed(0)}% of spend happens after test failures. Plan-first workflows and tighter task specs cut this.`,
    });
  }
  if (m.thinkToCodeRatio < 0.15 && m.byActivity.coding.tokens > 50_000) {
    out.push({
      key: 'low-think-code',
      metric: 'thinkToCodeRatio',
      direction: 'up',
      message: 'Very low think:code ratio. Teams that spend 15-30% of tokens on planning/exploration ship with less rework.',
    });
  }
  const share = premiumShare(m);
  if (share > 0.9 && Object.keys(m.byModel).length > 1) {
    out.push({
      key: 'premium-model-overuse',
      metric: 'premiumShare',
      direction: 'down',
      message: `${(share * 100).toFixed(0)}% of tokens on premium models. Route exploration and boilerplate turns to a cheaper tier.`,
    });
  }
  if (m.contextBloatShare >= 0.3 && m.trendSessions >= 3) {
    out.push({
      key: 'context-bloat',
      metric: 'contextBloatShare',
      direction: 'down',
      message: `${m.bloatedSessions} of ${m.trendSessions} long sessions grow their context ≥2× without cache reads keeping pace — start a fresh session or compact at task boundaries before the context balloons.`,
    });
  }
  if (m.coldRestartShare >= 0.2 && m.spendTokens > 100_000) {
    out.push({
      key: 'cold-restarts',
      metric: 'coldRestartShare',
      direction: 'down',
      message: `${(m.coldRestartShare * 100).toFixed(0)}% of fresh input tokens were re-paid on ${m.coldRestartTurns} turns that resumed after the ~5-min cache TTL. Batch prompts within the cache window, or split long-idle work into new sessions.`,
    });
  }
  if (m.premiumWasteShare >= 0.3 && m.spendTokens > 100_000) {
    out.push({
      key: 'premium-misroute',
      metric: 'premiumWasteShare',
      direction: 'down',
      message: `${(m.premiumWasteShare * 100).toFixed(0)}% of spend is premium-model tokens on exploration/conversation turns. Route reads and chat to a cheaper tier; keep the premium model for code-writing turns.`,
    });
  }
  if (m.retryShare >= 0.05) {
    out.push({
      key: 'tool-retry-loops',
      metric: 'retryShare',
      direction: 'down',
      message: `${(m.retryShare * 100).toFixed(0)}% of spend goes to turns re-running a tool right after it errored. \`analyze\` shows which tools — fix the recurring cause (flaky command, bad path, missing permission) instead of paying for retries.`,
    });
  }
  return out;
}

export interface FollowRow {
  key: string;
  metric: MetricKey;
  direction: 'up' | 'down';
  baseline: number;
  current: number;
  createdAt: string;
  status: 'new' | 'tracking' | 'improving' | 'regressing' | 'resolved';
  /** 'rule' = built-in finding; 'llm' = advice from `analyze --llm --track`. */
  origin: 'rule' | 'llm';
}

/** One intervention parsed from a strict-JSON `analyze --llm --track` response. */
export interface LlmIntervention {
  metric: MetricKey;
  title: string;
  rationale: string;
}

export function ensureFollowTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      key TEXT PRIMARY KEY,
      metric TEXT NOT NULL,
      direction TEXT NOT NULL,
      message TEXT NOT NULL,
      baseline REAL NOT NULL,
      created_at TEXT NOT NULL,
      last_value REAL,
      last_checked TEXT,
      resolved_at TEXT,
      origin TEXT NOT NULL DEFAULT 'rule'
    );
  `);
  // Migrate dbs created before LLM-tracked findings carried an origin.
  const cols = db.prepare(`PRAGMA table_info(recommendations)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'origin')) {
    db.exec(`ALTER TABLE recommendations ADD COLUMN origin TEXT NOT NULL DEFAULT 'rule'`);
  }
}

const MOVE_THRESHOLD = 0.02;

/**
 * Record newly-fired findings with a baseline, re-measure all tracked ones,
 * and return rows for rendering. Call only on unfiltered reports so baselines
 * aren't polluted by --project/--source slices.
 */
export function syncFindings(
  db: DatabaseSync,
  m: Metrics,
  now: string = new Date().toISOString(),
): FollowRow[] {
  ensureFollowTable(db);
  const findings = structuredFindings(m);
  const active = new Set(findings.map((f) => f.key));

  const insert = db.prepare(`
    INSERT OR IGNORE INTO recommendations (key, metric, direction, message, baseline, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const f of findings) {
    insert.run(f.key, f.metric, f.direction, f.message, metricValue(m, f.metric), now);
  }

  const rows = db.prepare('SELECT * FROM recommendations').all() as Array<{
    key: string; metric: MetricKey; direction: 'up' | 'down'; baseline: number;
    created_at: string; resolved_at: string | null; origin: 'rule' | 'llm';
  }>;

  const update = db.prepare(
    'UPDATE recommendations SET last_value = ?, last_checked = ?, resolved_at = ? WHERE key = ?',
  );
  const out: FollowRow[] = [];
  for (const r of rows) {
    const current = metricValue(m, r.metric);
    // Rule findings resolve when they stop firing; LLM-tracked advice has no
    // firing condition, so it keeps tracking until its metric is re-measured.
    const stillActive = r.origin === 'llm' ? true : active.has(r.key);
    // Resolve when the finding no longer fires; re-open if it fires again.
    const resolvedAt = stillActive ? null : (r.resolved_at ?? now);
    update.run(current, now, resolvedAt, r.key);

    const improvement = r.direction === 'up' ? current - r.baseline : r.baseline - current;
    let status: FollowRow['status'];
    if (resolvedAt) status = 'resolved';
    else if (r.created_at === now) status = 'new';
    else if (improvement > MOVE_THRESHOLD) status = 'improving';
    else if (improvement < -MOVE_THRESHOLD) status = 'regressing';
    else status = 'tracking';

    out.push({
      key: r.key, metric: r.metric, direction: r.direction,
      baseline: r.baseline, current, createdAt: r.created_at, status,
      origin: r.origin ?? 'rule',
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Persist LLM-suggested interventions as tracked findings, keyed by the metric
 * they target (`llm:<metric>`) so re-running `--track` keeps the original
 * baseline and follow-through can measure whether the advice moved the number.
 * At most one tracked intervention per metric — the first advice for it wins
 * (INSERT OR IGNORE). Returns the LLM rows, re-measured against `m`.
 */
export function recordLlmFindings(
  db: DatabaseSync,
  interventions: LlmIntervention[],
  m: Metrics,
  now: string = new Date().toISOString(),
): FollowRow[] {
  ensureFollowTable(db);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO recommendations (key, metric, direction, message, baseline, created_at, origin)
    VALUES (?, ?, ?, ?, ?, ?, 'llm')
  `);
  for (const it of interventions) {
    const message = it.rationale ? `${it.title} — ${it.rationale}` : it.title;
    insert.run(`llm:${it.metric}`, it.metric, METRIC_DIRECTION[it.metric], message, metricValue(m, it.metric), now);
  }
  return syncFindings(db, m, now).filter((r) => r.origin === 'llm');
}

export function fmtMetric(key: MetricKey, v: number): string {
  return key === 'thinkToCodeRatio' ? v.toFixed(2) : (v * 100).toFixed(0) + '%';
}
