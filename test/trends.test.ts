import test from 'node:test';
import assert from 'node:assert/strict';
import { splitWindow, trendRows, verdictOf, fmtTrendValue, projectMovers } from '../src/trends.js';
import { computeMetrics } from '../src/metrics.js';
import { makeStored } from './helpers.js';

const NOW = Date.parse('2026-06-13T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test('splitWindow partitions at the days boundary', () => {
  const events = [
    makeStored({ ts: daysAgo(40) }), // previous window
    makeStored({ ts: daysAgo(31) }), // previous window
    makeStored({ ts: daysAgo(29) }), // current window
    makeStored({ ts: daysAgo(1) }), // current window
  ];
  const { current, previous } = splitWindow(events, 30, NOW);
  assert.equal(current.length, 2);
  assert.equal(previous.length, 2);
  assert.ok(current.every((e) => e.ts >= daysAgo(30)));
});

test('verdictOf: improvement direction per metric, flat tolerance, neutral volumes', () => {
  const prev = computeMetrics([
    makeStored({ activity: 'coding', input_tokens: 1000, output_tokens: 0 }),
  ]);
  const now = computeMetrics([
    makeStored({ activity: 'coding', input_tokens: 1000, output_tokens: 0, cache_read_tokens: 4000 }),
  ]);
  const rows = trendRows(now, prev);
  const by = (label: string) => rows.find((r) => r.label === label)!;

  assert.equal(verdictOf(by('Cache hit')), 'better'); // up + good:up
  assert.equal(verdictOf(by('Spend tokens')), 'flat'); // unchanged
  assert.equal(verdictOf(by('Rework')), 'flat'); // 0 -> 0

  // rework rising = worse; spend rising = neutral
  assert.equal(verdictOf({ label: 'Rework', prev: 0.1, now: 0.3, fmt: 'pct', good: 'down' }), 'worse');
  assert.equal(verdictOf({ label: 'Spend tokens', prev: 1000, now: 5000, fmt: 'tokens' }), 'neutral');
});

test('fmtTrendValue formats by kind', () => {
  assert.equal(fmtTrendValue({ label: '', prev: 0, now: 0, fmt: 'tokens' }, 1_234_000), '1.2M');
  assert.equal(fmtTrendValue({ label: '', prev: 0, now: 0, fmt: 'usd' }, 12.345), '$12.35');
  assert.equal(fmtTrendValue({ label: '', prev: 0, now: 0, fmt: 'pct' }, 0.123), '12.3%');
  assert.equal(fmtTrendValue({ label: '', prev: 0, now: 0, fmt: 'ratio' }, 1.234), '1.23');
  assert.equal(fmtTrendValue({ label: '', prev: 0, now: 0, fmt: 'int' }, 7), '7');
});

test('projectMovers ranks by absolute spend delta and includes vanished projects', () => {
  const current = [
    makeStored({ project: 'grew', input_tokens: 10_000, output_tokens: 0 }),
    makeStored({ project: 'steady', input_tokens: 1000, output_tokens: 0 }),
  ];
  const previous = [
    makeStored({ project: 'grew', input_tokens: 1000, output_tokens: 0 }),
    makeStored({ project: 'steady', input_tokens: 1000, output_tokens: 0 }),
    makeStored({ project: 'gone', input_tokens: 5000, output_tokens: 0 }),
  ];
  const movers = projectMovers(current, previous);
  assert.equal(movers[0].project, 'grew');
  assert.equal(movers[0].delta, 9000);
  assert.equal(movers[1].project, 'gone');
  assert.equal(movers[1].delta, -5000);
  assert.equal(movers[2].project, 'steady');
  assert.equal(movers[2].delta, 0);
});
