import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULE_BY_KEY, RULE_BY_METRIC } from '../src/rules/index.js';
import { computeMetrics, MEGA_TURN_FLOOR_TOKENS } from '../src/metrics.js';
import type { Metrics } from '../src/metrics.js';
import { structuredFindings, METRIC_DIRECTION } from '../src/followthrough.js';
import { enrichFindings, targetFor } from '../src/recommendations.js';
import { mergeMetrics } from '../src/team.js';
import { TRACKABLE_METRICS } from '../src/analyze.js';
import { renderRules, renderRule } from '../src/report.js';
import { makeStored } from './helpers.js';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredEvent } from '../src/store.js';

test('registry: keys are unique, complete, and every rule keeps the contract', () => {
  assert.equal(RULE_BY_KEY.size, RULES.length, 'duplicate rule key');
  for (const r of RULES) {
    assert.ok(r.key && /^[a-z0-9-]+$/.test(r.key), `bad key: ${r.key}`);
    assert.ok(r.title.length > 0, `${r.key} has no title`);
    assert.ok(r.docs.length > 80, `${r.key} needs real docs — they are what \`rules <key>\` prints`);
    assert.ok(['up', 'down'].includes(r.direction));
    // A rule that prices savings must declare what it is priced against:
    // either a target (static or personalized) or tokens it can name directly.
    assert.equal(typeof r.fires, 'function');
  }
});

/**
 * A rule file that never reaches index.ts is dead code: it cannot fire, cannot
 * be listed, and the only symptom is an unrelated assertion failing somewhere
 * else. That happened to a contributor's first PR, so the suite now says it in
 * one line — and pins the filename-is-the-key convention while it is here.
 */
test('registry: every rule file is registered, and its filename is its key', () => {
  const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'rules');
  const files = readdirSync(rulesDir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'types.ts')
    .map((f) => f.replace(/\.ts$/, ''));
  assert.ok(files.length > 0, 'no rule files found — check the path');
  for (const key of files) {
    assert.ok(
      RULE_BY_KEY.has(key),
      `rule file src/rules/${key}.ts is not registered — add its import and its entry to src/rules/index.ts`,
    );
  }
  for (const rule of RULES) {
    assert.ok(files.includes(rule.key), `rule "${rule.key}" has no src/rules/${rule.key}.ts (filename must match the key)`);
  }
});

/**
 * The three facts that used to live in a shared line somewhere else: the
 * metric's direction (followthrough.ts), what a point of it is worth
 * (recommendations.ts) and the catalogue size (e2e). Each one was a merge
 * conflict for every contributor and a silent hole when someone missed it.
 */
test('registry: every rule owns its metric, its direction and its $/point', () => {
  const metrics = RULES.map((r) => r.metric);
  assert.equal(new Set(metrics).size, metrics.length, 'two rules share a metric — RULE_BY_METRIC would shadow one');

  for (const r of RULES) {
    assert.equal(METRIC_DIRECTION[r.metric], r.direction, `${r.key}: direction disagrees with METRIC_DIRECTION`);
    assert.equal(RULE_BY_METRIC.get(r.metric), r, `${r.key}: not reachable by its own metric`);
    assert.ok(
      'valuePerPoint' in r,
      `${r.key} must declare valuePerPoint — return undefined if the metric is not $-translatable, ` +
        'but declare it, or follow-through drops the $/point projection while the finding still prints savings',
    );
  }

  // Anything the LLM path can hand to recordLlmFindings must have a direction;
  // that lookup is unchecked at runtime.
  for (const k of TRACKABLE_METRICS) {
    assert.ok(METRIC_DIRECTION[k], `TRACKABLE_METRICS has ${k}, which has no direction`);
  }
  assert.equal(METRIC_DIRECTION.shippedShare, 'up', 'a metric no rule owns still needs its direction');
});

test('registry: a rule that declares no target still yields no target', () => {
  assert.equal(targetFor('low-think-code', []), undefined);
  assert.deepEqual(targetFor('low-cache-hit', []), { value: 0.8, personal: false });
  assert.equal(targetFor('not-a-rule', []), undefined);
});

/** The eight rules the tool shipped with, in firing order. Renaming a key breaks
 *  follow-through baselines in every existing database, so it is asserted here. */
