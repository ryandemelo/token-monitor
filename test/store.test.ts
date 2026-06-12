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
