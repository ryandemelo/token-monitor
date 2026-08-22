import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULE_BY_KEY } from '../src/rules/index.js';
import { computeMetrics } from '../src/metrics.js';
import { structuredFindings } from '../src/followthrough.js';
import { enrichFindings, targetFor } from '../src/recommendations.js';
import { renderRules, renderRule } from '../src/report.js';
import { makeStored } from './helpers.js';
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
    'abandoned-on-error',
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

test('abandoned-on-error: idle+error guard via abandonedSessions, evidence via score', async () => {
  const { abandonedSessions } = await import('../src/rules/abandoned-on-error.js');
  const day = (n: number) => `2026-06-${String(n).padStart(2, '0')}T12:00:00.000Z`;
  const events: StoredEvent[] = [
    makeStored({ session_id: 'dead', ts: day(1), input_tokens: 50_000 }),
    makeStored({ session_id: 'dead', ts: day(2), input_tokens: 20_000 }),
    makeStored({ session_id: 'dead', ts: day(6), input_tokens: 30_000, is_error: 1 }),
    makeStored({ session_id: 'fresh-err', ts: day(11), input_tokens: 90_000, is_error: 1 }),
    makeStored({ session_id: 'recovered', ts: day(5), input_tokens: 10_000, is_error: 1 }),
    makeStored({ session_id: 'recovered', ts: day(6), input_tokens: 10_000 }),
    makeStored({ session_id: 'sidecar', ts: day(4), input_tokens: 70_000, is_error: 1, is_sidechain: 1 }),
  ];
  // window edge is day(11); anchor passed explicitly so the fixture is deterministic
  const now = Date.parse(day(11));
  const abandoned = abandonedSessions(events, now);
  assert.deepEqual(abandoned.map((a) => a.sessionId), ['dead'], 'only the idle failed main-loop session counts');
  assert.equal(abandoned[0].idleDays, 5);

  const rule = RULE_BY_KEY.get('abandoned-on-error')!;
  const deadEvents = events.filter((e) => e.session_id === 'dead');
  const s = { sessionId: 'dead', project: 'proj', date: '2026-06-01', m: computeMetrics(deadEvents), events: deadEvents, isSidechain: false };
  const scored = rule.score!(s);
  assert.ok(scored.score > 0);
  assert.match(scored.label, /last turn errored/);
});
