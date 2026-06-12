import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/metrics.js';
import { blendedRates, enrichFindings, fmtSavings, fmtEvidence } from '../src/recommendations.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';

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
