import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertEvents, recordIntents } from '../src/store.js';
import { categorizeSummary, fmtCategorizeSummary } from '../src/categorize.js';
import { makeEvent } from './helpers.js';

const DAYS = { days: 36500 };

function freshDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'tm-catsum-')), 'db.sqlite'));
}

test('categorizeSummary is undefined until intents are recorded, then reports cross-project duplicates', () => {
  const db = freshDb();
  insertEvents(db, [
    makeEvent({ source: 'claude-code', eventKey: 'k1', sessionId: 's1', project: 'proj-a', activity: 'coding' }),
    makeEvent({ source: 'claude-code', eventKey: 'k2', sessionId: 's2', project: 'proj-b', activity: 'coding' }),
  ]);

  // No frozen intents yet -> the cross-surface signal stays silent.
  assert.equal(categorizeSummary(db, DAYS), undefined);

  // Two projects, one shared task -> a duplicate-work cluster.
  const fp = ['jwt', 'auth', 'login', 'rest', 'api'];
  recordIntents(db, [
    { sessionId: 's1', source: 'claude-code', project: 'proj-a', intentId: 'i1', label: 'jwt auth login', fingerprint: fp, hasText: true, firstSeen: '2026-06-01T10:00:00.000Z' },
    { sessionId: 's2', source: 'claude-code', project: 'proj-b', intentId: 'i2', label: 'jwt auth login', fingerprint: fp, hasText: true, firstSeen: '2026-06-01T10:00:00.000Z' },
  ]);

  const s = categorizeSummary(db, DAYS);
  assert.ok(s, 'expected a summary once a cross-project duplicate is recorded');
  assert.equal(s!.duplicateTasks, 1);
  assert.equal(s!.duplicateSessions, 2);
  db.close();
});

test('categorizeSummary gates out no-text clusters (no false duplicate-work accusation)', () => {
  const db = freshDb();
  insertEvents(db, [
    makeEvent({ source: 'claude-code', eventKey: 'k1', sessionId: 's1', project: 'proj-a', activity: 'coding' }),
    makeEvent({ source: 'claude-code', eventKey: 'k2', sessionId: 's2', project: 'proj-b', activity: 'coding' }),
  ]);
  const fp = ['coding', 'edit'];
  recordIntents(db, [
    { sessionId: 's1', source: 'claude-code', project: 'proj-a', intentId: 'i1', label: 'coding edit', fingerprint: fp, hasText: false, firstSeen: '2026-06-01T10:00:00.000Z' },
    { sessionId: 's2', source: 'claude-code', project: 'proj-b', intentId: 'i2', label: 'coding edit', fingerprint: fp, hasText: false, firstSeen: '2026-06-01T10:00:00.000Z' },
  ]);
  // The cluster forms, but with no real text it is never flagged as duplicate work.
  assert.equal(categorizeSummary(db, DAYS), undefined);
  db.close();
});

test('fmtCategorizeSummary: singular/plural wording and the estimated marker', () => {
  assert.equal(
    fmtCategorizeSummary({ duplicateTasks: 1, duplicateSessions: 2, duplicateCost: 4, estimated: false }),
    '1 recurring task spanning ≥2 projects ($4.00)',
  );
  assert.equal(
    fmtCategorizeSummary({ duplicateTasks: 3, duplicateSessions: 7, duplicateCost: 48.5, estimated: true }),
    '3 recurring tasks spanning ≥2 projects (~$48.50)',
  );
});
