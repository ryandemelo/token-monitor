import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/metrics.js';
import { blendedRates, enrichFindings, fmtSavings, fmtEvidence, potentialBill, fmtPotential, realizedMonthly, fmtUsdShort } from '../src/recommendations.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';
import type { FollowRow } from '../src/followthrough.js';

test('blendedRates: mix-weighted prices, cheap tier from the user\'s own mix', () => {
  const m = computeMetrics([
    makeStored({ model: 'claude-opus-4-7', input_tokens: 900_000, output_tokens: 0 }),
    makeStored({ model: 'claude-haiku-4-5', input_tokens: 100_000, output_tokens: 0 }),
  ]);
  const r = blendedRates(m);
  // input $/tok: (0.9*5 + 0.1*1)/1e6
  assert.ok(Math.abs(r.input - 4.6e-6) < 1e-12);
  assert.ok(Math.abs(r.cacheRead - 0.46e-6) < 1e-12);
  assert.ok(Math.abs(r.premium - 5e-6) < 1e-12); // opus input-only usage
  assert.ok(Math.abs(r.cheap - 1e-6) < 1e-12); // haiku is the cheap tier in the mix
  assert.equal(r.estimated, false);
});

test('blendedRates: premium-only mix assumes a cheaper tier and flags the estimate', () => {
  const m = computeMetrics([
    makeStored({ model: 'claude-opus-4-7', input_tokens: 1_000_000, output_tokens: 0 }),
  ]);
  const r = blendedRates(m);
  assert.ok(Math.abs(r.cheap - r.premium / 5) < 1e-15);
  assert.equal(r.estimated, true);
});

// Premium spend routed to exploration: trips premium-misroute (and overuse needs >1 model).
function misrouteEvents(): StoredEvent[] {
  return [
    makeStored({ session_id: 'big', ts: '2026-06-01T00:00:00Z', model: 'claude-opus-4-7', activity: 'exploration', input_tokens: 300_000, output_tokens: 0 }),
    makeStored({ session_id: 'mid', ts: '2026-06-02T00:00:00Z', model: 'claude-opus-4-7', activity: 'exploration', input_tokens: 200_000, output_tokens: 0 }),
    makeStored({ session_id: 'sml', ts: '2026-06-03T00:00:00Z', model: 'claude-opus-4-7', activity: 'exploration', input_tokens: 100_000, output_tokens: 0 }),
    makeStored({ session_id: 'tiny', ts: '2026-06-04T00:00:00Z', model: 'claude-haiku-4-5', activity: 'coding', input_tokens: 1_000, output_tokens: 0 }),
  ];
}

test('enrichFindings: evidence cites the worst 3 sessions, sorted, aggregate-only', () => {
  const events = misrouteEvents();
  const recs = enrichFindings(events, computeMetrics(events), 30);
  const rec = recs.find((r) => r.key === 'premium-misroute');
  assert.ok(rec);
  assert.equal(rec.evidence.length, 3);
  assert.deepEqual(rec.evidence.map((e) => e.sessionId), ['big', 'mid', 'sml']);
  assert.equal(rec.evidence[0].date, '2026-06-01');
  assert.match(rec.evidence[0].label, /300\.0k premium on exploration\/chat/);
  // export safety: only ids, dates, labels — no transcript-shaped fields
  for (const banned of ['content', 'message', 'prompt', 'command']) {
    assert.ok(!Object.keys(rec.evidence[0]).includes(banned));
  }
});

test('enrichFindings: savings priced from the user\'s own mix, scaled to $/month', () => {
  const events = misrouteEvents();
  const m = computeMetrics(events);
  const recs = enrichFindings(events, m, 30);
  const rec = recs.find((r) => r.key === 'premium-misroute')!;
  // 600k tokens moved from opus input ($5/M) to haiku ($1/M) = $2.40 over 30 days
  assert.ok(rec.savingsUsdPerMonth);
  assert.ok(Math.abs(rec.savingsUsdPerMonth! - 600_000 * 4e-6) < 1e-9);
  assert.equal(rec.savingsEstimated, false);
  assert.equal(fmtSavings(rec), '≈ $2.40/mo');

  // half the window -> double the monthly figure
  const recs15 = enrichFindings(events, m, 15);
  const rec15 = recs15.find((r) => r.key === 'premium-misroute')!;
  assert.ok(Math.abs(rec15.savingsUsdPerMonth! - rec.savingsUsdPerMonth! * 2) < 1e-9);
});

