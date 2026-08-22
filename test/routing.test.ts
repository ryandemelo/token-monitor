import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRouting, sessionFacts, MIN_CATEGORY_SESSIONS, MIN_PER_SIDE, NOISE_BAND,
} from '../src/routing.js';
import { renderRouting } from '../src/report.js';
import { blendedRates } from '../src/recommendations.js';
import { computeMetrics } from '../src/metrics.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';

const PREMIUM = 'claude-opus-4-7';
const CHEAP = 'claude-haiku-4-5';

/** One session: n turns on a model, with `errors` of them failing. */
function session(id: string, model: string, opts: { errors?: number; turns?: number; project?: string; rework?: boolean } = {}): StoredEvent[] {
  const turns = opts.turns ?? 4;
  const out: StoredEvent[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(makeStored({
      session_id: id,
      project: opts.project ?? 'p1',
      model,
      ts: `2026-06-0${1 + (i % 9)}T0${i % 10}:00:00.000Z`,
      activity: opts.rework && i > 0 ? 'coding' : i === 0 ? 'testing' : 'coding',
      is_error: opts.rework && i === 0 ? 1 : (opts.errors ?? 0) > i ? 1 : 0,
      input_tokens: 20_000,
      output_tokens: 2_000,
    }));
  }
  return out;
}

function ratesFor(events: StoredEvent[]) {
  return blendedRates(computeMetrics(events));
}

test('a session is classified by where the majority of its spend went', () => {
  const events = [...session('prem', PREMIUM), ...session('cheap', CHEAP)];
  const facts = sessionFacts(events);
  assert.equal(facts.get('prem')!.premium, true);
  assert.equal(facts.get('cheap')!.premium, false);
  assert.ok(facts.get('prem')!.premiumTokens > 0);
  assert.equal(facts.get('cheap')!.premiumTokens, 0);
});

test('comparable outcomes on both tiers produce a priced no-gap row', () => {
  const events = [
    ...session('p1', PREMIUM), ...session('p2', PREMIUM), ...session('p3', PREMIUM),
    ...session('c1', CHEAP), ...session('c2', CHEAP), ...session('c3', CHEAP),
  ];
  const members = new Map([['deploy pipeline fix', ['p1', 'p2', 'p3', 'c1', 'c2', 'c3']]]);
  const [row] = computeRouting(members, sessionFacts(events), ratesFor(events), 30);
  assert.equal(row.verdict, 'no-measurable-gap');
  assert.equal(row.premiumSessions, 3);
  assert.equal(row.cheapSessions, 3);
  assert.ok(row.savingsUsdPerMonth! > 0);
  assert.equal(row.projectScoped, false);
});

test('a measurably worse cheap tier is reported as premium-better and priced at nothing', () => {
  const events = [
    ...session('p1', PREMIUM), ...session('p2', PREMIUM), ...session('p3', PREMIUM),
    // Every cheap session fails most of its turns.
    ...session('c1', CHEAP, { errors: 3 }), ...session('c2', CHEAP, { errors: 3 }), ...session('c3', CHEAP, { errors: 3 }),
  ];
  const members = new Map([['deploy pipeline fix', ['p1', 'p2', 'p3', 'c1', 'c2', 'c3']]]);
  const [row] = computeRouting(members, sessionFacts(events), ratesFor(events), 30);
  assert.equal(row.verdict, 'premium-better');
  assert.equal(row.savingsUsdPerMonth, undefined);
  assert.ok(row.errorDelta > NOISE_BAND);
});

test('the gates stay silent rather than reporting a thin comparison', () => {
  const facts = (ids: Array<[string, string]>) =>
    sessionFacts(ids.flatMap(([id, model]) => session(id, model)));

  // Too few sessions overall.
  const thin: Array<[string, string]> = [['p1', PREMIUM], ['p2', PREMIUM], ['c1', CHEAP]];
  assert.ok(thin.length < MIN_CATEGORY_SESSIONS);
  assert.deepEqual(computeRouting(new Map([['x', thin.map((t) => t[0])]]), facts(thin), ratesFor(session('p1', PREMIUM)), 30), []);

  // Enough sessions, but only one on the cheap side.
  const lopsided: Array<[string, string]> = [
    ['p1', PREMIUM], ['p2', PREMIUM], ['p3', PREMIUM], ['p4', PREMIUM], ['p5', PREMIUM], ['c1', CHEAP],
  ];
  assert.ok(MIN_PER_SIDE > 1);
  assert.deepEqual(computeRouting(new Map([['x', lopsided.map((t) => t[0])]]), facts(lopsided), ratesFor(session('p1', PREMIUM)), 30), []);
});

test("Simpson's guard: tiers used in different projects are not a comparison", () => {
  const events = [
    ...session('p1', PREMIUM, { project: 'alpha' }), ...session('p2', PREMIUM, { project: 'alpha' }),
    ...session('p3', PREMIUM, { project: 'alpha' }),
    ...session('c1', CHEAP, { project: 'beta' }), ...session('c2', CHEAP, { project: 'beta' }),
    ...session('c3', CHEAP, { project: 'beta' }),
  ];
  const members = new Map([['x', ['p1', 'p2', 'p3', 'c1', 'c2', 'c3']]]);
  assert.deepEqual(computeRouting(members, sessionFacts(events), ratesFor(events), 30), []);
});

test("...but a project where both tiers were used is compared, and marked", () => {
  const events = [
    ...session('p1', PREMIUM, { project: 'alpha' }), ...session('p2', PREMIUM, { project: 'alpha' }),
    ...session('c1', CHEAP, { project: 'alpha' }), ...session('c2', CHEAP, { project: 'alpha' }),
    // Noise from another project that only ever used one tier.
    ...session('p3', PREMIUM, { project: 'beta' }), ...session('p4', PREMIUM, { project: 'beta' }),
  ];
  const members = new Map([['x', ['p1', 'p2', 'c1', 'c2', 'p3', 'p4']]]);
  const [row] = computeRouting(members, sessionFacts(events), ratesFor(events), 30);
  assert.equal(row.projectScoped, true);
  assert.equal(row.sessions, 4, 'only the project where both tiers appeared is compared');
});

test('the rendered table explains the delta, the gates, and refuses the stronger claim', () => {
  const out = renderRouting([{
    category: 'deploy pipeline fix', sessions: 6, premiumSessions: 3, cheapSessions: 3,
    premiumTokens: 500_000, premiumCostUsd: 12.5, reworkDelta: 0.01, errorDelta: -0.02,
    verdict: 'no-measurable-gap', savingsUsdPerMonth: 40, projectScoped: true,
  }]).join('\n');
  assert.match(out, /Routing by task/);
  assert.match(out, /no measurable gap/);
  assert.match(out, /never that the premium model adds nothing/);
  assert.match(out, /deliberately NOT added to the report's headline potential/);
  assert.match(out, /◦ marks a comparison confined to the one project/);
  // Nothing to say is said with silence, not with an empty table.
  assert.deepEqual(renderRouting([]), []);
});
