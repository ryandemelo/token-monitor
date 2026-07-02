import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
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
  // Migrate dbs created before project-family relabeling: project_raw keeps
  // the pre-relabel label so every relabel is auditable and reversible in one
  // statement (UPDATE events SET project = project_raw WHERE project_raw IS
  // NOT NULL). Mirrors the followthrough `origin` PRAGMA-guard precedent.
  const cols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'project_raw')) {
    db.exec(`ALTER TABLE events ADD COLUMN project_raw TEXT`);
  }
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

/**
 * Re-attribute HISTORICAL rows to the projects the adapters resolve today.
 * `collect` is the backfill: adapters now emit one family-normalized project
 * per session, and this pass converges every stored row of every session
 * whose log still exists onto that label — versionless and idempotent (the
 * `project <> ?` guard makes steady-state collects free). `project_raw`
 * preserves the first pre-relabel label for audit/revert.
 *
 * Keys are `source\x1fsessionId` (\x1f: neither appears in either part).
 */
export function relabelEvents(db: DatabaseSync, sessions: Map<string, string>): number {
  const stmt = db.prepare(`
    UPDATE events SET project_raw = COALESCE(project_raw, project), project = ?
    WHERE source = ? AND session_id = ? AND project <> ?
  `);
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const [key, project] of sessions) {
      const i = key.indexOf('\x1f');
      const res = stmt.run(project, key.slice(0, i), key.slice(i + 1), project);
      changed += Number(res.changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return changed;
}

export const DEFAULT_ALIASES = join(homedir(), '.token-monitor', 'project-aliases.json');

/**
 * Optional user-maintained relabel map ({"quaestor-cl-iter-02": "quaestor"})
 * for rows whose source logs rotated away before family resolution existed —
 * the resolver can't fix what it can never re-see. Deliberately manual: an
 * auto-learned alias table was rejected in design review as a
 * silent-corruption vector. Missing/corrupt file reads as empty.
 */
export function loadProjectAliases(path: string = DEFAULT_ALIASES): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v && k) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Apply alias relabels at collect time (same audit trail as relabelEvents). */
export function applyProjectAliases(db: DatabaseSync, aliases: Record<string, string>): number {
  const stmt = db.prepare(`
    UPDATE events SET project_raw = COALESCE(project_raw, project), project = ?
    WHERE project = ?
  `);
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const [from, to] of Object.entries(aliases)) {
      if (from === to) continue;
      changed += Number(stmt.run(to, from).changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return changed;
}

/**
 * Keep session_intents.project in step with relabeled events. The freeze
 * contract is deliberately re-scoped, not broken: intent_id / label /
 * fingerprint / has_text / first_seen stay first-wins frozen (they are the
 * privacy and idempotency surface); `project` is signal-inert location
 * metadata that categorize re-reads from events anyway — leaving it stale
 * would just be a lie in the DB. Call only when a relabel actually changed
 * rows; steady-state collects skip the scan entirely.
 */
export function syncIntentProjects(db: DatabaseSync): number {
  ensureIntentsTable(db);
  const res = db.prepare(`
    UPDATE session_intents SET project =
      (SELECT project FROM events e
       WHERE e.session_id = session_intents.session_id ORDER BY ts LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM events e
      WHERE e.session_id = session_intents.session_id
        AND e.project <> session_intents.project)
  `).run();
  return Number(res.changes);
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
