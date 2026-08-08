import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, contextGrowthOf, extendedCacheOpportunity } from '../src/metrics.js';
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

// ---- subagent accounting (#63) ----------------------------------------------

test('subagent turns count as spend but not as extra sessions', () => {
  const m = computeMetrics([
    makeStored({ session_id: 's1', input_tokens: 400, output_tokens: 100 }),
    makeStored({ session_id: 'a1', parent_session_id: 's1', is_sidechain: 1, input_tokens: 60, output_tokens: 40 }),
    makeStored({ session_id: 'a2', parent_session_id: 's1', is_sidechain: 1, input_tokens: 60, output_tokens: 40 }),
    makeStored({ session_id: 'a2', parent_session_id: 's1', is_sidechain: 1, input_tokens: 30, output_tokens: 70 }),
  ]);
  assert.equal(m.sessions, 1); // one conversation, not four
  assert.equal(m.subagentSessions, 2); // ...that fanned out into two runs
  assert.equal(m.spendTokens, 800);
  assert.equal(m.subagentSpendTokens, 300);
  assert.equal(m.subagentShare, 0.375);
});

test('a window with no fan-out reports a zero subagent share, not NaN', () => {
  const m = computeMetrics([makeStored({ session_id: 's1' })]);
  assert.equal(m.subagentSessions, 0);
  assert.equal(m.subagentShare, 0);
  assert.equal(computeMetrics([]).subagentShare, 0);
});

test('per-session hygiene math stays per-transcript, not per root session', () => {
  // Two conversations interleaved in time. Grouped per transcript each shows
  // one gap; merged on a single timeline they would show three.
  const m = computeMetrics([
    makeStored({ session_id: 's1', ts: '2026-06-01T10:00:00Z' }),
    makeStored({ session_id: 's2', ts: '2026-06-01T10:20:00Z' }),
    makeStored({ session_id: 's1', ts: '2026-06-01T10:40:00Z' }),
    makeStored({ session_id: 's2', ts: '2026-06-01T11:00:00Z' }),
  ]);
  assert.equal(m.coldRestartTurns, 2);
});

test('cold restarts exclude subagent runs on BOTH sides of the ratio', () => {
  const human = [
    makeStored({ session_id: 's1', ts: '2026-06-01T10:00:00Z', input_tokens: 100, cache_creation_tokens: 0 }),
    makeStored({ session_id: 's1', ts: '2026-06-01T11:00:00Z', input_tokens: 300, cache_creation_tokens: 0 }),
  ];
  const alone = computeMetrics(human);
  assert.equal(alone.coldRestartTurns, 1);
  assert.equal(alone.coldRestartTokens, 300);
  assert.equal(alone.coldRestartShare, 0.75); // 300 re-paid of 400 fresh-paid

  // A fan-out carrying far more fresh input must not move it, and its OWN
  // gaps must not enter the numerator either — each run below has a 1-hour
  // gap between its two turns, which would count as a cold restart if the
  // numerator guard were dropped.
  const withFanOut = computeMetrics([
    ...human,
    ...Array.from({ length: 10 }, (_, i) => [
      makeStored({
        session_id: `a${i}`, parent_session_id: 's1', is_sidechain: 1,
        ts: `2026-06-01T12:0${i}:00Z`, input_tokens: 1000, cache_creation_tokens: 0,
      }),
      makeStored({
        session_id: `a${i}`, parent_session_id: 's1', is_sidechain: 1,
        ts: `2026-06-01T13:0${i}:00Z`, input_tokens: 1000, cache_creation_tokens: 0,
      }),
    ]).flat(),
  ]);
  assert.equal(withFanOut.coldRestartTurns, 1);
  assert.equal(withFanOut.coldRestartShare, 0.75);
  assert.equal(withFanOut.coldRestartBaseTokens, 400);
});

test('subagent runs are excluded from the context-bloat denominator', () => {
  const growing = (session: string, sidechain: boolean) =>
    Array.from({ length: 8 }, (_, i) =>
      makeStored({
        session_id: session,
        is_sidechain: sidechain ? 1 : 0,
        parent_session_id: sidechain ? 'p' : null,
        ts: `2026-06-01T10:0${i}:00Z`,
        input_tokens: 1000 * (i + 1),
        cache_read_tokens: 0,
      }),
    );
  const m = computeMetrics([...growing('human', false), ...growing('a1', true), ...growing('a2', true)]);
  // One conversation is measurable for bloat; the two agent runs are not
  // sessions anyone can compact, so they never dilute the ratio.
  assert.equal(m.trendSessions, 1);
  assert.equal(m.bloatedSessions, 1);
  assert.equal(m.contextBloatShare, 1);
});

// ---- cache-TTL-aware cold restarts (#64) -------------------------------------

