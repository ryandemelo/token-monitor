import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/metrics.js';
import { makeStored } from './helpers.js';

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
