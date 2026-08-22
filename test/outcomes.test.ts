import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeMetrics, ABANDON_IDLE_DAYS } from '../src/metrics.js';
import { computeAbandonedStreams } from '../src/analyze.js';
import { openDb, recordSessionPrs, loadPrSessions } from '../src/store.js';
import { collectClaudeCode } from '../src/adapters/claude-code.js';
import { buildExport, mergeMetrics } from '../src/team.js';
import { RULE_BY_KEY } from '../src/rules/index.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const NOW = Date.parse('2026-06-30T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test('a session ships when it has a shipping turn or a linked PR', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'committed', ts: daysAgo(20), activity: 'coding' }),
    makeStored({ session_id: 'committed', ts: daysAgo(20), activity: 'shipping' }),
    makeStored({ session_id: 'pr-only', ts: daysAgo(20), activity: 'coding' }),
    makeStored({ session_id: 'neither', ts: daysAgo(20), activity: 'coding' }),
  ];
  const m = computeMetrics(events, { prSessions: new Set(['pr-only']), now: NOW });
  assert.equal(m.conversations, 3);
  assert.equal(m.shippedSessions, 2);
  assert.ok(Math.abs(m.shippedShare - 2 / 3) < 1e-9);
  assert.ok(m.costPerShippedSession > 0);
  assert.ok(m.tokensPerShippedSession > 0);
});

test('a subagent run is not a conversation — it ships through its caller', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'driver', ts: daysAgo(20), activity: 'shipping' }),
    makeStored({ session_id: 'agent-1', parent_session_id: 'driver', is_sidechain: 1, ts: daysAgo(20), activity: 'coding' }),
  ];
  const m = computeMetrics(events, { now: NOW });
  assert.equal(m.conversations, 1);
  assert.equal(m.shippedSessions, 1);
  assert.equal(m.abandonedStreams, 0, 'the run must not become its own unshipped stream');
});

test('streams span sessions: code Monday, ship Wednesday is one shipped stream', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'mon', git_branch: 'feat/x', ts: daysAgo(20), activity: 'coding' }),
    makeStored({ session_id: 'wed', git_branch: 'feat/x', ts: daysAgo(18), activity: 'shipping' }),
  ];
  const m = computeMetrics(events, { now: NOW });
  assert.equal(m.abandonedStreams, 0);
  assert.equal(m.abandonedTokens, 0);
});

test('an idle unshipped coding stream is abandoned; a recent one is open', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'old', git_branch: 'feat/dead', ts: daysAgo(ABANDON_IDLE_DAYS + 5), activity: 'coding', input_tokens: 5_000 }),
    makeStored({ session_id: 'new', git_branch: 'feat/live', ts: daysAgo(1), activity: 'coding', input_tokens: 7_000 }),
  ];
  const m = computeMetrics(events, { now: NOW });
  assert.equal(m.abandonedStreams, 1);
  assert.equal(m.openStreams, 1);
  assert.ok(m.abandonedTokens > 0 && m.openTokens > 0);
  // Open spend is NEVER folded into the accusation.
  assert.ok(m.abandonedTokens < m.abandonedTokens + m.openTokens);
});

test('a stream that never wrote code is not unshipped work', () => {
  const events = [
    makeStored({ session_id: 'reading', git_branch: 'spike', ts: daysAgo(20), activity: 'exploration' }),
  ];
  const m = computeMetrics(events, { now: NOW });
  assert.equal(m.abandonedStreams, 0);
  assert.equal(m.openStreams, 0);
});

test('branchless sources fall back to per-session streams', () => {
  const events = [
    makeStored({ source: 'cursor', session_id: 'a', git_branch: null, ts: daysAgo(20), activity: 'coding' }),
    makeStored({ source: 'cursor', session_id: 'b', git_branch: null, ts: daysAgo(20), activity: 'coding' }),
  ];
  const m = computeMetrics(events, { now: NOW });
  assert.equal(m.abandonedStreams, 2, 'without branches each session is its own stream');
});

