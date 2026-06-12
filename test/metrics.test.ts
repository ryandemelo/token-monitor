import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, contextGrowthOf } from '../src/metrics.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';

test('totals, sessions and cache hit ratio', () => {
  const m = computeMetrics([
    makeStored({ session_id: 'a', input_tokens: 100, output_tokens: 200, cache_read_tokens: 700, cache_creation_tokens: 200 }),
    makeStored({ session_id: 'b', input_tokens: 50, output_tokens: 50 }),
  ]);
  assert.equal(m.events, 2);
  assert.equal(m.sessions, 2);
  assert.equal(m.inputTokens, 150);
  assert.equal(m.outputTokens, 250);
  assert.equal(m.spendTokens, 400);
  // 700 read / (700 read + 150 input + 200 creation)
  assert.ok(Math.abs(m.cacheHitRatio - 700 / 1050) < 1e-9);
});

test('rework ratio counts coding/testing spend after first failed turn in a session', () => {
  const m = computeMetrics([
    makeStored({ ts: '2026-06-01T00:00:01Z', activity: 'coding', input_tokens: 1000, output_tokens: 1000 }),
    makeStored({ ts: '2026-06-01T00:00:02Z', activity: 'testing', is_error: 1, input_tokens: 500, output_tokens: 500 }),
    makeStored({ ts: '2026-06-01T00:00:03Z', activity: 'coding', input_tokens: 1000, output_tokens: 1000 }),
    makeStored({ ts: '2026-06-01T00:00:04Z', activity: 'testing', input_tokens: 1000, output_tokens: 1000 }),
  ]);
  // events after the failure: 2000 + 2000 of 7000 total
  assert.ok(Math.abs(m.reworkRatio - 4000 / 7000) < 1e-9);
});

test('no failures means zero rework', () => {
  const m = computeMetrics([
    makeStored({ activity: 'coding' }),
    makeStored({ activity: 'testing' }),
  ]);
  assert.equal(m.reworkRatio, 0);
});

test('activity shares sum to 1 over spend tokens', () => {
  const m = computeMetrics([
    makeStored({ activity: 'coding', input_tokens: 300, output_tokens: 0 }),
    makeStored({ activity: 'exploration', input_tokens: 100, output_tokens: 0 }),
  ]);
  assert.ok(Math.abs(m.byActivity.coding.share - 0.75) < 1e-9);
  assert.ok(Math.abs(m.byActivity.exploration.share - 0.25) < 1e-9);
});

// 8-turn session: tiny early context, late context fresh-paid (no cache reads).
function bloatedSession(id: string): StoredEvent[] {
  return Array.from({ length: 8 }, (_, i) =>
    makeStored({
      session_id: id,
      ts: `2026-06-01T00:0${i}:00Z`,
      input_tokens: i < 4 ? 100 : 5000,
      output_tokens: 0,
    }),
  );
}

test('context bloat: flags late context growth paid fresh, not growth served from cache', () => {
  const m = computeMetrics(bloatedSession('s1'));
  assert.equal(m.trendSessions, 1);
  assert.equal(m.bloatedSessions, 1);
  assert.equal(m.contextBloatShare, 1);

  // Same growth, but the late context is almost all cache reads — cache keeps pace.
  const cached = computeMetrics(
    Array.from({ length: 8 }, (_, i) =>
      makeStored({
        session_id: 'c',
        ts: `2026-06-01T00:0${i}:00Z`,
        input_tokens: 100,
        cache_read_tokens: i < 4 ? 0 : 5000,
        output_tokens: 0,
      }),
    ),
  );
  assert.equal(cached.trendSessions, 1);
  assert.equal(cached.bloatedSessions, 0);

  // Short sessions are not measurable.
  const short = computeMetrics([makeStored({}), makeStored({})]);
  assert.equal(short.trendSessions, 0);
  assert.equal(short.contextBloatShare, 0);
});

test('contextGrowthOf reports the late/early ratio', () => {
  const g = contextGrowthOf(bloatedSession('s1'));
  assert.ok(g);
  assert.ok(Math.abs(g.ratio - 50) < 1e-9); // 5000 avg late / 100 avg early
  assert.equal(g.lateFreshShare, 1);
  assert.equal(contextGrowthOf(bloatedSession('s1').slice(0, 4)), undefined);
});

test('cold restarts: turns past the ~5-min cache TTL re-pay input + cache writes', () => {
  const m = computeMetrics([
    makeStored({ ts: '2026-06-01T00:00:00Z', input_tokens: 1000, cache_creation_tokens: 500, output_tokens: 0 }),
    makeStored({ ts: '2026-06-01T00:01:00Z', input_tokens: 1000, output_tokens: 0 }), // warm
    makeStored({ ts: '2026-06-01T00:11:00Z', input_tokens: 2000, cache_creation_tokens: 1000, output_tokens: 0 }), // 10-min gap
  ]);
  assert.equal(m.coldRestartTurns, 1);
  assert.equal(m.coldRestartTokens, 3000);
  // 3000 / (4000 input + 1500 cache writes)
  assert.ok(Math.abs(m.coldRestartShare - 3000 / 5500) < 1e-9);
});

test('premium waste: premium-model tokens on exploration/conversation turns only', () => {
  const m = computeMetrics([
    makeStored({ model: 'claude-opus-4-7', activity: 'exploration', input_tokens: 600, output_tokens: 0 }),
    makeStored({ model: 'claude-opus-4-7', activity: 'coding', input_tokens: 300, output_tokens: 0 }),
    makeStored({ model: 'claude-haiku-4-5', activity: 'conversation', input_tokens: 100, output_tokens: 0 }),
  ]);
  assert.equal(m.premiumWasteTokens, 600);
  assert.ok(Math.abs(m.premiumWasteShare - 0.6) < 1e-9);
});

test('retry loops: spend on turns re-running the tool that just errored', () => {
  const m = computeMetrics([
    makeStored({ ts: '2026-06-01T00:00:01Z', tools: '["Bash"]', is_error: 1, input_tokens: 100, output_tokens: 0 }),
    makeStored({ ts: '2026-06-01T00:00:02Z', tools: '["Bash"]', input_tokens: 400, output_tokens: 0 }), // retry
    makeStored({ ts: '2026-06-01T00:00:03Z', tools: '["Bash"]', input_tokens: 300, output_tokens: 0 }), // previous turn clean
    makeStored({ ts: '2026-06-01T00:00:04Z', tools: '["Read"]', is_error: 1, input_tokens: 100, output_tokens: 0 }),
    makeStored({ ts: '2026-06-01T00:00:05Z', tools: '["Bash"]', input_tokens: 200, output_tokens: 0 }), // different tool
  ]);
  assert.equal(m.retryTokens, 400);
  assert.ok(Math.abs(m.retryShare - 400 / 1100) < 1e-9);
});

test('anthropic models are priced exactly, unknown models counted as unpriced', () => {
  const priced = computeMetrics([
    makeStored({ model: 'claude-haiku-4-5', input_tokens: 1_000_000, output_tokens: 0, activity: 'coding' }),
  ]);
  assert.ok(Math.abs(priced.costUsd - 1) < 1e-9); // $1/MTok input
  assert.equal(priced.costEstimated, false);
  assert.equal(priced.costUnpricedTokens, 0);

  const unknown = computeMetrics([
    makeStored({ model: 'totally-new-llm', input_tokens: 100, output_tokens: 100 }),
  ]);
  assert.equal(unknown.costUsd, 0);
  assert.equal(unknown.costUnpricedTokens, 200);
});