test('registry: shipped rule keys and their order are stable', () => {
  assert.deepEqual(RULES.map((r) => r.key), [
    'low-cache-hit',
    'high-rework',
    'low-think-code',
    'premium-model-overuse',
    'context-bloat',
    'cold-restarts',
    'premium-misroute',
    'tool-retry-loops',
    'tool-result-bloat',
    'context-floor-creep',
    'abandoned-work',
    'error-cascade',
    'mega-turns',
    'untested-coding',
  ]);
});

function wastefulWindow(): StoredEvent[] {
  const out: StoredEvent[] = [];
  // 12 turns of premium exploration with no cache reads: low cache hit,
  // premium overuse + misroute, all on one session.
  for (let i = 0; i < 12; i++) {
    out.push(makeStored({
      session_id: 'burn',
      ts: `2026-06-0${1 + Math.floor(i / 6)}T0${i % 6}:00:00.000Z`,
      model: 'claude-opus-4-7',
      activity: 'exploration',
      input_tokens: 40_000,
      output_tokens: 2_000,
    }));
  }
  out.push(makeStored({ session_id: 'cheap', model: 'claude-haiku-4-5', activity: 'coding', input_tokens: 1_000 }));
  return out;
}

test('rules fire through the registry and reach enrichFindings with evidence', () => {
  const events = wastefulWindow();
  const m = computeMetrics(events);
  const keys = structuredFindings(m).map((f) => f.key);
  assert.ok(keys.includes('low-cache-hit'), 'low-cache-hit should fire');
  assert.ok(keys.includes('premium-misroute'), 'premium-misroute should fire');

  const enriched = enrichFindings(events, m, 30);
  const cache = enriched.find((r) => r.key === 'low-cache-hit')!;
  assert.ok(cache.savingsUsdPerMonth! > 0, 'priced rule produces savings');
  assert.equal(cache.evidence[0].sessionId, 'burn', 'score() picks the worst session');
  // low-think-code declares no savings function: advice-only rules stay unpriced.
  const think = enriched.find((r) => r.key === 'low-think-code');
  if (think) assert.equal(think.savingsUsdPerMonth, undefined);
});

test('cold-restarts contributes its extended-cache clause through Rule.clause', () => {
  // Two turns an hour apart on the 5-minute cache: the gap is recoverable by
  // the 1-hour tier, which is what the clause prices.
  const events: StoredEvent[] = [];
  for (let i = 0; i < 6; i++) {
    events.push(makeStored({
      session_id: 'gappy',
      ts: `2026-06-01T0${i}:00:00.000Z`,
      model: 'claude-opus-4-7',
      input_tokens: 200_000,
      cache_creation_tokens: 10_000,
      output_tokens: 1_000,
      activity: 'coding',
    }));
  }
  const m = computeMetrics(events);
  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'cold-restarts');
  assert.ok(rec, 'cold-restarts should fire on hourly gaps with 5-minute cache writes');
  assert.match(rec!.message, /1-hour cache would have covered/);
});

test('renderRules lists every rule; renderRule prints one rule with its firing state', () => {
  const m = computeMetrics(wastefulWindow());
  const listed = renderRules(m);
  for (const r of RULES) assert.ok(listed.includes(r.key), `${r.key} missing from the catalogue`);
  assert.match(listed, /firing on the current window/);

  const one = renderRule(RULE_BY_KEY.get('low-cache-hit')!, m);
  assert.match(one, /src\/rules\/low-cache-hit\.ts/);
  assert.match(one, /fires on the current window/);
  // With no metrics at all the catalogue still renders (never-collected machine).
  assert.ok(renderRules().includes('tool-retry-loops'));
});

