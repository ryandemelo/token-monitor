import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, PLAN_IDS, findPlan, seatComparison, fmtSeatComparison, MIN_PROJECTION_DAYS } from '../src/plans.js';
import { renderReport, renderTeamReport } from '../src/report.js';
import { buildExport } from '../src/team.js';
import { validateTeamConfig } from '../src/deploy.js';
import { computeMetrics } from '../src/metrics.js';
import { makeStored } from './helpers.js';
import type { SignedExport } from '../src/team.js';
import type { StoredEvent } from '../src/store.js';

test('the plan table is well formed and every id is unique', () => {
  assert.equal(new Set(PLAN_IDS).size, PLANS.length);
  for (const p of PLANS) {
    assert.ok(p.monthlyUsd > 0, `${p.id} needs a price`);
    if (p.annualUsd !== undefined) {
      assert.ok(p.annualUsd <= p.monthlyUsd, `${p.id}: annual billing should not cost more per month`);
    }
    // Anything the public page does not state outright must say so.
    if (p.estimated) assert.ok(p.note, `${p.id} is estimated and needs a note explaining why`);
  }
});

test('findPlan is forgiving about case and spacing, strict about names', () => {
  assert.equal(findPlan('  MAX-20X ')?.id, 'max-20x');
  assert.equal(findPlan('pro')?.monthlyUsd, 20);
  assert.equal(findPlan('max-50x'), undefined);
});

test('seatComparison projects the window to a month and divides by the seat', () => {
  const pro = findPlan('pro')!;
  // $70 over 15 days -> $140/mo against a $20 seat = 7x.
  const c = seatComparison(70, 15, pro);
  assert.equal(c.apiEquivalentMonthlyUsd, 140);
  assert.equal(c.seatMonthlyUsd, 20);
  assert.equal(c.ratio, 7);
  assert.equal(c.thin, false);
  assert.equal(c.estimated, false);

  // --annual prices against the annual-billing rate where one is published.
  assert.equal(seatComparison(70, 15, pro, { annual: true }).seatMonthlyUsd, 17);
  // ...and falls back to the monthly rate where none is.
  assert.equal(seatComparison(70, 15, findPlan('max-5x')!, { annual: true }).seatMonthlyUsd, 100);
});

test('an estimated plan price or an estimated cost marks the comparison', () => {
  assert.equal(seatComparison(100, 30, findPlan('max-20x')!).estimated, true);
  assert.equal(seatComparison(100, 30, findPlan('pro')!, { estimated: true }).estimated, true);
  assert.equal(seatComparison(100, 30, findPlan('pro')!).estimated, false);
});

test('a short window is projected but flagged, not quoted as a ratio', () => {
  const c = seatComparison(10, MIN_PROJECTION_DAYS - 1, findPlan('pro')!);
  assert.equal(c.thin, true);
  assert.match(fmtSeatComparison(c), /read the ratio as a hint, not a number/);
});

test('the sentence changes direction with the ratio, and never instructs', () => {
  const pro = findPlan('pro')!;
  assert.match(fmtSeatComparison(seatComparison(100, 30, pro)), /returning well over what it costs/);
  assert.match(fmtSeatComparison(seatComparison(20, 30, pro)), /About break-even/);
  const low = fmtSeatComparison(seatComparison(4, 30, pro));
  assert.match(low, /A lower tier may fit/);
  assert.ok(!/you should|downgrade now/i.test(low), 'the low-usage wording must stay a suggestion');
});

function window(costEvents = 6): StoredEvent[] {
  return Array.from({ length: costEvents }, (_, i) =>
    makeStored({
      session_id: `s${i}`,
      ts: `2026-06-0${i + 1}T10:00:00.000Z`,
      model: 'claude-haiku-4-5',
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    }),
  );
}

test('report shows the seat section only when a plan is given', () => {
  const events = window();
  assert.ok(!renderReport(events, { days: 30 }).includes('Seat value'));
  const withPlan = renderReport(events, { days: 30, plan: findPlan('max-5x')! });
  assert.match(withPlan, /Seat value/);
  assert.match(withPlan, /Max 5x/);
  assert.match(withPlan, /not a quota tracker/);
});

test('exports carry the plan only when one was declared', () => {
  const events = window();
  assert.equal(buildExport(events, 30).plan, undefined);
  assert.equal(buildExport(events, 30, { plan: 'team-premium' }).plan, 'team-premium');
});

function member(user: string, plan: string | undefined, costMultiplier: number): SignedExport {
  const events = window(costMultiplier);
  const ex = buildExport(events, 30, { plan });
  return { ...ex, user, overall: computeMetrics(events) } as SignedExport;
}

test('merge prices seats per member, totals the declared ones, and never assumes a plan', () => {
  const exports = [member('alice', 'max-5x', 8), member('bob', 'pro', 2), member('carol', undefined, 4)];
  const out = renderTeamReport(exports, {});
  assert.match(out, /Seat value \(members who declared a plan\)/);
  assert.match(out, /alice/);
  assert.match(out, /Max 5x/);
  assert.match(out, /1 member\(s\) with no declared plan/);
  // Org line sums both sides across the declared seats only ($100 + $20).
  assert.match(out, /\$120\/mo of seats/);
});

test('merge stays silent about seats when nobody declared a plan', () => {
  const out = renderTeamReport([member('alice', undefined, 4)], {});
  assert.ok(!out.includes('Seat value'));
});

test('team config validates the plan name it distributes', () => {
  const base = { teamName: 't', push: { type: 'path' as const, dir: '/tmp/x' } };
  assert.equal(validateTeamConfig({ ...base, plan: 'team-standard' }).plan, 'team-standard');
  assert.throws(() => validateTeamConfig({ ...base, plan: 'max-50x' }), /plan must be one of/);
});
