import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store.js';
import { computeMetrics } from '../src/metrics.js';
import { syncFindings, structuredFindings, premiumShare, recordLlmFindings } from '../src/followthrough.js';
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

test('context-bloat finding needs ≥3 measurable sessions and ≥30% bloated', () => {
  const bloated = (id: string) =>
    Array.from({ length: 8 }, (_, i) =>
      makeStored({
        session_id: id,
        ts: `2026-06-01T00:0${i}:00Z`,
        input_tokens: i < 4 ? 100 : 5000,
        output_tokens: 0,
      }),
    );
  const m = computeMetrics([...bloated('a'), ...bloated('b'), ...bloated('c')]);
  assert.ok(structuredFindings(m).some((f) => f.key === 'context-bloat'));

  // only one measurable session -> too thin to conclude
  const thin = computeMetrics(bloated('a'));
  assert.ok(!structuredFindings(thin).some((f) => f.key === 'context-bloat'));
});

test('cold-restarts finding fires on TTL-gap re-payment share', () => {
  const m = computeMetrics([
    makeStored({ ts: '2026-06-01T00:00:00Z', input_tokens: 50_000, output_tokens: 0 }),
    makeStored({ ts: '2026-06-01T00:20:00Z', input_tokens: 150_000, output_tokens: 0 }),
  ]);
  assert.ok(structuredFindings(m).some((f) => f.key === 'cold-restarts'));

  const warm = computeMetrics([
    makeStored({ ts: '2026-06-01T00:00:00Z', input_tokens: 50_000, output_tokens: 0 }),
    makeStored({ ts: '2026-06-01T00:01:00Z', input_tokens: 150_000, output_tokens: 0 }),
  ]);
  assert.ok(!structuredFindings(warm).some((f) => f.key === 'cold-restarts'));
});

test('premium-misroute finding fires when premium tokens go to exploration/chat', () => {
  const m = computeMetrics([
    makeStored({ model: 'claude-opus-4-7', activity: 'exploration', input_tokens: 80_000, output_tokens: 0 }),
    makeStored({ model: 'claude-opus-4-7', activity: 'coding', input_tokens: 40_000, output_tokens: 0 }),
  ]);
  assert.ok(structuredFindings(m).some((f) => f.key === 'premium-misroute'));

  const codingHeavy = computeMetrics([
    makeStored({ model: 'claude-opus-4-7', activity: 'coding', input_tokens: 120_000, output_tokens: 0 }),
  ]);
  assert.ok(!structuredFindings(codingHeavy).some((f) => f.key === 'premium-misroute'));
});

test('tool-retry-loops finding fires when retry spend passes 5%', () => {
  const m = computeMetrics([
    makeStored({ ts: '2026-06-01T00:00:01Z', tools: '["Bash"]', is_error: 1, input_tokens: 1000, output_tokens: 0 }),
    makeStored({ ts: '2026-06-01T00:00:02Z', tools: '["Bash"]', input_tokens: 1000, output_tokens: 0 }),
  ]);
  assert.ok(structuredFindings(m).some((f) => f.key === 'tool-retry-loops'));

  const clean = computeMetrics([
    makeStored({ tools: '["Bash"]', input_tokens: 1000, output_tokens: 0 }),
  ]);
  assert.ok(!structuredFindings(clean).some((f) => f.key === 'tool-retry-loops'));
});

test('premiumShare measures premium-model token share', () => {
  const m = computeMetrics([
    makeStored({ model: 'claude-opus-4-7', input_tokens: 900, output_tokens: 0 }),
    makeStored({ model: 'claude-haiku-4-5', input_tokens: 100, output_tokens: 0 }),
  ]);
  assert.ok(Math.abs(premiumShare(m) - 0.9) < 1e-9);
});

test('recordLlmFindings stores advice keyed by metric, baselined to current, canonical direction', () => {
  const db = openDb(':memory:');
  const rows = recordLlmFindings(db, [
    { metric: 'cacheHitRatio', title: 'Reuse the system prompt', rationale: 'cache 0%' },
    { metric: 'reworkRatio', title: 'Plan before coding', rationale: '' },
  ], badCache(), '2026-06-01T00:00:00.000Z');
  const cache = rows.find((r) => r.key === 'llm:cacheHitRatio')!;
  assert.ok(cache);
  assert.equal(cache.origin, 'llm');
  assert.equal(cache.direction, 'up'); // canonical, not whatever the model said
  assert.equal(cache.baseline, 0); // current metric value at record time
  assert.equal(cache.status, 'new');
  assert.ok(rows.some((r) => r.key === 'llm:reworkRatio'));
});

