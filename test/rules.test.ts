import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULE_BY_KEY } from '../src/rules/index.js';
import { computeMetrics } from '../src/metrics.js';
import type { Metrics } from '../src/metrics.js';
import { structuredFindings } from '../src/followthrough.js';
import { mergeMetrics } from '../src/team.js';
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
    'search-loop',
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

// --- #88: search-loop. Runs of >= SEARCH_LOOP_MIN_RUN (10) consecutive
// exploration turns per main-loop session; savings price only the excess
// past the floor. ---------------------------------------------------------

/** One exploration turn on `session` at minute `m`, 2k in / 1k out. */
function exploreTurn(session: string, m: number, extra: Partial<StoredEvent> = {}): StoredEvent {
  return makeStored({
    session_id: session,
    ts: `2026-06-01T01:${String(m).padStart(2, '0')}:00.000Z`,
    activity: 'exploration',
    input_tokens: 2_000,
    output_tokens: 1_000,
    ...extra,
  });
}

test('search-loop: fires on an unbroken run and prices only the excess past the floor', () => {
  const events: StoredEvent[] = [];
  for (let i = 0; i < 14; i++) events.push(exploreTurn('lost', i));
  // A coding turn after the run ends it; a short second session stays quiet.
  events.push(makeStored({ session_id: 'lost', ts: '2026-06-01T01:14:00.000Z', input_tokens: 5_000, output_tokens: 4_000 }));
  for (let i = 20; i < 26; i++) events.push(exploreTurn('focused', i));

  const m = computeMetrics(events);
  assert.equal(m.searchLoopRuns, 1);
  assert.equal(m.searchLoopSessions, 1);
  assert.equal(m.searchLoopTurns, 14);
  assert.equal(m.searchLoopTokens, 14 * 3_000);
  assert.equal(m.searchLoopLongestRun, 14);
  // The first 10 turns of the run are legitimate research; only the last 4
  // are priced as excess.
  assert.equal(m.searchLoopExcessTokens, 4 * 3_000);

  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'search-loop');
  assert.ok(rec, 'search-loop should fire on a 14-turn unbroken explore');
  assert.match(rec!.message, /1 unbroken exploration run\(s\) of 10\+ read-only turns/);
  assert.match(rec!.message, /the longest 14 turns straight/);
  assert.ok((rec.savingsUsdPerMonth ?? 0) > 0, 'excess past the floor is priced');
  assert.equal(rec.evidence[0]?.label, '14-turn unbroken explore');
});

test('search-loop: stays quiet on interleaved work, subagent fan-outs, and tool-less sources', () => {
  const events: StoredEvent[] = [];
  // Two 6-turn digs separated by a coding turn: research, not a loop.
  for (let i = 0; i < 6; i++) events.push(exploreTurn('interleaved', i));
  events.push(makeStored({ session_id: 'interleaved', ts: '2026-06-01T01:06:00.000Z', activity: 'coding' }));
  for (let i = 7; i < 13; i++) events.push(exploreTurn('interleaved', i));
  // A pure sidechain burst: long unbroken reading is a subagent's JOB.
  for (let i = 20; i < 34; i++) {
    events.push(exploreTurn('fanout', i, { is_sidechain: 1, parent_session_id: 'main' }));
  }
  // Tool-less turns classify as conversation/thinking, never exploration:
  // sources without the signal report nothing rather than a false zero.
  for (let i = 40; i < 54; i++) {
    events.push(makeStored({ session_id: 'toolless', ts: `2026-06-01T02:${String(i - 40).padStart(2, '0')}:00.000Z`, activity: 'conversation' }));
  }

  const m = computeMetrics(events);
  assert.equal(m.searchLoopRuns, 0);
  assert.equal(m.searchLoopSessions, 0);
  assert.equal(structuredFindings(m).some((f) => f.key === 'search-loop'), false);

  // But a main loop that runs 12 straight exploration turns next to those
  // same sidechains still fires: the exclusion is about WHO loops, not where
  // the session happens to sit.
  for (let i = 45; i < 57; i++) events.push(exploreTurn('real-loop', i));
  const m2 = computeMetrics(events);
  assert.equal(m2.searchLoopRuns, 1);
  assert.ok(structuredFindings(m2).some((f) => f.key === 'search-loop'));
});

test('mergeMetrics recombines search-loop counts over pooled spend, legacy exports included', () => {
  const looper = computeMetrics(
    Array.from({ length: 13 }, (_, i) => exploreTurn('looper', i)),
  );
  const calm = computeMetrics([
    makeStored({ session_id: 'calm', input_tokens: 1_000, output_tokens: 500 }),
  ]);
  const merged = mergeMetrics([looper, calm]);
  assert.equal(merged.searchLoopRuns, 1);
  assert.equal(merged.searchLoopTokens, 13 * 3_000);
  assert.equal(merged.searchLoopExcessTokens, 3 * 3_000);
  assert.equal(merged.searchLoopLongestRun, Math.max(looper.searchLoopLongestRun, calm.searchLoopLongestRun));
  assert.equal(merged.searchLoopShare, (13 * 3_000) / (13 * 3_000 + 1_500));

  // Pre-search-loop exports carry none of these fields and merge as zeros.
  const legacy = { ...looper } as Partial<Metrics>;
  delete legacy.searchLoopRuns;
  delete legacy.searchLoopSessions;
  delete legacy.searchLoopTurns;
  delete legacy.searchLoopTokens;
  delete legacy.searchLoopShare;
  delete legacy.searchLoopLongestRun;
  delete legacy.searchLoopExcessTokens;
  const withLegacy = mergeMetrics([legacy as Metrics, calm]);
  assert.equal(withLegacy.searchLoopRuns, 0);
  assert.equal(withLegacy.searchLoopShare, 0);
});