test('fmtSavings marks estimated prices with ~; fmtEvidence truncates session ids', () => {
  const events = [
    makeStored({ session_id: 'a-very-long-session-id', ts: '2026-06-01T00:00:00Z', model: 'claude-opus-4-7', activity: 'exploration', input_tokens: 200_000, output_tokens: 0 }),
  ];
  const m = computeMetrics(events);
  const recs = enrichFindings(events, m, 30);
  const rec = recs.find((r) => r.key === 'premium-misroute')!;
  assert.equal(rec.savingsEstimated, true); // cheap tier assumed (premium-only mix)
  assert.match(fmtSavings(rec)!, /^≈ ~\$/);
  assert.match(fmtEvidence(rec)!, /^worst: a-very-l \(proj, 2026-06-01/);
});

// 12 sessions, no cache reads anywhere except 4 strong sessions at ~90% —
// enough data for a personalized cache-hit target at the top quartile.
function selfBenchmarkEvents(): StoredEvent[] {
  const out: StoredEvent[] = [];
  for (let i = 0; i < 12; i++) {
    const strong = i < 4;
    out.push(
      makeStored({
        session_id: `s${i}`,
        ts: `2026-06-0${(i % 9) + 1}T00:00:00Z`,
        activity: 'coding',
        input_tokens: 50_000,
        output_tokens: 0,
        // strong sessions hit ~67%; overall stays at 40% so the finding fires
        cache_read_tokens: strong ? 100_000 : 0,
      }),
    );
  }
  return out;
}

test('personalized target: enough sessions -> own top quartile, message cites it', () => {
  const events = selfBenchmarkEvents();
  const m = computeMetrics(events);
  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'low-cache-hit');
  assert.ok(rec); // overall hit ratio is well below 50%
  assert.ok(rec.target?.personal);
  // p75 of [0×8, 0.9×4] sits between the cold mass and the strong sessions
  assert.ok(rec.target!.value > 0.5 && rec.target!.value <= 0.9);
  assert.match(rec.message, /top-quartile sessions already run at/);
});

test('personalized target: thin data falls back to the static target', () => {
  const events = [
    makeStored({ session_id: 'only', activity: 'coding', input_tokens: 200_000, output_tokens: 0 }),
  ];
  const m = computeMetrics(events);
  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'low-cache-hit');
  assert.ok(rec);
  assert.equal(rec.target?.personal, false);
  assert.equal(rec.target?.value, 0.8);
  assert.ok(!rec.message.includes('top-quartile'));
});

test('enriched recs sort by savings, biggest lever first', () => {
  const events = misrouteEvents();
  const recs = enrichFindings(events, computeMetrics(events), 30);
  const quantified = recs.filter((r) => r.savingsUsdPerMonth !== undefined);
  for (let i = 1; i < quantified.length; i++) {
    assert.ok(quantified[i - 1].savingsUsdPerMonth! >= quantified[i].savingsUsdPerMonth!);
  }
  // unquantified recs come last
  const firstUnq = recs.findIndex((r) => r.savingsUsdPerMonth === undefined);
  if (firstUnq !== -1) assert.ok(recs.slice(firstUnq).every((r) => r.savingsUsdPerMonth === undefined));
});

test('potentialBill de-overlaps within families instead of summing', () => {
  const events = misrouteEvents();
  const m = computeMetrics(events);
  const recs = enrichFindings(events, m, 30);
  const overuse = recs.find((r) => r.key === 'premium-model-overuse')!.savingsUsdPerMonth!;
  const misroute = recs.find((r) => r.key === 'premium-misroute')!.savingsUsdPerMonth!;
  const p = potentialBill(recs, m, 30)!;
  const routing = p.families.find((f) => f.family === 'routing')!;
  // family takes the max of the overlapping levers, never the sum
  assert.ok(Math.abs(routing.usdPerMonth - Math.max(overuse, misroute)) < 1e-9);
  assert.ok(routing.usdPerMonth < overuse + misroute);
  assert.ok(p.potentialUsdPerMonth < p.currentUsdPerMonth);
  assert.match(fmtPotential(p), /^Potential: .*\/mo → .*\/mo \(/);
});

test('realizedMonthly prices the baseline->current move; flat rows stay blank', () => {
  const events = misrouteEvents();
  const m = computeMetrics(events);
  const rates = blendedRates(m);
  const row = (current: number): FollowRow => ({
    key: 'low-cache-hit', metric: 'cacheHitRatio', direction: 'up',
    baseline: 0.4, current, createdAt: '2026-06-01', status: 'improving',
  });
  const realized = realizedMonthly(row(0.6), m, rates, 30)!;
  // 0.2 move × inputSide × (input − cacheRead)
  const inputSide = m.cacheReadTokens + m.inputTokens + m.cacheCreationTokens;
  assert.ok(Math.abs(realized - 0.2 * inputSide * (rates.input - rates.cacheRead)) < 1e-9);
  assert.equal(realizedMonthly(row(0.41), m, rates, 30), undefined); // within noise
  assert.equal(realizedMonthly(row(0.3), m, rates, 30), undefined); // regression
});

test('fmtUsdShort scales units', () => {
  assert.equal(fmtUsdShort(18_700), '$18.7k');
  assert.equal(fmtUsdShort(8_882), '$8.9k');
  assert.equal(fmtUsdShort(581), '$581');
  assert.equal(fmtUsdShort(2.4), '$2.40');
});

test('low-think-code stays unquantified but keeps its message and key', () => {
  const events = [
    makeStored({ activity: 'coding', input_tokens: 60_000, output_tokens: 0 }),
  ];
  const m = computeMetrics(events);
  const rec = enrichFindings(events, m, 30).find((r) => r.key === 'low-think-code');
  assert.ok(rec);
  assert.equal(rec.savingsUsdPerMonth, undefined);
  assert.equal(fmtSavings(rec), undefined);
});
