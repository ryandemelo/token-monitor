import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, SessionPrLink, Source } from './types.js';
import type { RelayFingerprint } from './relay.js';

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
  migrate(db);
  return db;
}

/**
 * Additive column migrations, PRAGMA-guarded (the followthrough `origin`
 * precedent). Each is nullable or has a constant default, so an old row keeps
 * a truthful value without a backfill:
 *
 * - `project_raw` — the pre-relabel project label, so every project-family
 *   relabel is auditable and reversible in one statement (UPDATE events SET
 *   project = project_raw WHERE project_raw IS NOT NULL).
 * - `is_sidechain` / `parent_session_id` / `agent_type` — subagent accounting.
 *   Defaulting old rows to 0/NULL is correct rather than merely convenient:
 *   before this version `collect` never read a subagent transcript, so every
 *   pre-existing row genuinely IS a main-loop turn. The missing subagent rows
 *   backfill themselves on the next collect from the transcripts still on disk.
 */
function migrate(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const wanted: Array<[string, string]> = [
    ['project_raw', 'TEXT'],
    ['is_sidechain', 'INTEGER NOT NULL DEFAULT 0'],
    ['parent_session_id', 'TEXT'],
    ['agent_type', 'TEXT'],
    // Cache writes made against the 1-hour ephemeral cache rather than the
    // 5-minute default. 0 for old rows and for every source that doesn't
    // report the split, which is exactly the 5-minute assumption those rows
    // were already measured under — so no historical metric moves.
    ['cache_creation_1h_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    // Characters each tool returned on this turn, as a JSON {tool: chars}
    // object — SIZES ONLY, structurally incapable of holding result text.
    // NULL on old rows and on every source that doesn't persist tool results,
    // which is what makes "unmeasured" distinguishable from "returned nothing".
    ['tool_result_chars', 'TEXT'],
  ];
  // relabelEvents and syncIntentProjects look rows up one session at a time.
  // Without this every collect ran a full table scan PER SESSION — survivable
  // at ~150 sessions, minutes once subagent runs make it thousands (measured
  // 8m16s -> 5.2s on a 165k-row database). Same try/catch as the ALTERs
  // below: a DB that can't be written must still open for reading.
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(source, session_id)`);
  } catch {
    /* read-only DB: reads still work, the index appears on the first writable open */
  }
  for (const [name, type] of wanted) {
    if (cols.has(name)) continue;
    try {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
    } catch {
      // Read-only or otherwise locked older DB: skip the migration so read
      // paths still work (loadEvents substitutes defaults for columns that
      // aren't there); the column appears on the first writable open.
    }
  }
}

export function insertEvents(db: DatabaseSync, events: UsageEvent[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events
      (source, event_key, session_id, project, ts, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens,
       tools, has_thinking, is_error, git_branch, activity,
       is_sidechain, parent_session_id, agent_type, cache_creation_1h_tokens,
       tool_result_chars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        e.isSidechain ? 1 : 0, e.parentSessionId ?? null, e.agentType ?? null,
        e.cacheCreation1hTokens ?? 0,
        e.toolResultChars ? JSON.stringify(e.toolResultChars) : null,
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
  /** 1 when the turn came from a subagent transcript (see UsageEvent.isSidechain). */
  is_sidechain: number;
  /** Spawning session for a sidechain turn; NULL for main-loop turns. */
  parent_session_id: string | null;
  /** Subagent type label; NULL for main-loop turns. Never leaves the machine. */
  agent_type: string | null;
  /** Of cache_creation_tokens, how many went to the 1-hour ephemeral cache. */
  cache_creation_1h_tokens: number;
  /**
   * JSON `{tool: chars}` of what each tool RETURNED on this turn, or NULL when
   * the source doesn't persist results. Sizes only — see the migration note.
   */
  tool_result_chars: string | null;
  /**
   * The branch the turn happened on, when the source records one. Work streams
   * (#66) group sessions by project + branch, so "coded Monday, shipped
   * Wednesday in a new session" is one stream rather than one abandonment.
   * LOCAL ONLY: branch names name features and clients, so they are never
   * exported — the same rule tool and MCP server names follow.
   */
  git_branch: string | null;
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
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v && k) raw[k] = v;
    }
    return resolveAliasChains(raw);
  } catch {
    return {};
  }
}

/**
 * Collapse `{a: b, b: c}` to `{a: c, b: c}` (#74).
 *
 * The map is applied twice per collect — once composed into the relabel
 * target, which resolves a single level, and once as a direct pass that can
 * re-match rows the previous entry just rewrote. With a chain those two fight
 * forever: every collect reports a relabel, and the answer depends on JSON key
 * order. Resolving to a fixed point first makes both passes agree, so steady
 * state is genuinely zero changes.
 *
 * A cycle (`a -> b -> a`) has no terminal target, so its keys collapse to
 * themselves — a no-op that applyProjectAliases already skips. That beats
 * picking an arbitrary winner, and it beats dropping the keys, which would
 * change what `loadProjectAliases` returns for the self-maps a user may
 * legitimately have written.
 */
export function resolveAliasChains(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const from of Object.keys(raw)) {
    let to = raw[from];
    const seen = new Set([from]);
    // Walk to the end of the chain, stopping if we return to where we started
    // or revisit a node — either way there is no further terminal target.
    while (to !== from && raw[to] !== undefined && !seen.has(to)) {
      seen.add(to);
      to = raw[to];
    }
    out[from] = to;
  }
  return out;
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
  // Both subqueries are source-scoped: session ids are only unique WITHIN a
  // source, and a cross-source id collision must not let one source's project
  // overwrite (and endlessly re-trigger) another's intent row.
  const res = db.prepare(`
    UPDATE session_intents SET project =
      (SELECT project FROM events e
       WHERE e.session_id = session_intents.session_id
         AND e.source = session_intents.source
       ORDER BY ts LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM events e
      WHERE e.session_id = session_intents.session_id
        AND e.source = session_intents.source
        AND e.project <> session_intents.project)
  `).run();
  return Number(res.changes);
}

export function loadEvents(
  db: DatabaseSync,
  opts: { days?: number; project?: string; source?: string; session?: string } = {},
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
  if (opts.session) {
    where.push(`session_id = ?`);
    params.push(opts.session);
  }
  // Subagent columns are selected defensively: a DB whose migration couldn't
  // run (read-only, older binary holding it) must still read, and the defaults
  // it substitutes are the truth for pre-subagent rows anyway.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const col = (name: string, fallback: string) => (cols.has(name) ? name : `${fallback} AS ${name}`);
  const sql = `SELECT source, session_id, project, ts, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens,
      tools, has_thinking, is_error, activity, git_branch,
      ${col('is_sidechain', '0')}, ${col('parent_session_id', 'NULL')}, ${col('agent_type', 'NULL')},
      ${col('cache_creation_1h_tokens', '0')}, ${col('tool_result_chars', 'NULL')}
    FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts`;
  return db.prepare(sql).all(...params) as unknown as StoredEvent[];
}

/**
 * Session ids starting with `prefix`, newest activity first. `donate-fixture`
 * takes the 8-character prefix the report prints as evidence, so it has to be
 * able to resolve one — and to refuse when a prefix is ambiguous rather than
 * picking a session the user did not mean.
 */
export function findSessions(db: DatabaseSync, prefix: string): Array<{ session_id: string; project: string; source: string; turns: number; last_ts: string }> {
  return db
    .prepare(
      `SELECT session_id, project, source, COUNT(*) AS turns, MAX(ts) AS last_ts
         FROM events WHERE session_id LIKE ? GROUP BY session_id ORDER BY last_ts DESC`,
    )
    .all(prefix + '%') as unknown as Array<{ session_id: string; project: string; source: string; turns: number; last_ts: string }>;
}

/**
 * Pull requests per session (#66) — a COUNT, never a description. The repo
 * name and URL are read to de-duplicate the link lines a session writes and
 * then discarded in the adapter, so the worst this table can leak is that a
 * session shipped three things.
 *
 * Replace-on-conflict rather than first-wins: a session that opens another PR
 * after the last collect has genuinely shipped more.
 */
export function ensureSessionPrTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_prs (
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      pr_count INTEGER NOT NULL,
      PRIMARY KEY (source, session_id)
    );
  `);
}