/** A session of `n` turns spaced `gapMin` apart, writing cache at the given tier. */
const ttlSession = (id: string, gapMin: number, tier: '5m' | '1h', n = 4) =>
  Array.from({ length: n }, (_, i) =>
    makeStored({
      session_id: id,
      ts: new Date(Date.parse('2026-06-01T10:00:00Z') + i * gapMin * 60_000).toISOString(),
      input_tokens: 1000,
      cache_creation_tokens: 4000,
      cache_creation_1h_tokens: tier === '1h' ? 4000 : 0,
      output_tokens: 0,
    }),
  );

test('a 1h-cache session is not charged cold restarts for sub-hour gaps', () => {
  const warm = computeMetrics(ttlSession('s1', 20, '1h'));
  assert.equal(warm.coldRestartTurns, 0, '20-min gaps are cache hits on the 1h tier');
  assert.equal(warm.coldRestartShare, 0);
  assert.equal(warm.extendedCacheSessions, 1);
  assert.equal(warm.extendedCacheShare, 1);

  // Identical session, 5-minute writes: every gap is a real re-pay.
  const cold = computeMetrics(ttlSession('s1', 20, '5m'));
  assert.equal(cold.coldRestartTurns, 3);
  assert.equal(cold.extendedCacheSessions, 0);
  assert.equal(cold.extendedCacheShare, 0);
});

test('gaps past the extended TTL still count on a 1h-cache session', () => {
  // 90 minutes is past even the extended window — genuinely re-paid.
  const m = computeMetrics(ttlSession('s1', 90, '1h'));
  assert.equal(m.coldRestartTurns, 3);
});

test('the 1h/5m decision is per session and turns on half the write tokens', () => {
  const mixed = (id: string, oneHour: number) =>
    Array.from({ length: 3 }, (_, i) =>
      makeStored({
        session_id: id,
        ts: new Date(Date.parse('2026-06-01T10:00:00Z') + i * 20 * 60_000).toISOString(),
        input_tokens: 1000,
        cache_creation_tokens: 1000,
        cache_creation_1h_tokens: oneHour,
        output_tokens: 0,
      }),
    );
  assert.equal(computeMetrics(mixed('a', 500)).coldRestartTurns, 0, 'exactly half counts as extended');
  assert.equal(computeMetrics(mixed('b', 499)).coldRestartTurns, 2, 'just under half stays on 5 min');

  // One 1h session next to one 5m session: each is judged on its own writes.
  const both = computeMetrics([...ttlSession('warm', 20, '1h'), ...ttlSession('cold', 20, '5m')]);
  assert.equal(both.coldRestartTurns, 3);
  assert.equal(both.extendedCacheSessions, 1);
});

test('rows with no TTL split keep the 5-minute assumption exactly', () => {
  // Pre-0.12 rows and every non-Claude-Code source report 0 here; their
  // numbers must not move at all.
  const legacy = ttlSession('s1', 20, '5m').map((e) => ({ ...e, cache_creation_1h_tokens: 0 }));
  assert.equal(computeMetrics(legacy).coldRestartTurns, 3);
  assert.equal(computeMetrics(legacy).extendedCacheShare, 0);
});

test('extendedCacheOpportunity counts only gaps the 1h cache would have covered', () => {
  const s = [
    ...ttlSession('recoverable', 20, '5m', 3), // 2 gaps inside the 1h window
    ...ttlSession('too-long', 90, '5m', 3), // past the extended TTL — not recoverable
    ...ttlSession('already-extended', 20, '1h', 3), // has the feature already
  ];
  const opp = extendedCacheOpportunity(s);
  assert.equal(opp.sessions, 1, 'only the in-window session benefits');
  assert.equal(opp.recoverableTokens, 2 * 5000); // 2 gaps x (1000 input + 4000 write)
  // Both 5-minute sessions pay the premium once the tier is switched on; the
  // one already on the extended tier does not.
  assert.equal(opp.writeTokens, 2 * (3 * 4000));
});

test('the extended-cache premium is charged to every 5m session, not just the ones it helps', () => {
  // Enabling the 1-hour cache is a setting, not a per-session choice: a 5m
  // session with no recoverable gap still starts paying the higher write
  // premium, so quoting a net saving without it is a number the user can't get.
  const withGap = ttlSession('a', 20, '5m', 3);
  const gapFree = Array.from({ length: 10 }, (_, i) =>
    makeStored({ session_id: 'b', ts: new Date(Date.parse('2026-06-01T10:00:00Z') + i * 60_000).toISOString(),
      input_tokens: 1000, cache_creation_tokens: 4000, output_tokens: 0 }),
  );
  const alone = extendedCacheOpportunity(withGap);
  const both = extendedCacheOpportunity([...withGap, ...gapFree]);
  assert.equal(both.recoverableTokens, alone.recoverableTokens, 'gap-free session recovers nothing');
  assert.equal(both.sessions, alone.sessions, '...and is not counted as a beneficiary');
  assert.equal(both.writeTokens, alone.writeTokens + 10 * 4000, 'but its writes DO pay the premium');

  // A session already on the extended tier is unaffected either way.
  const withExtended = extendedCacheOpportunity([...withGap, ...ttlSession('c', 20, '1h', 5)]);
  assert.equal(withExtended.writeTokens, alone.writeTokens);
});
