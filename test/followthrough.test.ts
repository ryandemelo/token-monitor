import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store.js';
import { computeMetrics } from '../src/metrics.js';
import { syncFindings, structuredFindings, premiumShare } from '../src/followthrough.js';
import { makeStored } from './helpers.js';

// Big spend, no cache reads -> 'low-cache-hit' fires.
const badCache = () =>
  computeMetrics([
    makeStored({ activity: 'coding', input_tokens: 200_000, output_tokens: 0 }),
  ]);

// Same spend, heavy cache reuse -> finding no longer fires.
const goodCache = () =>
  computeMetrics([
    makeStored({ activity: 'coding', input_tokens: 200_000, output_tokens: 0, cache_read_tokens: 2_000_000 }),
  ]);

test('structuredFindings fires and clears on cache hit ratio', () => {
  assert.ok(structuredFindings(badCache()).some((f) => f.key === 'low-cache-hit'));
  assert.ok(!structuredFindings(goodCache()).some((f) => f.key === 'low-cache-hit'));
});

test('first sync records a baseline with status new', () => {
  const db = openDb(':memory:');
  const rows = syncFindings(db, badCache(), '2026-06-01T00:00:00.000Z');
  const row = rows.find((r) => r.key === 'low-cache-hit');
  assert.ok(row);
  assert.equal(row.status, 'new');
  assert.equal(row.baseline, 0);
});

test('improvement past threshold resolves the recommendation', () => {
  const db = openDb(':memory:');
  syncFindings(db, badCache(), '2026-06-01T00:00:00.000Z');
  const rows = syncFindings(db, goodCache(), '2026-06-08T00:00:00.000Z');
  const row = rows.find((r) => r.key === 'low-cache-hit');
  assert.ok(row);
  assert.equal(row.status, 'resolved');
  assert.equal(row.baseline, 0); // baseline preserved
  assert.ok(row.current > 0.9); // current re-measured
});

test('finding re-firing after resolution re-opens tracking', () => {
  const db = openDb(':memory:');
  syncFindings(db, badCache(), '2026-06-01T00:00:00.000Z');
  syncFindings(db, goodCache(), '2026-06-08T00:00:00.000Z'); // resolved
  const rows = syncFindings(db, badCache(), '2026-06-15T00:00:00.000Z'); // regression
  const row = rows.find((r) => r.key === 'low-cache-hit');
  assert.ok(row);
  assert.notEqual(row.status, 'resolved');
});

test('still-bad metric stays tracking, small moves are not noise-flagged', () => {
  const db = openDb(':memory:');
  syncFindings(db, badCache(), '2026-06-01T00:00:00.000Z');
  const rows = syncFindings(db, badCache(), '2026-06-08T00:00:00.000Z');
  assert.equal(rows.find((r) => r.key === 'low-cache-hit')?.status, 'tracking');
});

test('premiumShare measures premium-model token share', () => {
  const m = computeMetrics([
    makeStored({ model: 'claude-opus-4-7', input_tokens: 900, output_tokens: 0 }),
    makeStored({ model: 'claude-haiku-4-5', input_tokens: 100, output_tokens: 0 }),
  ]);
  assert.ok(Math.abs(premiumShare(m) - 0.9) < 1e-9);
});