export function recordSessionPrs(db: DatabaseSync, links: SessionPrLink[]): number {
  if (links.length === 0) return 0;
  ensureSessionPrTable(db);
  const stmt = db.prepare(`
    INSERT INTO session_prs (source, session_id, pr_count) VALUES (?, ?, ?)
    ON CONFLICT(source, session_id) DO UPDATE SET pr_count = MAX(pr_count, excluded.pr_count)
  `);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const l of links) n += Number(stmt.run(l.source, l.sessionId, l.prCount).changes);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

/** Session ids with at least one linked PR, for the outcome metrics. */
export function loadPrSessions(db: DatabaseSync): Set<string> {
  ensureSessionPrTable(db);
  const rows = db.prepare('SELECT session_id FROM session_prs WHERE pr_count > 0').all() as unknown as Array<{ session_id: string }>;
  return new Set(rows.map((r) => r.session_id));
}

/**
 * Per-session relay fingerprints (#65) — a Bloom filter over the hashed
 * 8-word shingles of that session's assistant output, plus the counts and
 * timestamps detection needs. There is deliberately no text column, and
 * unlike category terms these hashes are not enumerable: an 8-word shingle
 * comes from open prose, not a handful of common dev words.
 *
 * Stored so relay can still be found after the source transcript is gone —
 * Claude Code deletes them after `cleanupPeriodDays`, which is exactly the
 * window a hand-carried paste spans.
 */
