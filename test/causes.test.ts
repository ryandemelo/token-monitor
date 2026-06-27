import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeCause } from '../src/causes.js';
import { computeMetrics } from '../src/metrics.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';

test('low-cache-hit: a TTL-gap turn pins the cause to cold restarts', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 's1', ts: '2026-06-01T00:00:00Z', input_tokens: 10_000, output_tokens: 0 }),
    makeStored({ session_id: 's1', ts: '2026-06-01T00:20:00Z', input_tokens: 200_000, output_tokens: 0 }),
  ];
  const cb = decomposeCause('low-cache-hit', events)!;
  assert.ok(cb);
  assert.equal(cb.dominant.key, 'cold-restarts');
  // shares are normalised and sorted desc (the true token partition is asserted
  // in the mixed-session reconciliation test below, not by this sum).
  assert.ok(Math.abs(cb.causes.reduce((s, c) => s + c.share, 0) - 1) < 1e-9);
  for (let i = 1; i < cb.causes.length; i++) assert.ok(cb.causes[i - 1].share >= cb.causes[i].share);
  assert.ok(cb.dominant.tokens === 200_000);
});

test('low-cache-hit: single-turn sessions can never warm the cache', () => {
  const events: StoredEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push(makeStored({ session_id: `s${i}`, ts: `2026-06-0${i + 1}T00:00:00Z`, input_tokens: 50_000, output_tokens: 0 }));
  }
  const cb = decomposeCause('low-cache-hit', events)!;
  assert.equal(cb.dominant.key, 'short-sessions');
  assert.ok(Math.abs(cb.dominant.share - 1) < 1e-9);
});

test('low-cache-hit: late-session growth attributes to context churn', () => {
  // 8-turn session, early turns tiny, late turns large, no idle gaps.
  const events = Array.from({ length: 8 }, (_, i) =>
    makeStored({
      session_id: 'big',
      ts: `2026-06-01T00:0${i}:00Z`,
      input_tokens: i < 4 ? 100 : 5_000,
      output_tokens: 0,
    }),
  );
  const cb = decomposeCause('low-cache-hit', events)!;
  assert.equal(cb.dominant.key, 'context-churn');
  // late half (4 turns × 5000) dwarfs the steady early half
  assert.equal(cb.dominant.tokens, 20_000);
});

test('high-rework: rework with no testing pins the cause to a missing test gate', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'r1', ts: '2026-06-01T00:00:00Z', activity: 'coding', is_error: 1, input_tokens: 1_000, output_tokens: 1_000 }),
    makeStored({ session_id: 'r1', ts: '2026-06-01T00:00:30Z', activity: 'coding', input_tokens: 50_000, output_tokens: 5_000 }),
    makeStored({ session_id: 'r1', ts: '2026-06-01T00:01:00Z', activity: 'coding', input_tokens: 50_000, output_tokens: 5_000 }),
  ];
  const cb = decomposeCause('high-rework', events)!;
  assert.equal(cb.dominant.key, 'no-test-gate');
  assert.equal(cb.dominant.tokens, 110_000); // the two coding turns after the failure
});

test('high-rework: heavy test failures pin the cause to broad failures', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'r2', ts: '2026-06-01T00:00:00Z', activity: 'testing', is_error: 1, input_tokens: 5_000, output_tokens: 0 }),
    makeStored({ session_id: 'r2', ts: '2026-06-01T00:00:10Z', activity: 'testing', is_error: 1, input_tokens: 5_000, output_tokens: 0 }),
    makeStored({ session_id: 'r2', ts: '2026-06-01T00:00:20Z', activity: 'coding', input_tokens: 5_000, output_tokens: 0 }),
    makeStored({ session_id: 'r2', ts: '2026-06-01T00:00:30Z', activity: 'testing', is_error: 1, input_tokens: 5_000, output_tokens: 0 }),
    makeStored({ session_id: 'r2', ts: '2026-06-01T00:00:40Z', activity: 'coding', input_tokens: 5_000, output_tokens: 0 }),
  ];
  const cb = decomposeCause('high-rework', events)!;
  assert.equal(cb.dominant.key, 'broad-failures');
});

