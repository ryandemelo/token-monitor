import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertEvents, loadEvents } from '../src/store.js';
import { makeEvent } from './helpers.js';

test('insert is idempotent on (source, event_key)', () => {
  const db = openDb(':memory:');
  const events = [
    makeEvent({ eventKey: 'a', activity: 'coding' }),
    makeEvent({ eventKey: 'b', activity: 'testing' }),
  ];
  assert.equal(insertEvents(db, events), 2);
  assert.equal(insertEvents(db, events), 0); // re-collect inserts nothing
  assert.equal(loadEvents(db).length, 2);
});

test('loadEvents filters by project, source and window', () => {
  const db = openDb(':memory:');
  insertEvents(db, [
    makeEvent({ eventKey: 'old', project: 'p1', timestamp: '2020-01-01T00:00:00.000Z' }),
    makeEvent({ eventKey: 'new1', project: 'p1', timestamp: new Date().toISOString() }),
    makeEvent({ eventKey: 'new2', project: 'p2', timestamp: new Date().toISOString() }),
  ]);
  assert.equal(loadEvents(db).length, 3);
  assert.equal(loadEvents(db, { days: 7 }).length, 2);
  assert.equal(loadEvents(db, { days: 7, project: 'p1' }).length, 1);
  assert.equal(loadEvents(db, { source: 'claude-code' }).length, 3);
  assert.equal(loadEvents(db, { source: 'codex' }).length, 0);
});

// ---- project-family relabeling (PR4) ----------------------------------------

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  relabelEvents, loadProjectAliases, applyProjectAliases, syncIntentProjects, resolveAliasChains,
  recordIntents, loadIntents,
} from '../src/store.js';

