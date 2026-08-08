import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, PRICES } from '../src/pricing.js';

test('generation-specific rows win over catch-alls (order-dependent)', () => {
  // Antigravity's internal flash id hits the pinned gemini-3-flash row, not the catch-all.
  const flash = costOf('gemini-3-flash-a', 1_000_000, 0, 0, 0);
  assert.equal(flash.usd, 0.5);
  assert.equal(flash.estimated, false);

  // flash-lite must match before the broader 2.5-flash row.
  const lite = costOf('gemini-2.5-flash-lite', 1_000_000, 0, 0, 0);
  assert.equal(lite.usd, 0.1);

  // gpt-5.5 hits its pinned row, not the gpt-5 catch-all.
  const gpt55 = costOf('gpt-5.5', 1_000_000, 0, 0, 0);
  assert.equal(gpt55.usd, 5);
  assert.equal(gpt55.estimated, false);

  // versioned codex (5.3) is pinned; original gpt-5-codex stays estimated.
  assert.equal(costOf('gpt-5.3-codex', 1_000_000, 0, 0, 0).estimated, false);
  assert.equal(costOf('gpt-5-codex', 1_000_000, 0, 0, 0).estimated, true);
  assert.equal(costOf('gpt-5-codex', 1_000_000, 0, 0, 0).usd, 1.25);
});

test('unknown models are unpriced, not zero-cost-estimated', () => {
  const c = costOf('cursor-auto', 1_000_000, 1_000_000, 0, 0);
  assert.equal(c.priced, false);
  assert.equal(c.usd, 0);
});

test('every model seen by the adapters resolves to some row or is knowingly unpriced', () => {
  // Guards against future row reordering silently orphaning known model ids.
  for (const model of ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gpt-5.5-pro', 'gpt-5.2-codex', 'claude-opus-4-7']) {
    assert.ok(PRICES.some((p) => p.match.test(model)), `${model} has no price row`);
  }
  for (const knowinglyUnpriced of ['cursor-auto', 'copilot/gpt-4.1 (est)', 'antigravity']) {
    // Cursor/Copilot can't be priced (no resolved model / subscription) — must stay unpriced.
    assert.ok(!PRICES.some((p) => p.match.test(knowinglyUnpriced)), `${knowinglyUnpriced} unexpectedly priced`);
  }
});

test('Claude 5 family is priced, including the 1M-context variant id', () => {
  // claude-opus-5 / claude-sonnet-5 read as unpriced before these rows existed,
  // which showed up as $0.00 cost columns on real data.
  for (const [model, input, output] of [
    ['claude-opus-5', 5, 25],
    ['claude-opus-5[1m]', 5, 25],
    ['claude-sonnet-5', 3, 15],
    ['claude-fable-5', 10, 50],
    ['claude-haiku-4-5-20251001', 1, 5],
  ] as const) {
    const c = costOf(model, 1_000_000, 0, 0, 0);
    assert.equal(c.priced, true, `${model} must be priced`);
    assert.ok(Math.abs(c.usd - input) < 1e-9, `${model} input rate`);
    assert.ok(Math.abs(costOf(model, 0, 1_000_000, 0, 0).usd - output) < 1e-9, `${model} output rate`);
    // Cache read is 10% of input; a 5-minute cache write is 1.25x.
    assert.ok(Math.abs(costOf(model, 0, 0, 1_000_000, 0).usd - input * 0.1) < 1e-9, `${model} cache read`);
    assert.ok(Math.abs(costOf(model, 0, 0, 0, 1_000_000).usd - input * 1.25) < 1e-9, `${model} cache write`);
  }
});

test('generation-specific rows win over older ones', () => {
  // /claude-opus-4/ must not swallow claude-opus-5, and vice versa.
  assert.equal(costOf('claude-opus-4-8', 1_000_000, 0, 0, 0).usd, 5);
  assert.equal(costOf('claude-sonnet-4-5', 1_000_000, 0, 0, 0).usd, 3);
  assert.equal(costOf('claude-sonnet-5', 1_000_000, 0, 0, 0).usd, 3);
});