test('decomposeCause stays silent when there is nothing to explain', () => {
  // No decomposer for this finding key.
  const some = [makeStored({ session_id: 's', input_tokens: 100_000, output_tokens: 0 })];
  assert.equal(decomposeCause('premium-misroute', some), undefined);
  // high-rework with no failure -> no rework tokens -> no cause.
  const clean = [makeStored({ session_id: 's', activity: 'coding', input_tokens: 100_000, output_tokens: 0 })];
  assert.equal(decomposeCause('high-rework', clean), undefined);
});

test('low-cache-hit: late growth served from CACHE is not churn (matches the bloat signal)', () => {
  // 8-turn session whose late-half context doubles, but the growth is cache
  // reads, not fresh input — metrics.ts would NOT count this as bloated, so the
  // cause must not claim context churn either (regression for the missing
  // BLOAT_FRESH_SHARE gate).
  const events = Array.from({ length: 8 }, (_, i) =>
    makeStored({
      session_id: 'cached',
      ts: `2026-06-01T00:0${i}:00Z`,
      input_tokens: 1_000,
      cache_read_tokens: i < 4 ? 0 : 50_000, // late context grows from reads
      output_tokens: 0,
    }),
  );
  // Sanity: the metric itself sees no bloat here.
  assert.equal(computeMetrics(events).bloatedSessions, 0);
  // ...and every fresh token is steady-state, so no actionable cause is named.
  assert.equal(decomposeCause('low-cache-hit', events), undefined);
});

test('low-cache-hit: a baseline majority is surfaced but never named the dominant lever', () => {
  const events: StoredEvent[] = [];
  // 10-turn steady session: 800k fresh, all steady-state (no gaps, no bloat).
  for (let i = 0; i < 10; i++) {
    events.push(makeStored({ session_id: 'steady', ts: `2026-06-01T00:${String(i).padStart(2, '0')}:00Z`, input_tokens: 80_000, output_tokens: 0 }));
  }
  // Cold session: two >5-min-gap turns re-pay 200k fresh.
  events.push(makeStored({ session_id: 'cold', ts: '2026-06-01T01:00:00Z', input_tokens: 0, output_tokens: 0 }));
  events.push(makeStored({ session_id: 'cold', ts: '2026-06-01T01:10:00Z', input_tokens: 100_000, output_tokens: 0 }));
  events.push(makeStored({ session_id: 'cold', ts: '2026-06-01T01:20:00Z', input_tokens: 100_000, output_tokens: 0 }));
  const cb = decomposeCause('low-cache-hit', events)!;
  assert.equal(cb.causes[0].key, 'steady-state'); // baseline owns the largest share (~80%)
  assert.equal(cb.dominant.key, 'cold-restarts'); // ...but the dominant lever is the actionable one
  assert.ok(cb.causes.some((c) => c.key === 'steady-state')); // baseline still surfaced for context
});

test('low-cache-hit: an actionable cause below the floor stays silent rather than over-claim', () => {
  const events: StoredEvent[] = [];
  for (let i = 0; i < 10; i++) {
    events.push(makeStored({ session_id: 'steady', ts: `2026-06-01T00:${String(i).padStart(2, '0')}:00Z`, input_tokens: 100_000, output_tokens: 0 }));
  }
  events.push(makeStored({ session_id: 'cold', ts: '2026-06-01T01:00:00Z', input_tokens: 0, output_tokens: 0 }));
  events.push(makeStored({ session_id: 'cold', ts: '2026-06-01T01:10:00Z', input_tokens: 50_000, output_tokens: 0 })); // ~4.7% < 0.15
  assert.equal(decomposeCause('low-cache-hit', events), undefined);
});