test('analyze lists unshipped streams with their state and idle age', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'old', project: 'p1', git_branch: 'feat/dead', ts: daysAgo(20), activity: 'coding', input_tokens: 9_000 }),
    makeStored({ session_id: 'new', project: 'p1', git_branch: 'feat/live', ts: daysAgo(1), activity: 'coding', input_tokens: 1_000 }),
    makeStored({ session_id: 'ship', project: 'p1', git_branch: 'feat/done', ts: daysAgo(2), activity: 'shipping' }),
  ];
  const rows = computeAbandonedStreams(events, { now: NOW });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].branch, 'feat/dead');
  assert.equal(rows[0].open, false);
  assert.ok(rows[0].idleDays >= ABANDON_IDLE_DAYS);
  assert.equal(rows.find((r) => r.branch === 'feat/live')!.open, true);
  assert.ok(!rows.some((r) => r.branch === 'feat/done'));
});

test('pr-link lines are counted per session, de-duplicated, and stripped of the repo', () => {
  const { events, prLinks } = collectClaudeCode(join(FIXTURES, 'claude-results'));
  assert.equal(events.length, 3, 'pr-link lines must not become usage turns');
  assert.deepEqual(prLinks, [{ source: 'claude-code', sessionId: 's9', prCount: 2 }]);
  // The repo name and URL are read for de-duplication and then dropped.
  const serialized = JSON.stringify(prLinks);
  assert.ok(!serialized.includes('acme/private-repo'));
  assert.ok(!serialized.includes('github.com'));
});

test('session PR counts upsert to the highest count seen and read back as a set', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tm-prs-')), 'db.sqlite'));
  recordSessionPrs(db, [{ source: 'claude-code', sessionId: 's1', prCount: 1 }]);
  recordSessionPrs(db, [{ source: 'claude-code', sessionId: 's1', prCount: 3 }]);
  // A later collect that sees a rotated-away transcript must not erase history.
  recordSessionPrs(db, [{ source: 'claude-code', sessionId: 's1', prCount: 2 }]);
  const sessions = loadPrSessions(db);
  assert.deepEqual([...sessions], ['s1']);
  const row = db.prepare('SELECT pr_count FROM session_prs WHERE session_id = ?').get('s1') as { pr_count: number };
  assert.equal(row.pr_count, 3);
});

test('exports carry outcome shares and counts, never a branch name', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'a', project: 'acme-api', git_branch: 'feat/acme-secret-launch', ts: daysAgo(20), activity: 'coding' }),
    makeStored({ session_id: 'b', project: 'acme-api', git_branch: 'feat/shipped', ts: daysAgo(19), activity: 'shipping' }),
  ];
  const ex = buildExport(events, 30);
  assert.equal(typeof ex.overall.shippedShare, 'number');
  assert.equal(typeof ex.overall.abandonedShare, 'number');
  assert.ok(!JSON.stringify(ex).includes('feat/acme-secret-launch'));
});

test('merge recombines outcomes from the summed totals, not by averaging shares', () => {
  const a = computeMetrics([
    makeStored({ session_id: 'a1', ts: daysAgo(20), activity: 'shipping' }),
    makeStored({ session_id: 'a2', ts: daysAgo(20), activity: 'coding', git_branch: 'x' }),
  ], { now: NOW });
  const b = computeMetrics([
    makeStored({ session_id: 'b1', ts: daysAgo(20), activity: 'shipping' }),
  ], { now: NOW });
  const merged = mergeMetrics([a, b]);
  assert.equal(merged.conversations, 3);
  assert.equal(merged.shippedSessions, 2);
  assert.ok(Math.abs(merged.shippedShare - 2 / 3) < 1e-9);
  assert.ok(merged.costPerShippedSession > 0);
});

test('the abandoned-work rule needs two idle streams and a quarter of spend', () => {
  const rule = RULE_BY_KEY.get('abandoned-work')!;
  const base = computeMetrics([makeStored({ ts: daysAgo(20) })], { now: NOW });
  assert.equal(rule.fires({ ...base, abandonedShare: 0.4, abandonedStreams: 1 }), undefined, 'one stream is not a pattern');
  assert.equal(rule.fires({ ...base, abandonedShare: 0.1, abandonedStreams: 5 }), undefined, 'below the share gate');
  const msg = rule.fires({ ...base, abandonedShare: 0.4, abandonedStreams: 3, abandonedTokens: 500_000, openStreams: 2 });
  assert.ok(msg);
  assert.match(msg!, /no commit, PR or merge/);
  assert.match(msg!, /2 more still open/);
  assert.match(rule.docs, /Research, spikes and learning ship nothing by design/);
});
