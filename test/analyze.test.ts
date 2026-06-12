import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSessionStats, computeToolStats, deepAnalysis, buildLlmPayload, buildLlmPrompt } from '../src/analyze.js';
import { makeStored } from './helpers.js';

const fixLoopSession = [
  makeStored({ session_id: 'fx', ts: '2026-06-01T10:00:00Z', activity: 'coding', input_tokens: 1000, output_tokens: 0 }),
  makeStored({ session_id: 'fx', ts: '2026-06-01T10:05:00Z', activity: 'testing', is_error: 1, input_tokens: 500, output_tokens: 0 }),
  makeStored({ session_id: 'fx', ts: '2026-06-01T10:10:00Z', activity: 'coding', input_tokens: 800, output_tokens: 0 }),
  makeStored({ session_id: 'fx', ts: '2026-06-01T10:15:00Z', activity: 'testing', input_tokens: 500, output_tokens: 0 }),
  makeStored({ session_id: 'fx', ts: '2026-06-01T10:20:00Z', activity: 'coding', input_tokens: 700, output_tokens: 0 }),
];

test('computeSessionStats: fix iterations, duration, context, dominant', () => {
  const [s] = computeSessionStats(fixLoopSession);
  assert.equal(s.turns, 5);
  assert.equal(s.fixIterations, 2); // two testing->coding transitions
  assert.equal(s.errorTurns, 1);
  assert.equal(s.durationMin, 20);
  assert.equal(s.spendTokens, 3500);
  assert.equal(s.avgContextTokens, 700); // 3500 input / 5 turns, no cache
  assert.equal(s.dominant, 'coding');
});

test('computeToolStats attributes errors to tools in failing turns', () => {
  const stats = computeToolStats([
    makeStored({ tools: '["Bash","Read"]', is_error: 1 }),
    makeStored({ tools: '["Bash"]' }),
    makeStored({ tools: '["Read"]' }),
    makeStored({ tools: 'not-json' }), // ignored, no throw
  ]);
  const bash = stats.find((t) => t.tool === 'Bash');
  const read = stats.find((t) => t.tool === 'Read');
  assert.equal(bash?.turns, 2);
  assert.equal(bash?.errorRate, 0.5);
  assert.equal(read?.turns, 2);
  assert.equal(read?.errorRate, 0.5);
});

test('deepAnalysis surfaces fix-loop sessions and sorts expensive first', () => {
  const events = [
    ...fixLoopSession,
    makeStored({ session_id: 'big', ts: '2026-06-02T10:00:00Z', activity: 'coding', input_tokens: 100_000, output_tokens: 0 }),
  ];
  const d = deepAnalysis(events);
  assert.equal(d.expensiveSessions[0].sessionId, 'big');
  assert.equal(d.fixLoopSessions.length, 1);
  assert.equal(d.fixLoopSessions[0].sessionId, 'fx');
});

test('llm payload contains aggregates only — no transcript-shaped fields', () => {
  const payload = buildLlmPayload(fixLoopSession, 30) as Record<string, unknown>;
  const json = JSON.stringify(payload);
  assert.ok(json.includes('reworkRatio'));
  assert.ok(!json.includes('sessionId')); // session ids are slimmed out
  for (const banned of ['"content"', '"message"', '"prompt"', '"command"', 'tool_use']) {
    assert.ok(!json.includes(banned), `payload must not contain ${banned}`);
  }
});

test('llm prompt embeds definitions, asks for prioritized interventions, stays compact', () => {
  const prompt = buildLlmPrompt(fixLoopSession, 30);
  assert.ok(prompt.includes('Top 3 interventions'));
  assert.ok(prompt.includes('reworkRatio = '));
  assert.ok(prompt.includes('DATA:'));
  assert.ok(prompt.length < 20_000, `prompt too large: ${prompt.length}`);
});
