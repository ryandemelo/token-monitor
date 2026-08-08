import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSessionStats, computeToolStats, computeFanOut, computeAgentTypes, deepAnalysis, buildLlmPayload, buildLlmPrompt, buildLlmTrackPrompt, parseLlmFindings, extractJson } from '../src/analyze.js';
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

test('computeToolStats: retry cost accrues to the tool that re-ran after its error', () => {
  const stats = computeToolStats([
    makeStored({ session_id: 'r', ts: '2026-06-01T00:00:01Z', tools: '["Bash"]', is_error: 1, input_tokens: 100, output_tokens: 0 }),
    makeStored({ session_id: 'r', ts: '2026-06-01T00:00:02Z', tools: '["Bash","Read"]', input_tokens: 500, output_tokens: 100 }),
    // new session: no carry-over from the error above
    makeStored({ session_id: 'other', ts: '2026-06-01T00:00:03Z', tools: '["Bash"]', input_tokens: 900, output_tokens: 0 }),
  ]);
  assert.equal(stats.find((t) => t.tool === 'Bash')?.retryTokens, 600);
  assert.equal(stats.find((t) => t.tool === 'Read')?.retryTokens, 0);
});

test('computeSessionStats: context growth and cold restarts per session', () => {
  const evs = Array.from({ length: 8 }, (_, i) =>
    makeStored({
      session_id: 'g',
      // 10-minute gaps: every turn after the first is a cold restart
      ts: `2026-06-01T0${Math.floor((i * 10) / 60)}:${String((i * 10) % 60).padStart(2, '0')}:00Z`,
      input_tokens: i < 4 ? 100 : 5000,
      output_tokens: 0,
    }),
  );
  const [s] = computeSessionStats(evs);
  assert.ok(Math.abs(s.contextGrowth - 50) < 1e-9);
  assert.equal(s.coldRestartTurns, 7);
  assert.equal(s.coldRestartTokens, 100 * 3 + 5000 * 4);
  // the 5-min-apart fix-loop session has no cold restarts (gap must exceed the TTL)
  assert.equal(computeSessionStats(fixLoopSession)[0].coldRestartTurns, 0);
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

test('track prompt demands strict JSON targeting a trackable metric', () => {
  const prompt = buildLlmTrackPrompt(fixLoopSession, 30);
  assert.ok(prompt.includes('STRICT JSON'));
  assert.ok(prompt.includes('"interventions"'));
  assert.ok(prompt.includes('cacheHitRatio')); // lists the trackable metrics
  assert.ok(prompt.includes('reworkRatio = ')); // shares the metric definitions
  assert.ok(prompt.includes('DATA:'));
});

test('extractJson finds the first balanced object inside surrounding noise', () => {
  assert.deepEqual(extractJson('blah {"a":1,"b":{"c":2}} trailing'), { a: 1, b: { c: 2 } });
  assert.deepEqual(extractJson('"a string with } brace"'), 'a string with } brace');
  assert.equal(extractJson('no json here'), undefined);
});

test('parseLlmFindings recovers the payload past a stray bracket region in prose', () => {
  // a non-JSON {curly} and a valid-but-useless [0] precede the real object
  const text = 'Notes: {see below} and item [0]:\n{"interventions":[{"metric":"cacheHitRatio","title":"reuse"}]}';
  assert.equal(parseLlmFindings(text).interventions[0]?.metric, 'cacheHitRatio');
});

test('parseLlmFindings respects braces and escapes inside JSON strings', () => {
  const text = 'Here: {"interventions":[{"metric":"reworkRatio","title":"close the } and ] here","rationale":"a \\"quote\\" too"}]} done';
  const got = parseLlmFindings(text);
  assert.equal(got.interventions[0].metric, 'reworkRatio');
  assert.equal(got.interventions[0].title, 'close the } and ] here');
  assert.equal(got.interventions[0].rationale, 'a "quote" too');
});

test('parseLlmFindings: strict object form', () => {
  const { interventions, dropped } = parseLlmFindings(
    '{"interventions":[{"metric":"cacheHitRatio","title":"Reuse prompt","rationale":"cache 12%"}]}',
  );
  assert.equal(interventions.length, 1);
  assert.equal(interventions[0].metric, 'cacheHitRatio');
  assert.equal(interventions[0].title, 'Reuse prompt');
  assert.equal(dropped, 0);
});

test('parseLlmFindings: tolerates prose and a ```json fence around the JSON', () => {
  const text =
    'Sure, here are my picks:\n```json\n{"interventions":[{"metric":"reworkRatio","title":"Plan first","rationale":"rework 40%"}]}\n```\nHope that helps!';
  assert.equal(parseLlmFindings(text).interventions[0].metric, 'reworkRatio');
});

test('parseLlmFindings: bare array, drops untrackable / duplicate / titleless items', () => {
  const text =
    '[{"metric":"cacheHitRatio","title":"a"},{"metric":"bogusMetric","title":"b"},{"metric":"cacheHitRatio","title":"dup"},{"metric":"retryShare","title":""}]';
  const { interventions, dropped } = parseLlmFindings(text);
  assert.deepEqual(interventions.map((i) => i.metric), ['cacheHitRatio']);
  assert.equal(dropped, 3); // bogus metric, duplicate metric, empty title
});

test('parseLlmFindings: no JSON present yields an empty, non-throwing result', () => {
  assert.deepEqual(parseLlmFindings('I could not analyze this.'), { interventions: [], dropped: 0 });
});

// ---- subagent fan-out (#63) -------------------------------------------------

const fanOutEvents = [
  makeStored({ session_id: 'p1', project: 'repo-a', ts: '2026-06-01T10:00:00Z', input_tokens: 400, output_tokens: 100 }),
  makeStored({ session_id: 'g1', parent_session_id: 'p1', is_sidechain: 1, agent_type: 'Explore', project: 'repo-a', ts: '2026-06-01T10:05:00Z', input_tokens: 600, output_tokens: 400 }),
  makeStored({ session_id: 'g2', parent_session_id: 'p1', is_sidechain: 1, agent_type: 'general-purpose', project: 'repo-a', ts: '2026-06-01T10:06:00Z', input_tokens: 400, output_tokens: 100 }),
  makeStored({ session_id: 'p2', project: 'repo-b', ts: '2026-06-01T11:00:00Z', input_tokens: 100, output_tokens: 100 }),
];

test('computeFanOut attributes agent spend to the session that delegated it', () => {
  const rows = computeFanOut(fanOutEvents);
  assert.equal(rows.length, 1); // p2 delegated nothing, so it has no row
  const [f] = rows;
  assert.equal(f.sessionId, 'p1');
  assert.equal(f.project, 'repo-a');
  assert.equal(f.agents, 2);
  assert.equal(f.agentSpendTokens, 1500);
  assert.equal(f.mainSpendTokens, 500);
  assert.equal(f.ratio, 3); // the fan-out cost 3x the driver
});

test('computeFanOut survives a session whose driver transcript is gone', () => {
  const [f] = computeFanOut([
    makeStored({ session_id: 'g9', parent_session_id: 'lost', is_sidechain: 1, input_tokens: 100, output_tokens: 100 }),
  ]);
  assert.equal(f.mainSpendTokens, 0);
  assert.equal(f.ratio, 0); // reported as 0, never Infinity
});

test('computeAgentTypes ranks spend by subagent type', () => {
  const types = computeAgentTypes(fanOutEvents);
  assert.deepEqual(types.map((t) => t.agentType), ['Explore', 'general-purpose']);
  assert.equal(types[0].spendTokens, 1000);
  assert.equal(types[0].runs, 1);
  // Unlabelled runs are counted, not dropped: the spend is real either way.
  const unlabelled = computeAgentTypes([
    makeStored({ session_id: 'g0', parent_session_id: 'p', is_sidechain: 1 }),
  ]);
  assert.deepEqual(unlabelled.map((t) => t.agentType), ['unlabelled']);
});

test('the LLM payload carries the subagent share but never agent-type names', () => {
  const payload = buildLlmPayload(fanOutEvents, 30) as {
    overall: { subagentShare: number; subagentRuns: number };
    fanOutSessions: Array<{ project: string; agents: number }>;
  };
  assert.equal(payload.overall.subagentRuns, 2);
  assert.equal(payload.overall.subagentShare, 0.682);
  assert.deepEqual(payload.fanOutSessions, [
    { project: 'repo-a', agents: 2, agentSpendTokens: 1500, mainSpendTokens: 500, ratio: 3 },
  ]);
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('Explore'));
  assert.ok(!json.includes('general-purpose'));
  assert.ok(!json.includes('p1')); // no session ids either
});

test('the LLM payload marks subagent runs and keeps them out of the bloat lists', () => {
  const turnsOf = (id: string, sidechain: boolean, n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeStored({
        session_id: id,
        is_sidechain: sidechain ? 1 : 0,
        parent_session_id: sidechain ? 'human' : null,
        ts: `2026-06-01T1${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}:00Z`,
        input_tokens: 50_000,
        output_tokens: 100,
      }),
    );
  const events = [...turnsOf('human', false, 12), ...Array.from({ length: 20 }, (_, i) => turnsOf(`a${i}`, true, 40)).flat()];
  const deep = deepAnalysis(events);
  // Context-heavy is a bloat proxy: agent runs never appear, however chatty.
  assert.ok(deep.contextHeavySessions.every((s) => !s.isSidechain));
  assert.ok(deep.coldRestartSessions.every((s) => !s.isSidechain));
  // Expensive sessions stay inclusive — a runaway run is worth seeing — but
  // every emitted row says which kind it is.
  const payload = buildLlmPayload(events, 30) as { expensiveSessions: Array<{ isSidechain: boolean }> };
  assert.ok(payload.expensiveSessions.some((s) => s.isSidechain));
  assert.ok(payload.expensiveSessions.every((s) => typeof s.isSidechain === 'boolean'));
});
