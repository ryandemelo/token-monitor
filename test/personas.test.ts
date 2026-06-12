import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/metrics.js';
import { assignPersona } from '../src/personas.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';

function persona(events: StoredEvent[]): string {
  return assignPersona(computeMetrics(events)).id;
}

test('firefighter: heavy testing share + high rework', () => {
  assert.equal(
    persona([
      makeStored({ ts: '2026-06-01T00:00:01Z', activity: 'coding', input_tokens: 1000, output_tokens: 1000 }),
      makeStored({ ts: '2026-06-01T00:00:02Z', activity: 'testing', is_error: 1, input_tokens: 500, output_tokens: 500 }),
      makeStored({ ts: '2026-06-01T00:00:03Z', activity: 'coding', input_tokens: 1000, output_tokens: 1000 }),
      makeStored({ ts: '2026-06-01T00:00:04Z', activity: 'testing', input_tokens: 1000, output_tokens: 1000 }),
    ]),
    'firefighter',
  );
});

test('explorer: exploration dominates', () => {
  assert.equal(
    persona([
      makeStored({ activity: 'exploration', input_tokens: 5000, output_tokens: 0 }),
      makeStored({ activity: 'coding', input_tokens: 1000, output_tokens: 0 }),
    ]),
    'explorer',
  );
});

test('sprinter: no planning, mostly coding, meaningful rework', () => {
  assert.equal(
    persona([
      makeStored({ ts: '2026-06-01T00:00:01Z', activity: 'coding', is_error: 1, input_tokens: 3000, output_tokens: 0 }),
      makeStored({ ts: '2026-06-01T00:00:02Z', activity: 'coding', input_tokens: 1500, output_tokens: 0 }),
      makeStored({ ts: '2026-06-01T00:00:03Z', activity: 'conversation', input_tokens: 1000, output_tokens: 0 }),
    ]),
    'sprinter',
  );
});

test('surgeon: high cache reuse, low rework, targeted exploration', () => {
  assert.equal(
    persona([
      makeStored({ activity: 'coding', input_tokens: 100, output_tokens: 100, cache_read_tokens: 5000 }),
      makeStored({ activity: 'conversation', input_tokens: 100, output_tokens: 100, cache_read_tokens: 5000 }),
    ]),
    'surgeon',
  );
});

test('architect: planning up front, low rework', () => {
  assert.equal(
    persona([
      makeStored({ activity: 'thinking', input_tokens: 2000, output_tokens: 0 }),
      makeStored({ activity: 'coding', input_tokens: 8000, output_tokens: 0 }),
    ]),
    'architect',
  );
});

test('balanced: fallback when nothing dominates', () => {
  assert.equal(persona([makeStored({ activity: 'conversation' })]), 'balanced');
});