test('low-cache-hit: DOMINANT_FLOOR boundary — just under stays silent, just over fires', () => {
  // 5-turn (non-short, non-bloated: <8 turns) single session; cold is the only
  // non-baseline bucket. turns 1-3 carry no fresh input, so they drop out.
  const mk = (turn0: number, turn4: number): StoredEvent[] => [
    makeStored({ session_id: 's', ts: '2026-06-01T00:00:00Z', input_tokens: turn0, output_tokens: 0 }),
    makeStored({ session_id: 's', ts: '2026-06-01T00:01:00Z', input_tokens: 0, output_tokens: 0 }),
    makeStored({ session_id: 's', ts: '2026-06-01T00:02:00Z', input_tokens: 0, output_tokens: 0 }),
    makeStored({ session_id: 's', ts: '2026-06-01T00:03:00Z', input_tokens: 0, output_tokens: 0 }),
    makeStored({ session_id: 's', ts: '2026-06-01T00:10:00Z', input_tokens: turn4, output_tokens: 0 }), // 7-min gap -> cold
  ];
  assert.equal(decomposeCause('low-cache-hit', mk(86_000, 14_000)), undefined); // cold 14% < floor
  const cb = decomposeCause('low-cache-hit', mk(84_000, 16_000))!; // cold 16% >= floor
  assert.equal(cb.dominant.key, 'cold-restarts');
  assert.equal(cb.dominant.tokens, 16_000);
});

test('low-cache-hit: buckets are a true partition and cold reconciles with metrics', () => {
  const events: StoredEvent[] = [
    makeStored({ session_id: 'cold', ts: '2026-06-01T00:00:00Z', input_tokens: 10_000, output_tokens: 0 }),
    makeStored({ session_id: 'cold', ts: '2026-06-01T00:20:00Z', input_tokens: 50_000, cache_creation_tokens: 20_000, output_tokens: 0 }),
    makeStored({ session_id: 'short', ts: '2026-06-02T00:00:00Z', input_tokens: 8_000, output_tokens: 0 }),
    ...Array.from({ length: 8 }, (_, i) => makeStored({ session_id: 'churn', ts: `2026-06-03T00:0${i}:00Z`, input_tokens: i < 4 ? 100 : 5_000, output_tokens: 0 })),
    ...Array.from({ length: 6 }, (_, i) => makeStored({ session_id: 'steady', ts: `2026-06-04T00:0${i}:00Z`, input_tokens: 1_000, output_tokens: 0 })),
  ];
  const cb = decomposeCause('low-cache-hit', events)!;
  const bucketSum = cb.causes.reduce((s, c) => s + c.tokens, 0);
  const fresh = events.reduce((s, e) => s + e.input_tokens + e.cache_creation_tokens, 0);
  assert.equal(bucketSum, fresh); // disjoint + complete: catches any double-count or dropped token
  const cold = cb.causes.find((c) => c.key === 'cold-restarts')!;
  assert.equal(cold.tokens, computeMetrics(events).coldRestartTokens); // cross-module reconciliation
});

test('high-rework: repeated testing->coding loops attribute to stacked corrections', () => {
  const acts = ['coding', 'testing', 'coding', 'testing', 'coding', 'testing', 'coding'] as const;
  const events = acts.map((activity, i) =>
    makeStored({
      session_id: 'r', ts: `2026-06-01T00:0${i}:00Z`, activity,
      is_error: i === 0 ? 1 : 0, // single failure -> low error rate, but 3 fix loops
      input_tokens: 5_000, output_tokens: 0,
    }),
  );
  const cb = decomposeCause('high-rework', events)!;
  assert.equal(cb.dominant.key, 'stacked-corrections');
});

test('high-rework: rework with no dominant pattern lands in the baseline and stays silent', () => {
  const acts = ['coding', 'testing', 'coding', 'coding'] as const; // 1 fix, 25% errors, has tests
  const events = acts.map((activity, i) =>
    makeStored({
      session_id: 'r', ts: `2026-06-01T00:0${i}:00Z`, activity,
      is_error: i === 0 ? 1 : 0,
      input_tokens: 5_000, output_tokens: 0,
    }),
  );
  assert.equal(decomposeCause('high-rework', events), undefined);
});
