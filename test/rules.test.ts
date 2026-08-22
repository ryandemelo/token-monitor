import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULE_BY_KEY } from '../src/rules/index.js';
import { computeMetrics } from '../src/metrics.js';
import { structuredFindings } from '../src/followthrough.js';
import { enrichFindings, targetFor } from '../src/recommendations.js';
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
    'tool-result-bloat',
    'context-floor-creep',
    'abandoned-work',
    'error-cascade',
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