export function ensureRelayTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_relay (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      project TEXT NOT NULL,
      out_bloom BLOB NOT NULL,
      out_shingles INTEGER NOT NULL,
      first_ts TEXT NOT NULL,
      last_ts TEXT NOT NULL
    );
  `);
}

/**
 * Record fingerprints, refreshing a session whose transcript has grown.
 *
 * Unlike session_intents this is NOT first-wins: an intent is a frozen
 * judgement about what a session was for, while a fingerprint is a mechanical
 * summary of the text, and a session that gained turns since the last collect
 * has more output to match against. Re-deriving is idempotent — same text in,
 * same bits out.
 */
export function recordRelayFingerprints(db: DatabaseSync, rows: RelayFingerprint[]): number {
  ensureRelayTable(db);
  const stmt = db.prepare(`
    INSERT INTO session_relay (session_id, source, project, out_bloom, out_shingles, first_ts, last_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      out_bloom = excluded.out_bloom, out_shingles = excluded.out_shingles,
      project = excluded.project, last_ts = excluded.last_ts
      WHERE excluded.out_shingles >= session_relay.out_shingles
  `);
  let written = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      written += Number(
        stmt.run(r.sessionId, r.source, r.project, r.outBloom, r.outShingles, r.firstTs, r.lastTs).changes,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return written;
}

/** Fingerprints whose session ended within the window, newest last. */
export function loadRelayFingerprints(db: DatabaseSync, days?: number): RelayFingerprint[] {
  ensureRelayTable(db);
  const where = days ? `WHERE last_ts >= ?` : '';
  const params = days ? [new Date(Date.now() - days * 86_400_000).toISOString()] : [];
  const rows = db
    .prepare(`SELECT * FROM session_relay ${where} ORDER BY last_ts`)
    .all(...params) as unknown as Array<{
      session_id: string; source: string; project: string;
      out_bloom: Uint8Array; out_shingles: number; first_ts: string; last_ts: string;
    }>;
  return rows.map((r) => ({
    sessionId: r.session_id, source: r.source, project: r.project,
    outBloom: r.out_bloom, outShingles: r.out_shingles,
    firstTs: r.first_ts, lastTs: r.last_ts,
  }));
}

/**
 * Detected relays, persisted so `report` and `html` can surface the signal
 * without paying for a full re-scan. Same contract as the frozen intents
 * categorize writes: the expensive derivation happens in its own command, and
 * the cheap read-only summary rides along elsewhere.
 *
 * Results, unlike fingerprints, depend on the whole corpus — a later scan
 * with more history can find an origin an earlier one could not — so a rerun
 * replaces a pair rather than being ignored. Session ids and counts only; no
 * text, no hashes.
 */
export function ensureRelayFindingsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_findings (
      to_session_id TEXT NOT NULL,
      from_session_id TEXT NOT NULL,
      to_source TEXT NOT NULL,
      from_source TEXT NOT NULL,
      to_project TEXT NOT NULL,
      overlap REAL NOT NULL,
      relayed_words INTEGER NOT NULL,
      to_ts TEXT NOT NULL,
      PRIMARY KEY (to_session_id, from_session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_relay_findings_ts ON relay_findings(to_ts);
  `);
}

export interface RelayFindingRow {
  to_session_id: string;
  from_session_id: string;
  to_source: string;
  from_source: string;
  to_project: string;
  overlap: number;
  relayed_words: number;
  to_ts: string;
}

/** Replace the findings for the scanned window; returns rows written. */
export function recordRelayFindings(db: DatabaseSync, rows: RelayFindingRow[]): number {
  ensureRelayFindingsTable(db);
  const stmt = db.prepare(`
    INSERT INTO relay_findings
      (to_session_id, from_session_id, to_source, from_source, to_project, overlap, relayed_words, to_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(to_session_id, from_session_id) DO UPDATE SET
      overlap = excluded.overlap, relayed_words = excluded.relayed_words,
      to_source = excluded.to_source, from_source = excluded.from_source,
      to_project = excluded.to_project, to_ts = excluded.to_ts
  `);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      n += Number(stmt.run(r.to_session_id, r.from_session_id, r.to_source, r.from_source,
        r.to_project, r.overlap, r.relayed_words, r.to_ts).changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

export function loadRelayFindings(db: DatabaseSync, days?: number): RelayFindingRow[] {
  ensureRelayFindingsTable(db);
  const where = days ? 'WHERE to_ts >= ?' : '';
  const params = days ? [new Date(Date.now() - days * 86_400_000).toISOString()] : [];
  return db.prepare(`SELECT * FROM relay_findings ${where} ORDER BY relayed_words DESC`)
    .all(...params) as unknown as RelayFindingRow[];
}
