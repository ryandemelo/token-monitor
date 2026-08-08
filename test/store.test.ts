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
  relabelEvents, loadProjectAliases, applyProjectAliases, syncIntentProjects,
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
