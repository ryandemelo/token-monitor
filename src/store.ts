import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, Source } from './types.js';

export const DEFAULT_DB = join(homedir(), '.token-monitor', 'token-monitor.sqlite');

export function openDb(path: string = DEFAULT_DB): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      event_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      ts TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      thinking_tokens INTEGER NOT NULL,
      tools TEXT NOT NULL,
      has_thinking INTEGER NOT NULL,
      is_error INTEGER NOT NULL,
      git_branch TEXT,
      activity TEXT NOT NULL,
      UNIQUE(source, event_key)
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
  `);
  return db;
}

export function insertEvents(db: DatabaseSync, events: UsageEvent[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events
      (source, event_key, session_id, project, ts, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens,
       tools, has_thinking, is_error, git_branch, activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const e of events) {
      const res = stmt.run(
        e.source, e.eventKey, e.sessionId, e.project, e.timestamp, e.model,
        e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.thinkingTokens,
        JSON.stringify(e.tools), e.hasThinking ? 1 : 0, e.isError ? 1 : 0,
        e.gitBranch ?? null, e.activity ?? 'conversation',
      );
      inserted += Number(res.changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return inserted;
}

export interface StoredEvent {
  source: Source;
  session_id: string;
  project: string;
  ts: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number;
  /** JSON-encoded string[] of tool names. */
  tools: string;
  has_thinking: number;
  is_error: number;
  activity: string;
}

/**
 * One session's derived intent — labels only, NEVER raw prompt text. The
 * fingerprint is the ≤8 redacted keyword tokens from intent.ts; `label` is a
 * short top-terms name; `intent_id` is a stable per-session signature hash.
 * There is deliberately no free-text column, so the worst a leak could expose
 * is a handful of redacted keywords.
 */
export interface IntentRow {
  session_id: string;
  source: string;
  project: string;
  intent_id: string;
  label: string;
  /** JSON-encoded string[] of ≤8 redacted keyword tokens. */
  fingerprint: string;
  has_text: number;
  first_seen: string;
}

export function ensureIntentsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_intents (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      project TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      label TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      has_text INTEGER NOT NULL,
      first_seen TEXT NOT NULL
    );
  `);
}

/**
 * Record per-session intents first-wins (INSERT OR IGNORE on session_id), so a
 * session's first categorization is frozen and re-runs stay idempotent —
 * mirrors the follow-through baseline pattern. Returns rows inserted.
 */
export function recordIntents(
  db: DatabaseSync,
  rows: Array<{
    sessionId: string;
    source: string;
    project: string;
    intentId: string;
    label: string;
    fingerprint: string[];
    hasText: boolean;
    firstSeen: string;
  }>,
): number {
  ensureIntentsTable(db);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO session_intents
      (session_id, source, project, intent_id, label, fingerprint, has_text, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const res = stmt.run(
        r.sessionId, r.source, r.project, r.intentId, r.label,
        JSON.stringify(r.fingerprint), r.hasText ? 1 : 0, r.firstSeen,
      );
      inserted += Number(res.changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return inserted;
}

/** Frozen intents for the given session ids (first-wins values). */
export function loadIntents(db: DatabaseSync, sessionIds: string[]): Map<string, IntentRow> {
  ensureIntentsTable(db);
  const out = new Map<string, IntentRow>();
  if (sessionIds.length === 0) return out;
  const stmt = db.prepare(`SELECT * FROM session_intents WHERE session_id = ?`);
  for (const id of sessionIds) {
    const row = stmt.get(id) as IntentRow | undefined;
    if (row) out.set(row.session_id, row);
  }
  return out;
}

export function loadEvents(
  db: DatabaseSync,
  opts: { days?: number; project?: string; source?: string } = {},
): StoredEvent[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.days) {
    where.push(`ts >= ?`);
    params.push(new Date(Date.now() - opts.days * 86_400_000).toISOString());
  }
  if (opts.project) {
    where.push(`project = ?`);
    params.push(opts.project);
  }
  if (opts.source) {
    where.push(`source = ?`);
    params.push(opts.source);
  }
  const sql = `SELECT source, session_id, project, ts, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens,
      tools, has_thinking, is_error, activity
    FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts`;
  return db.prepare(sql).all(...params) as unknown as StoredEvent[];
}