test('openDb migrates a pre-0.11 db (no project_raw) via PRAGMA-guarded ALTER', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-mig-')), 'old.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, event_key TEXT NOT NULL,
    session_id TEXT NOT NULL, project TEXT NOT NULL, ts TEXT NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
    thinking_tokens INTEGER NOT NULL, tools TEXT NOT NULL, has_thinking INTEGER NOT NULL,
    is_error INTEGER NOT NULL, git_branch TEXT, activity TEXT NOT NULL,
    UNIQUE(source, event_key))`);
  legacy.close();
  const db = openDb(path); // must not throw, must add the column
  const cols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === 'project_raw'));
  openDb(path); // second open: ALTER not re-run
});

test('relabelEvents updates fragmented sessions, preserves originals, idempotent', () => {
  const db = openDb(':memory:');
  insertEvents(db, [
    makeEvent({ eventKey: 'e1', sessionId: 's1', project: 'backend' }),
    makeEvent({ eventKey: 'e2', sessionId: 's1', project: 'frontend' }),
    makeEvent({ eventKey: 'e3', sessionId: 's1', project: 'process' }),
    makeEvent({ eventKey: 'e4', sessionId: 'other', project: 'untouched' }),
  ]);
  const n = relabelEvents(db, new Map([['claude-code\x1fs1', 'process']]));
  assert.equal(n, 2); // e3 already matched, e4 not in map
  const rows = db.prepare(`SELECT event_key, project, project_raw FROM events ORDER BY event_key`).all() as
    Array<{ event_key: string; project: string; project_raw: string | null }>;
  assert.deepEqual(rows.map((r) => r.project), ['process', 'process', 'process', 'untouched']);
  assert.deepEqual(rows.map((r) => r.project_raw), ['backend', 'frontend', null, null]);
  assert.equal(relabelEvents(db, new Map([['claude-code\x1fs1', 'process']])), 0); // steady state
  // revert story: one statement restores originals
  db.exec(`UPDATE events SET project = project_raw WHERE project_raw IS NOT NULL`);
  const back = db.prepare(`SELECT project FROM events WHERE event_key IN ('e1','e2') ORDER BY event_key`).all() as
    Array<{ project: string }>;
  assert.deepEqual(back.map((r) => r.project), ['backend', 'frontend']);
});

test('relabel preserves frozen intent fields but syncs the project column', () => {
  const db = openDb(':memory:');
  insertEvents(db, [
    makeEvent({ eventKey: 'e1', sessionId: 's1', project: 'backend', timestamp: '2026-06-01T00:00:00.000Z' }),
  ]);
  recordIntents(db, [{
    sessionId: 's1', source: 'claude-code', project: 'backend', intentId: 'i1',
    label: 'fix retry', fingerprint: ['fix', 'retry'], hasText: true, firstSeen: '2026-06-01T00:00:00.000Z',
  }]);
  relabelEvents(db, new Map([['claude-code\x1fs1', 'process']]));
  assert.equal(syncIntentProjects(db), 1);
  const row = loadIntents(db, ['s1']).get('s1')!;
  assert.equal(row.project, 'process'); // location metadata follows the events
  assert.equal(row.intent_id, 'i1'); // frozen fields untouched
  assert.equal(row.label, 'fix retry');
  assert.deepEqual(JSON.parse(row.fingerprint), ['fix', 'retry']);
  assert.equal(row.first_seen, '2026-06-01T00:00:00.000Z');
  assert.equal(syncIntentProjects(db), 0); // nothing left to sync
});

test('project aliases relabel at collect time; missing/corrupt file reads empty', () => {
  const db = openDb(':memory:');
  insertEvents(db, [
    makeEvent({ eventKey: 'a1', sessionId: 'w1', project: 'quaestor-cl-iter-02', timestamp: new Date().toISOString() }),
    makeEvent({ eventKey: 'a2', sessionId: 'w2', project: 'keep-me', timestamp: new Date().toISOString() }),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'tm-alias-'));
  const aliasPath = join(dir, 'project-aliases.json');
  writeFileSync(aliasPath, JSON.stringify({ 'quaestor-cl-iter-02': 'quaestor', 'self': 'self', 'bad': 7 }));
  const aliases = loadProjectAliases(aliasPath);
  assert.deepEqual(aliases, { 'quaestor-cl-iter-02': 'quaestor', self: 'self' });
  assert.equal(applyProjectAliases(db, aliases), 1); // self->self skipped, keep-me untouched
  const row = db.prepare(`SELECT project, project_raw FROM events WHERE event_key = 'a1'`).get() as
    { project: string; project_raw: string };
  assert.equal(row.project, 'quaestor');
  assert.equal(row.project_raw, 'quaestor-cl-iter-02');
  // SQL filters see the new label (the display/filter consistency fix)
  assert.equal(loadEvents(db, { project: 'quaestor' }).length, 1);
  assert.equal(loadEvents(db, { project: 'quaestor-cl-iter-02' }).length, 0);
  assert.deepEqual(loadProjectAliases(join(dir, 'nope.json')), {});
  writeFileSync(aliasPath, '{corrupt');
  assert.deepEqual(loadProjectAliases(aliasPath), {});
});

test('syncIntentProjects is source-scoped: a cross-source session_id collision cannot cross-write', () => {
  const db = openDb(':memory:');
  insertEvents(db, [
    makeEvent({ eventKey: 'cc1', sessionId: 'shared', source: 'claude-code', project: 'proc', timestamp: '2026-06-01T00:00:00.000Z' }),
    makeEvent({ eventKey: 'gx1', sessionId: 'shared', source: 'gemini-cli', project: 'other', timestamp: '2026-05-01T00:00:00.000Z' }),
  ]);
  recordIntents(db, [{
    sessionId: 'shared', source: 'claude-code', project: 'proc', intentId: 'i1',
    label: 'l', fingerprint: ['l'], hasText: true, firstSeen: '2026-06-01T00:00:00.000Z',
  }]);
  // Nothing to sync: the claude-code events already agree; the gemini event
  // (earlier ts, different project) must be invisible to this intent row.
  assert.equal(syncIntentProjects(db), 0);
  assert.equal(loadIntents(db, ['shared']).get('shared')!.project, 'proc');
});

// ---- subagent accounting (#63) ----------------------------------------------

test('openDb migrates a pre-0.12 db (no subagent columns) and defaults old rows to main-loop', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-mig12-')), 'old.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, event_key TEXT NOT NULL,
    session_id TEXT NOT NULL, project TEXT NOT NULL, ts TEXT NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
    thinking_tokens INTEGER NOT NULL, tools TEXT NOT NULL, has_thinking INTEGER NOT NULL,
    is_error INTEGER NOT NULL, git_branch TEXT, activity TEXT NOT NULL, project_raw TEXT,
    UNIQUE(source, event_key))`);
  legacy.prepare(`INSERT INTO events
    (source, event_key, session_id, project, ts, model, input_tokens, output_tokens,
     cache_read_tokens, cache_creation_tokens, thinking_tokens, tools, has_thinking, is_error, activity)
    VALUES ('claude-code','pre1','s0','p0','2026-06-01T00:00:00.000Z','m',1,1,0,0,0,'[]',0,0,'coding')`).run();
  legacy.close();

  const db = openDb(path);
  const cols = (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ['is_sidechain', 'parent_session_id', 'agent_type']) assert.ok(cols.includes(c));
  // Pre-existing rows are genuinely main-loop turns: collect never read a
  // subagent transcript before this version, so 0/NULL is true, not a guess.
  const [row] = loadEvents(db);
  assert.equal(row.is_sidechain, 0);
  assert.equal(row.parent_session_id, null);
  openDb(path); // second open: ALTERs are not re-run
});

