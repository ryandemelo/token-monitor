import type { DatabaseSync } from 'node:sqlite';
import type { Metrics } from './metrics.js';

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

export type MetricKey = 'cacheHitRatio' | 'reworkRatio' | 'thinkToCodeRatio' | 'premiumShare';

export function premiumShare(m: Metrics): number {
  const premium = Object.entries(m.byModel).filter(([name]) =>
    /fable|opus|gpt-5(?!.*mini)|gemini-.*pro/i.test(name),
  );
  if (!premium.length) return 0;
  return premium.reduce((s, [, v]) => s + v.tokens, 0) / (m.spendTokens || 1);
}

export function metricValue(m: Metrics, key: MetricKey): number {
  if (key === 'premiumShare') return premiumShare(m);
  return m[key];
}

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
      resolved_at TEXT
    );
  `);
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
    created_at: string; resolved_at: string | null;
  }>;

  const update = db.prepare(
    'UPDATE recommendations SET last_value = ?, last_checked = ?, resolved_at = ? WHERE key = ?',
  );
  const out: FollowRow[] = [];
  for (const r of rows) {
    const current = metricValue(m, r.metric);
    const stillActive = active.has(r.key);
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
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function fmtMetric(key: MetricKey, v: number): string {
  return key === 'thinkToCodeRatio' ? v.toFixed(2) : (v * 100).toFixed(0) + '%';
}