test('recordLlmFindings keeps the original baseline across reruns; one row per metric', () => {
  const db = openDb(':memory:');
  recordLlmFindings(db, [{ metric: 'cacheHitRatio', title: 'first', rationale: '' }], badCache(), '2026-06-01T00:00:00.000Z');
  const rows = recordLlmFindings(db, [
    { metric: 'cacheHitRatio', title: 'reworded later', rationale: 'x' },
  ], goodCache(), '2026-06-08T00:00:00.000Z');
  const cache = rows.filter((r) => r.key === 'llm:cacheHitRatio');
  assert.equal(cache.length, 1); // INSERT OR IGNORE: no duplicate metric row
  assert.equal(cache[0].baseline, 0); // baseline from the FIRST recording
  assert.ok(cache[0].current > 0.9); // re-measured against the new window
  assert.equal(cache[0].status, 'improving'); // the advice moved the metric up
});

test('LLM-tracked findings never auto-resolve when a rule finding clears', () => {
  const db = openDb(':memory:');
  recordLlmFindings(db, [{ metric: 'cacheHitRatio', title: 'x', rationale: '' }], badCache(), '2026-06-01T00:00:00.000Z');
  // A later unfiltered report on good cache: the rule low-cache-hit resolves,
  // but the LLM row has no firing condition so it keeps tracking.
  const rows = syncFindings(db, goodCache(), '2026-06-08T00:00:00.000Z');
  assert.equal(rows.find((r) => r.key === 'low-cache-hit')?.status, 'resolved');
  const llm = rows.find((r) => r.key === 'llm:cacheHitRatio')!;
  assert.notEqual(llm.status, 'resolved');
  assert.equal(llm.origin, 'llm');
});

test('recordLlmFindings returns only this run\'s metrics, not the whole history', () => {
  const db = openDb(':memory:');
  recordLlmFindings(db, [{ metric: 'cacheHitRatio', title: 'a', rationale: '' }], badCache(), '2026-06-01T00:00:00.000Z');
  const second = recordLlmFindings(db, [{ metric: 'reworkRatio', title: 'b', rationale: '' }], badCache(), '2026-06-08T00:00:00.000Z');
  assert.deepEqual(second.map((r) => r.key), ['llm:reworkRatio']); // not cacheHitRatio from run 1
});

test('an LLM-tracked finding flips to regressing when its (canonical-direction) metric worsens', () => {
  const db = openDb(':memory:');
  // Baseline: zero rework (good). The model claims nothing about direction.
  const lowRework = computeMetrics([makeStored({ activity: 'coding', input_tokens: 100_000, output_tokens: 0 })]);
  recordLlmFindings(db, [{ metric: 'reworkRatio', title: 'Keep planning first', rationale: '' }], lowRework, '2026-06-01T00:00:00.000Z');
  // Later: a failure then heavy coding pushes rework up — the metric got worse.
  const highRework = computeMetrics([
    makeStored({ session_id: 'r', ts: '2026-06-02T00:00:00Z', activity: 'coding', is_error: 1, input_tokens: 1_000, output_tokens: 0 }),
    makeStored({ session_id: 'r', ts: '2026-06-02T00:01:00Z', activity: 'coding', input_tokens: 100_000, output_tokens: 0 }),
  ]);
  const llm = syncFindings(db, highRework, '2026-06-08T00:00:00.000Z').find((r) => r.key === 'llm:reworkRatio')!;
  assert.equal(llm.direction, 'down'); // canonical, from METRIC_DIRECTION
  assert.equal(llm.status, 'regressing');
});

test('ensureFollowTable migrates a pre-origin recommendations table', () => {
  const db = openDb(':memory:');
  // An older db: recommendations table without the origin column.
  db.exec(`CREATE TABLE recommendations (
    key TEXT PRIMARY KEY, metric TEXT NOT NULL, direction TEXT NOT NULL, message TEXT NOT NULL,
    baseline REAL NOT NULL, created_at TEXT NOT NULL, last_value REAL, last_checked TEXT, resolved_at TEXT
  )`);
  db.prepare(`INSERT INTO recommendations (key, metric, direction, message, baseline, created_at)
    VALUES ('low-cache-hit', 'cacheHitRatio', 'up', 'm', 0, '2026-06-01')`).run();
  const rows = syncFindings(db, badCache(), '2026-06-02T00:00:00.000Z');
  assert.equal(rows.find((r) => r.key === 'low-cache-hit')?.origin, 'rule'); // defaulted on migration
});
