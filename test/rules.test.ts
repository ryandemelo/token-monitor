import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, RULE_BY_KEY } from '../src/rules/index.js';
import { computeMetrics, READ_FREE_CALLS } from '../src/metrics.js';
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
    'redundant-reads',
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

// --- #89: redundant-reads. Exploration turns invoking a read-class tool past
// READ_FREE_CALLS (3) uses of that tool in one main-loop session; the whole
// turn's spend is priced, and the signal is a proxy (names, not arguments). ---

/** One exploration turn running `tool` on `session` at minute `m`, 2k in / 1k out. */
function readTurn(session: string, m: number, extra: Partial<StoredEvent> = {}): StoredEvent {
  return makeStored({
    session_id: session,
    ts: `2026-06-01T03:${String(m % 60).padStart(2, '0')}:00.000Z`,
    activity: 'exploration',
    tools: '["read"]',
    input_tokens: 2_000,
    output_tokens: 1_000,
    ...extra,
  });
}

function codingTurn(session: string, m: number): StoredEvent {
  return makeStored({
    session_id: session,
    ts: `2026-06-01T03:${String(m % 60).padStart(2, '0')}:30.000Z`,
    activity: 'coding',
    tools: '["edit"]',
  });
}

test('redundant-reads: fires past the per-tool allowance and prices the carrying turns', () => {
  const events: StoredEvent[] = [];
  // Nine reads of the same tool interleaved with coding turns: the first 3
  // are free research, the next 6 are repeats. The interleaving also keeps
  // search-loop's unbroken-run shape out of the window.
  for (let i = 0; i < 9; i++) {
    events.push(readTurn('rereader', i * 2));
    events.push(codingTurn('rereader', i * 2 + 1));
  }

  const m = computeMetrics(events);
  assert.equal(m.redundantReadCalls, 9 - READ_FREE_CALLS);
  assert.equal(m.redundantReadTurns, 6);
  assert.equal(m.redundantReadTokens, 6 * 3_000);
  assert.equal(m.redundantReadSessions, 1);
  assert.equal(m.redundantReadShare, (6 * 3_000) / (9 * 3_000 + 9 * 200));

  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'redundant-reads');
  assert.ok(rec, 'should fire at 6 repeat calls and a majority share');
  assert.match(rec!.message, /6 repeat call\(s\) across 1 session\(s\)/);
  assert.match(rec!.message, /arguments are not stored/, 'the proxy caveat is in the message itself');
  assert.ok((rec.savingsUsdPerMonth ?? 0) > 0, 'repeat turns are priced');
  assert.equal(rec.evidence[0]?.label, '6 repeat read call(s)');

  // Independence from search-loop: same window, no unbroken run anywhere.
  assert.equal(structuredFindings(m).some((f) => f.key === 'search-loop'), false);
});

test('redundant-reads: stays quiet under the allowance, on broad reading, and on subagents', () => {
  const events: StoredEvent[] = [];
  // Exactly the free allowance of two different tools: nothing to flag yet.
  ['read', 'grep', 'read', 'grep', 'read', 'grep'].forEach((t, i) => {
    events.push(readTurn('edge', i * 2, { tools: JSON.stringify([t]) }));
    events.push(codingTurn('edge', i * 2 + 1));
  });
  // Broad reading: eight DIFFERENT read-class tools once each. Ten different
  // files through eight tools look like work here, because names are all the
  // transcript keeps, so this must stay silent.
  const broad = ['webfetch', 'websearch', 'codebase_search', 'view', 'ls', 'glob', 'task', 'explore'];
  broad.forEach((t, i) => {
    events.push(readTurn('broad', 20 + i * 2, { tools: JSON.stringify([t]) }));
    events.push(codingTurn('broad', 20 + i * 2 + 1));
  });
  // A pure sidechain burst re-running Read over and over: heavy unbroken
  // reading is a subagent's job (see search-loop), never flagged here.
  for (let i = 40; i < 55; i++) {
    events.push(readTurn('fanout', i, { is_sidechain: 1, parent_session_id: 'main' }));
  }

  const m = computeMetrics(events);
  assert.equal(m.redundantReadCalls, 0);
  assert.equal(m.redundantReadTokens, 0);
  assert.equal(m.redundantReadShare, 0);
  assert.equal(structuredFindings(m).some((f) => f.key === 'redundant-reads'), false);
});

test('redundant-reads: the allowance boundary prices exactly the turns past it', () => {
  const under = Array.from({ length: READ_FREE_CALLS }, (_, i) => readTurn('under', i));
  const mu = computeMetrics(under);
  assert.equal(mu.redundantReadCalls, 0);

  // One more read tips the session: only that fourth turn carries spend.
  const over = [...under, readTurn('under', 3)];
  const mo = computeMetrics(over);
  assert.equal(mo.redundantReadCalls, 1);
  assert.equal(mo.redundantReadTurns, 1);
  assert.equal(mo.redundantReadTokens, 3_000);
});

test('mergeMetrics recombines redundant-read counts over pooled spend, legacy exports included', () => {
  const looperEvents: StoredEvent[] = [];
  for (let i = 0; i < 9; i++) {
    looperEvents.push(readTurn('looper', i * 2));
    looperEvents.push(codingTurn('looper', i * 2 + 1));
  }
  const looper = computeMetrics(looperEvents);
  const calm = computeMetrics([
    makeStored({ session_id: 'calm', input_tokens: 1_000, output_tokens: 500 }),
  ]);
  const merged = mergeMetrics([looper, calm]);
  assert.equal(merged.redundantReadCalls, looper.redundantReadCalls);
  assert.equal(merged.redundantReadTokens, 6 * 3_000);
  assert.equal(merged.redundantReadShare, (6 * 3_000) / (9 * 3_000 + 9 * 200 + 1_500));

  // Pre-redundant-reads exports carry none of these fields, merge as zeros.
  const legacy = { ...looper } as Partial<Metrics>;
  delete legacy.redundantReadCalls;
  delete legacy.redundantReadTurns;
  delete legacy.redundantReadTokens;
  delete legacy.redundantReadSessions;
  delete legacy.redundantReadShare;
  const withLegacy = mergeMetrics([legacy as Metrics, calm]);
  assert.equal(withLegacy.redundantReadCalls, 0);
  assert.equal(withLegacy.redundantReadShare, 0);
});