test('loadEvents still reads a db whose subagent migration never ran', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-nomig-')), 'old.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, event_key TEXT NOT NULL,
    session_id TEXT NOT NULL, project TEXT NOT NULL, ts TEXT NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
    thinking_tokens INTEGER NOT NULL, tools TEXT NOT NULL, has_thinking INTEGER NOT NULL,
    is_error INTEGER NOT NULL, git_branch TEXT, activity TEXT NOT NULL,
    UNIQUE(source, event_key));
    INSERT INTO events (source, event_key, session_id, project, ts, model, input_tokens,
      output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, tools,
      has_thinking, is_error, activity)
    VALUES ('claude-code','x','s','p','2026-06-01T00:00:00.000Z','m',1,1,0,0,0,'[]',0,0,'coding')`);
  // Read the un-migrated handle directly, as a locked/read-only DB would be.
  const rows = loadEvents(legacy);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_sidechain, 0);
  assert.equal(rows[0].agent_type, null);
});

test('subagent fields survive the insert/load round trip and dedup by event key', () => {
  const db = openDb(':memory:');
  const events = [
    makeEvent({ eventKey: 'm1', sessionId: 's1' }),
    makeEvent({ eventKey: 'g1', sessionId: 'a1', isSidechain: true, parentSessionId: 's1', agentType: 'Explore' }),
  ];
  assert.equal(insertEvents(db, events), 2);
  assert.equal(insertEvents(db, events), 0);
  const rows = loadEvents(db);
  const agent = rows.find((r) => r.session_id === 'a1')!;
  assert.equal(agent.is_sidechain, 1);
  assert.equal(agent.parent_session_id, 's1');
  assert.equal(agent.agent_type, 'Explore');
  assert.equal(rows.find((r) => r.session_id === 's1')!.is_sidechain, 0);
});

test('the session index exists on new and pre-existing dbs', () => {
  // relabelEvents runs one UPDATE per session; without this index each one is
  // a full table scan, which subagent runs multiply by the fan-out factor.
  const path = join(mkdtempSync(join(tmpdir(), 'tm-idx-')), 'db.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, event_key TEXT NOT NULL,
    session_id TEXT NOT NULL, project TEXT NOT NULL, ts TEXT NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
    thinking_tokens INTEGER NOT NULL, tools TEXT NOT NULL, has_thinking INTEGER NOT NULL,
    is_error INTEGER NOT NULL, git_branch TEXT, activity TEXT NOT NULL,
    UNIQUE(source, event_key))`);
  legacy.close();
  for (const db of [openDb(path), openDb(':memory:')]) {
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN UPDATE events SET project = 'x' WHERE source = 'claude-code' AND session_id = 's'`,
    ).all() as Array<{ detail: string }>;
    assert.match(plan.map((r) => r.detail).join(' '), /idx_events_session/);
  }
});

test('the cache-TTL split survives the round trip and migrates onto old dbs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-ttl-')), 'old.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, event_key TEXT NOT NULL,
    session_id TEXT NOT NULL, project TEXT NOT NULL, ts TEXT NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
    thinking_tokens INTEGER NOT NULL, tools TEXT NOT NULL, has_thinking INTEGER NOT NULL,
    is_error INTEGER NOT NULL, git_branch TEXT, activity TEXT NOT NULL,
    UNIQUE(source, event_key));
    INSERT INTO events (source, event_key, session_id, project, ts, model, input_tokens,
      output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, tools,
      has_thinking, is_error, activity)
    VALUES ('claude-code','pre','s0','p','2026-06-01T00:00:00.000Z','m',1,1,0,900,0,'[]',0,0,'coding')`);
  legacy.close();

  const db = openDb(path);
  // Pre-existing rows default to 0 — i.e. all-5-minute, which is what they were.
  assert.equal(loadEvents(db)[0].cache_creation_1h_tokens, 0);
  openDb(path); // idempotent: the ALTER is not re-run

  insertEvents(db, [
    makeEvent({ eventKey: 'n1', cacheCreationTokens: 1000, cacheCreation1hTokens: 800 }),
    makeEvent({ eventKey: 'n2', cacheCreationTokens: 1000 }), // adapter didn't report a split
  ]);
  const rows = loadEvents(db);
  assert.equal(rows.find((r) => r.cache_creation_tokens === 1000 && r.cache_creation_1h_tokens === 800)?.cache_creation_1h_tokens, 800);
  assert.equal(rows.filter((r) => r.cache_creation_1h_tokens === 0).length, 2);
});