test('error-cascade: flags runs of 3+ consecutive failed turns, prices only the excess', () => {
  const err = (over: Partial<StoredEvent> = {}) => makeStored({ is_error: 1, ...over });
  const events: StoredEvent[] = [
    // proj-a, session ca: 3 consecutive errors (300 tok each) then recovery.
    err({ session_id: 'ca', project: 'proj-a', input_tokens: 200, output_tokens: 100, ts: '2026-06-01T00:00:01.000Z' }),
    err({ session_id: 'ca', project: 'proj-a', input_tokens: 200, output_tokens: 100, ts: '2026-06-01T00:00:02.000Z' }),
    err({ session_id: 'ca', project: 'proj-a', input_tokens: 200, output_tokens: 100, ts: '2026-06-01T00:00:03.000Z' }),
    makeStored({ session_id: 'ca', project: 'proj-a', ts: '2026-06-01T00:00:04.000Z' }),
    // proj-b, session cb: 4 consecutive errors (100 tok each): excess = turns 3+4.
    err({ session_id: 'cb', project: 'proj-b', input_tokens: 100, ts: '2026-06-01T00:10:01.000Z' }),
    err({ session_id: 'cb', project: 'proj-b', input_tokens: 100, ts: '2026-06-01T00:10:02.000Z' }),
    err({ session_id: 'cb', project: 'proj-b', input_tokens: 100, ts: '2026-06-01T00:10:03.000Z' }),
    err({ session_id: 'cb', project: 'proj-b', input_tokens: 100, ts: '2026-06-01T00:10:04.000Z' }),
    // lone failures never cascade, and a success breaks a run in two.
    err({ session_id: 'ok', project: 'proj-a', ts: '2026-06-01T00:20:01.000Z' }),
    makeStored({ session_id: 'ok', project: 'proj-a', ts: '2026-06-01T00:20:02.000Z' }),
    err({ session_id: 'ok', project: 'proj-a', ts: '2026-06-01T00:20:03.000Z' }),
    err({ session_id: 'ok', project: 'proj-a', ts: '2026-06-01T00:20:04.000Z' }),
  ];
  const rule = RULE_BY_KEY.get('error-cascade')!;
  const m = computeMetrics(events);

  // Two qualifying runs (ca and cb); worst is cb's run of four.
  assert.equal(m.cascadeRuns, 2);
  assert.equal(m.longestCascadeRun, 4);
  assert.ok(Math.abs(m.cascadeShare - 1700 / m.spendTokens) < 1e-9);
  // Only spend past each run's second turn: 300 (ca) + 400 (cb) = 700.
  assert.equal(m.cascadeExcessTokens, 700);

  // Gate honesty: fires names real runs, and a clean window never claims one.
  const fired = rule.fires!(m);
  assert.match(fired ?? '', /2 error cascade/);
  assert.match(fired ?? '', /longest stretching to 4/);
  const clean = computeMetrics(events.filter((e) => e.session_id === 'ok'));
  assert.equal(clean.cascadeRuns, 0);
  assert.equal(rule.fires!(clean), undefined);

  // One bad afternoon is diagnosis, not a catalogue-worthy pattern.
  const singleRun = computeMetrics(events.filter((e) => e.session_id === 'cb'));
  assert.equal(singleRun.cascadeRuns, 1);
  assert.equal(rule.fires!(singleRun), undefined);

  // Two runs still stay quiet when they are too small a slice of window spend.
  const lowShareEvents = [
    ...events.filter((e) => e.session_id === 'ca' || e.session_id === 'cb'),
    ...Array.from({ length: 40 }, (_, i) =>
      makeStored({
        session_id: `quiet-${i}`,
        project: 'proj-c',
        input_tokens: 1000,
        output_tokens: 1000,
        ts: `2026-06-01T01:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      }),
    ),
  ];
  const lowShare = computeMetrics(lowShareEvents);
  assert.ok(lowShare.cascadeRuns >= 2);
  assert.ok(lowShare.cascadeShare < 0.05);
  assert.equal(rule.fires!(lowShare), undefined);

  // Savings price the excess at the blended spend rate.
  const rates = { input: 0, cacheRead: 0, spend: 1, premium: 0, cheap: 0, extendedWritePremium: 0, estimated: false };
  assert.equal(rule.savings!({ m, rates, sessions: [] }), 700);

  // Clause and evidence name where the cascades are.
  const clause = rule.clause!({ events, rates, monthly: 1 });
  assert.match(clause, /proj-a\/ca/);
  assert.match(clause, /proj-b\/cb/);
  const s = { sessionId: 'cb', project: 'proj-b', date: '2026-06-01', m: computeMetrics(events.filter((e) => e.session_id === 'cb')), events: [], isSidechain: false };
  const sc = rule.score!(s);
  assert.equal(sc.score, 800);
  assert.match(sc.label, /4-turn worst/);

  // It reaches the pipeline like any other finding.
  assert.ok(structuredFindings(m).some((f) => f.key === 'error-cascade'));
});

// --- #91: mega-turns. The bar is max(20k floor, 3x median output once there
// are enough turns); savings price only the excess above it. --------------

test('mega-turns: fires on a small-window runaway and prices only its excess', () => {
  const events = [
    makeStored({ session_id: 'calm', input_tokens: 1_000, output_tokens: 500 }),
    makeStored({
      session_id: 'burst', ts: '2026-06-01T01:00:00.000Z',
      input_tokens: 30_000, output_tokens: 21_000,
    }),
  ];
  const m = computeMetrics(events);
  assert.equal(m.megaTurns, 1);
  // A two-turn window has too little data for the adaptive half, so the
  // absolute floor does the work and prices only the part above itself.
  assert.equal(m.megaTurnThreshold, MEGA_TURN_FLOOR_TOKENS);
  assert.equal(m.megaTurnExcessTokens, 1_000);
  assert.ok(structuredFindings(m).some((f) => f.key === 'mega-turns'));
  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'mega-turns');
  assert.ok(rec, 'mega-turns should fire on a 21k-output turn');
  assert.match(rec!.message, /1 turn\(s\) emitted 20\.0k\+ output tokens/);
  // Excess-only savings price the 1k above the floor, never the whole turn.
  assert.ok((rec!.savingsUsdPerMonth ?? 0) > 0);
});

test('mega-turns: prices the excess above the bar in a large window and names the worst turn', () => {
  const events: StoredEvent[] = [];
  for (let i = 0; i < 10_000; i++) {
    events.push(makeStored({
      session_id: 'grind',
      ts: `2026-06-01T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor((i % 3600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      input_tokens: 2_000, output_tokens: 100,
    }));
  }
  for (let i = 0; i < 3; i++) {
    events.push(makeStored({
      session_id: `burst${i}`, ts: `2026-06-0${i + 2}T05:00:00.000Z`,
      input_tokens: 40_000, output_tokens: 30_000,
    }));
  }
  const m = computeMetrics(events);
  // Three clear outliers in a mostly quiet window stay governed by the
  // absolute floor; the median is intentionally resistant to this few spikes.
  assert.equal(m.megaTurnThreshold, MEGA_TURN_FLOOR_TOKENS);
  assert.equal(m.megaTurns, 3);
  assert.equal(m.largestTurnOutput, 30_000);
  assert.equal(m.megaTurnExcessTokens, 3 * 10_000);
  assert.equal(m.megaTurnTokens, 3 * 70_000);
  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'mega-turns')!;
  assert.ok(rec, 'mega-turns should fire');
  assert.ok((rec.savingsUsdPerMonth ?? 0) > 0, 'excess above the bar is priced');
  assert.equal(rec.evidence[0]?.label, '30.0k tok single turn');
  assert.ok(rec.evidence.every((e) => e.sessionId.startsWith('burst')), 'evidence ranks the mega sessions first');
});

test('mega-turns: stays quiet on ordinary windows, escalates the bar for heavy writers', () => {
  const calm = [
    makeStored({ output_tokens: 800 }),
    makeStored({ ts: '2026-06-01T00:01:00.000Z', output_tokens: 1_200 }),
  ];
  const mCalm = computeMetrics(calm);
  assert.equal(mCalm.megaTurns, 0);
  assert.equal(structuredFindings(mCalm).some((f) => f.key === 'mega-turns'), false);

  // A user whose every turn legitimately writes 25k sets their own bar: the
  // median-based outlier test rises past the floor, so nothing fires.
  const heavy = Array.from({ length: 400 }, (_, i) =>
    makeStored({ ts: `2026-06-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`, output_tokens: 25_000 }));
  const mHeavy = computeMetrics(heavy);
  assert.equal(mHeavy.megaTurnThreshold, 75_000);
  assert.equal(mHeavy.megaTurns, 0);
  assert.equal(mHeavy.megaTurnExcessTokens, 0);
  assert.equal(structuredFindings(mHeavy).some((f) => f.key === 'mega-turns'), false);

  // A genuine outlier clears that stable center without accusing routine work.
  const mixed = [
    ...heavy,
    makeStored({
      session_id: 'runaway',
      input_tokens: 10_000,
      output_tokens: 90_000,
    }),
  ];
  const mMixed = computeMetrics(mixed);
  assert.equal(mMixed.megaTurns, 1);
  assert.equal(mMixed.megaTurnThreshold, 75_000);
  assert.equal(mMixed.megaTurnExcessTokens, 15_000);
});

test('mergeMetrics recombines mega-turn counts over pooled spend, legacy exports included', () => {
  const burst = computeMetrics([
    makeStored({ session_id: 'burst', input_tokens: 40_000, output_tokens: 30_000 }),
  ]);
  const grind = computeMetrics([
    makeStored({ session_id: 'grind', input_tokens: 2_000, output_tokens: 100 }),
    makeStored({ ts: '2026-06-01T00:01:00.000Z', session_id: 'grind', input_tokens: 2_000, output_tokens: 100 }),
  ]);
  const merged = mergeMetrics([burst, grind]);
  assert.equal(merged.megaTurns, 1);
  assert.equal(merged.megaTurnTokens, 70_000);
  assert.equal(merged.megaTurnShare, 70_000 / (70_000 + 4_200));
  assert.equal(merged.megaTurnThreshold, Math.max(burst.megaTurnThreshold, grind.megaTurnThreshold));
  // Pre-0.15 exports carry none of these fields and must merge as zeros.
  const legacy = { ...burst } as Partial<Metrics>;
  delete legacy.megaTurns; delete legacy.megaTurnTokens; delete legacy.megaTurnShare;
  delete legacy.largestTurnOutput; delete legacy.megaTurnExcessTokens; delete legacy.megaTurnThreshold;
  const withLegacy = mergeMetrics([legacy as Metrics, grind]);
  assert.equal(withLegacy.megaTurns, 0);
  assert.equal(withLegacy.megaTurnShare, 0);
});

test('untested-coding: flags coding-heavy projects with no test turns, skips tested ones', () => {
  const events: StoredEvent[] = [
    // proj-a: 300k coding tokens across sessions, zero testing → offender
    makeStored({ session_id: 'a1', project: 'proj-a', activity: 'coding', input_tokens: 150_000 }),
    makeStored({ session_id: 'a2', project: 'proj-a', activity: 'coding', input_tokens: 150_000 }),
    // proj-b: heavy coding but real testing turns → clean
    makeStored({ session_id: 'b1', project: 'proj-b', activity: 'coding', input_tokens: 200_000 }),
    makeStored({ session_id: 'b2', project: 'proj-b', activity: 'testing', input_tokens: 30_000 }),
    // proj-c: tiny project under the floor → not judged
    makeStored({ session_id: 'c1', project: 'proj-c', activity: 'coding', input_tokens: 5_000 }),
  ];
  const rule = RULE_BY_KEY.get('untested-coding')!;

  const clause = rule.clause!({ events, rates: {
    input: 0, cacheRead: 0, spend: 0, premium: 0, cheap: 0, extendedWritePremium: 0, estimated: false,
  }, monthly: 1 });
  assert.match(clause, /proj-a/);
  assert.doesNotMatch(clause, /proj-b/);
  assert.doesNotMatch(clause, /proj-c/);

  // evidence scoring: proj-a's sessions score, a project with testing turns does not
  const evsA = events.filter((e) => e.project === 'proj-a');
  const s = { sessionId: 'a1', project: 'proj-a', date: '2026-06-01', m: computeMetrics(evsA), events: evsA, isSidechain: false };
  assert.ok(rule.score!(s).score > 0);

  // Evidence mirrors the detector: a session inside an offender project still
  // scores even when that one session has no testing, and the label reflects
  // the small tested share rather than claiming "no test turns."
  const nearCeiling = [
    makeStored({ session_id: 'd1', project: 'proj-d', activity: 'coding', input_tokens: 200_000 }),
    makeStored({ session_id: 'd2', project: 'proj-d', activity: 'testing', input_tokens: 3_000 }),
  ];
  const sNear = {
    sessionId: 'd1',
    project: 'proj-d',
    date: '2026-06-01',
    m: computeMetrics(nearCeiling),
    events: nearCeiling,
    isSidechain: false,
  };
  const scored = rule.score!(sNear);
  assert.ok(scored.score > 0);
  assert.match(scored.label, /2% tests/);

  // gate honesty: fires reads the per-project count off Metrics, so a window
  // whose overall testing share is dragged up by other projects still names
  // its untested one, and a window with none never claims one
  const m = computeMetrics(events);
  assert.ok(m.untestedCodingProjects >= 1);
  assert.match(rule.fires!(m) ?? '', /no test turns/);
  const clean = computeMetrics(events.filter((e) => e.project !== 'proj-a'));
  assert.equal(clean.untestedCodingProjects, 0);
  assert.equal(rule.fires!(clean), undefined);
});
