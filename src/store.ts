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
  has_thinking: number;
  is_error: number;
  activity: string;
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
      has_thinking, is_error, activity
    FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts`;
  return db.prepare(sql).all(...params) as unknown as StoredEvent[];
}