test('alias chains resolve to a fixed point so collects reach steady state (#74)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-chain-'));
  const write = (map: unknown) => {
    const f = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(map));
    return loadProjectAliases(f);
  };

  // a -> b -> c collapses to a single terminal target...
  assert.deepEqual(write({ a: 'b', b: 'c' }), { a: 'c', b: 'c' });
  // ...and the answer no longer depends on JSON key order.
  assert.deepEqual(write({ b: 'c', a: 'b' }), { b: 'c', a: 'c' });
  // A cycle has no terminal target: each key collapses to itself, which
  // applyProjectAliases skips — no loop, no arbitrary winner.
  assert.deepEqual(write({ a: 'b', b: 'a' }), { a: 'a', b: 'b' });
  // A self-map is a no-op, and unrelated entries are untouched.
  assert.deepEqual(write({ x: 'x', p: 'q' }), { x: 'x', p: 'q' });

  // The end-to-end property: with the chain resolved, the second collect is silent.
  const aliases = write({ a: 'b', b: 'c' });
  const db = openDb(':memory:');
  insertEvents(db, [makeEvent({ eventKey: 'e1', sessionId: 's1', project: 'a' })]);
  const collect = () => {
    const sessions = new Map([[`claude-code\x1fs1`, aliases['a'] ?? 'a']]);
    return relabelEvents(db, sessions) + applyProjectAliases(db, aliases);
  };
  assert.ok(collect() > 0, 'first collect does the relabel');
  assert.equal(collect(), 0, 'second collect must be silent');
  assert.equal(collect(), 0);
  assert.equal(loadEvents(db)[0].project, 'c');
});
