import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULE_BY_KEY } from '../src/rules/index.js';
import { computeMetrics, MEGA_TURN_FLOOR_TOKENS } from '../src/metrics.js';
import type { Metrics } from '../src/metrics.js';
import { structuredFindings } from '../src/followthrough.js';
import { enrichFindings, targetFor } from '../src/recommendations.js';
import { mergeMetrics } from '../src/team.js';
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
    'mega-turns',
    'tool-result-bloat',
    'context-floor-creep',
    'abandoned-work',
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

// --- #91: mega-turns. The bar is max(20k floor, p99.9 of the window's own
// turns); savings price only the excess above it. -------------------------

test('mega-turns: fires on a single runaway turn, and prices nothing it cannot defend', () => {
  const events = [
    makeStored({ session_id: 'calm', input_tokens: 1_000, output_tokens: 500 }),
    makeStored({
      session_id: 'burst', ts: '2026-06-01T01:00:00.000Z',
      input_tokens: 30_000, output_tokens: 21_000,
    }),
  ];
  const m = computeMetrics(events);
  assert.equal(m.megaTurns, 1);
  // A two-turn window has no tail to speak of: p99.9 IS the largest turn, so
  // the bar lands exactly on it and there is nothing above it to price.
  assert.equal(m.megaTurnThreshold, 21_000);
  assert.equal(m.megaTurnExcessTokens, 0);
  assert.ok(structuredFindings(m).some((f) => f.key === 'mega-turns'));
  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'mega-turns');
  assert.ok(rec, 'mega-turns should fire on a 21k-output turn');
  assert.match(rec!.message, /1 turn\(s\) emitted 21\.0k\+ output tokens/);
  // Excess-only savings: with nothing above the bar, the rec stays unpriced
  // rather than inventing a number.
  assert.equal(rec!.savingsUsdPerMonth, undefined);
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
  // Three outliers in 10_003 turns sit below the 99.9th percentile, so the
  // bar is the absolute floor, not the outliers themselves.
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
  // percentile escalates past the floor, so nothing is flagged as excess.
  const heavy = Array.from({ length: 400 }, (_, i) =>
    makeStored({ ts: `2026-06-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`, output_tokens: 25_000 }));
  const mHeavy = computeMetrics(heavy);
  assert.equal(mHeavy.megaTurnThreshold, 25_000);
  assert.equal(mHeavy.megaTurns, 400);
  assert.equal(mHeavy.megaTurnExcessTokens, 0);
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
