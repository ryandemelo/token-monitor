import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeMetrics, carriedTurnsOf, estTokens } from '../src/metrics.js';
import { computeToolSurface, serverOf } from '../src/tool-surface.js';
import { declaredMcpServers } from '../src/mcp-config.js';
import { blendedRates } from '../src/recommendations.js';
import { makeStored } from './helpers.js';
import type { StoredEvent } from '../src/store.js';

const sizes = (o: Record<string, number>) => JSON.stringify(o);

test('serverOf splits mcp__server__tool, including underscored server names', () => {
  assert.equal(serverOf('mcp__github__create_issue'), 'github');
  assert.equal(serverOf('mcp__acme_data_lake__query'), 'acme_data_lake');
  assert.equal(serverOf('mcp__srv__ns__deep_tool'), 'srv');
  assert.equal(serverOf('Bash'), undefined);
  assert.equal(serverOf('mcp__weird'), undefined);
});

/** 6 turns, a big result on turn 1; context stays flat so nothing is compacted. */
function carrySession(): StoredEvent[] {
  return Array.from({ length: 6 }, (_, i) =>
    makeStored({
      session_id: 'carry',
      ts: `2026-06-01T0${i}:00:00.000Z`,
      tools: JSON.stringify(['Grep']),
      cache_read_tokens: 100_000,
      input_tokens: 1_000,
      output_tokens: 500,
      tool_result_chars: i === 0 ? sizes({ Grep: 40_000 }) : null,
    }),
  );
}

test('carry tax: a result is charged for the turns that follow it, not just its own', () => {
  const m = computeMetrics(carrySession());
  // 40k chars ~ 10k tokens, carried by the 5 turns after it.
  assert.equal(m.toolResultTokens, estTokens(40_000));
  assert.equal(m.toolResultTurns, 1);
  assert.equal(m.toolResultCarryTokens, estTokens(40_000) * 5);
  assert.ok(m.toolResultCarryShare > 0 && m.toolResultCarryShare < 1);
});

test('carry tax: the same result on the LAST turn is carried by nobody', () => {
  const events = carrySession().map((e, i, all) => ({
    ...e,
    tool_result_chars: i === all.length - 1 ? sizes({ Grep: 40_000 }) : null,
  }));
  const m = computeMetrics(events);
  assert.equal(m.toolResultTokens, estTokens(40_000));
  assert.equal(m.toolResultCarryTokens, 0);
});

test('carry stops at a context collapse (compaction is not logged; its drop is)', () => {
  const events = carrySession();
  // Turn 3 restarts on a small context: everything before it is gone.
  for (let i = 3; i < events.length; i++) events[i].cache_read_tokens = 5_000;
  const carried = carriedTurnsOf(events);
  assert.equal(carried[0], 2, 'turn 0 is carried only to the collapse at turn 3');
  const m = computeMetrics(events);
  assert.equal(m.toolResultCarryTokens, estTokens(40_000) * 2);
});

test('carry is clamped to the context a session actually paid for', () => {
  // An absurd result in a session with almost no context: the clamp binds.
  const events = Array.from({ length: 4 }, (_, i) =>
    makeStored({
      session_id: 'tiny',
      ts: `2026-06-02T0${i}:00:00.000Z`,
      cache_read_tokens: 1_000,
      input_tokens: 100,
      output_tokens: 100,
      tool_result_chars: i === 0 ? sizes({ Read: 10_000_000 }) : null,
    }),
  );
  const m = computeMetrics(events);
  const paid = events.reduce((t, e) => t + e.input_tokens + e.cache_read_tokens + e.cache_creation_tokens, 0);
  assert.equal(m.toolResultCarryTokens, paid);
  assert.ok(m.toolResultCarryShare <= 1);
});

test('sources that never record results read as unmeasured, not as zero', () => {
  const m = computeMetrics([makeStored({ source: 'cursor', tool_result_chars: null })]);
  assert.equal(m.toolResultTurns, 0);
  assert.equal(m.toolResultCarryTokens, 0);
  const surface = computeToolSurface([makeStored({ source: 'cursor', tool_result_chars: null })]);
  assert.equal(surface.measured, false);
});

test('session floor: median of the smallest context each session ran with, main loop only', () => {
  const events: StoredEvent[] = [];
  // 5 sessions with floors 10k..50k, each with a bigger later turn.
  for (let s = 1; s <= 5; s++) {
    events.push(makeStored({ session_id: `s${s}`, ts: `2026-06-0${s}T00:00:00.000Z`, cache_read_tokens: s * 10_000, input_tokens: 0, output_tokens: 10 }));
    events.push(makeStored({ session_id: `s${s}`, ts: `2026-06-0${s}T01:00:00.000Z`, cache_read_tokens: s * 30_000, input_tokens: 0, output_tokens: 10 }));
  }
  // A subagent run with a tiny context must not drag the floor down.
  events.push(makeStored({ session_id: 'agent', is_sidechain: 1, parent_session_id: 's1', cache_read_tokens: 500, output_tokens: 10 }));
  const m = computeMetrics(events);
  assert.equal(m.floorSessions, 5);
  assert.equal(m.sessionFloorTokens, 30_000);
  assert.ok(m.floorShare > 0 && m.floorShare < 1);
});

test('session floor is suppressed below the minimum session count', () => {
  const m = computeMetrics([
    makeStored({ session_id: 'only', cache_read_tokens: 90_000 }),
  ]);
  assert.equal(m.sessionFloorTokens, 0);
  assert.equal(m.floorShare, 0);
});

test('tool surface: per-tool carry, per-server rollup, and unused connected servers', () => {
  const events: StoredEvent[] = [
    makeStored({
      session_id: 'x', ts: '2026-06-01T00:00:00.000Z',
      tools: JSON.stringify(['mcp__search__query', 'Bash']),
      cache_read_tokens: 50_000, input_tokens: 1_000, output_tokens: 200,
      tool_result_chars: sizes({ 'mcp__search__query': 20_000, Bash: 400 }),
    }),
    makeStored({ session_id: 'x', ts: '2026-06-01T00:10:00.000Z', cache_read_tokens: 50_000, output_tokens: 200 }),
    makeStored({ session_id: 'x', ts: '2026-06-01T00:20:00.000Z', cache_read_tokens: 50_000, output_tokens: 200 }),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'tm-mcp-'));
  const cfg = join(dir, 'claude.json');
  writeFileSync(cfg, JSON.stringify({
    mcpServers: { search: {}, unused_one: {} },
    projects: { '/repo': { mcpServers: { scoped: {} }, enabledMcpjsonServers: ['from_mcpjson'] } },
  }));

  const surface = computeToolSurface(events, { rates: blendedRates(computeMetrics(events)), configPath: cfg });
  assert.equal(surface.measured, true);
  const top = surface.tools[0];
  assert.equal(top.tool, 'mcp__search__query');
  assert.equal(top.server, 'search');
  assert.equal(top.avgCarriedTurns, 2);
  assert.equal(top.carryTokens, estTokens(20_000) * 2);
  assert.ok(top.carryUsd > 0);

  assert.equal(surface.servers.length, 1);
  assert.equal(surface.servers[0].server, 'search');
  assert.equal(surface.servers[0].turns, 1);
  assert.deepEqual(surface.unusedServers, ['from_mcpjson', 'scoped', 'unused_one']);
  assert.deepEqual(surface.undeclaredServers, []);
});

test('mcp config: keys only, fail-soft on missing or malformed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-mcp2-'));
  const missing = declaredMcpServers(join(dir, 'nope.json'));
  assert.deepEqual(missing.servers, []);
  assert.match(missing.note!, /no Claude Code config/);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.match(declaredMcpServers(bad).note!, /could not be parsed/);

  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({
    mcpServers: { alpha: { command: 'node', args: ['/secret/path/server.js'], env: { TOKEN: 'CANARY-DO-NOT-READ' } } },
  }));
  const parsed = declaredMcpServers(good);
  assert.deepEqual(parsed.servers, ['alpha']);
  // Only names are surfaced — the command, its args and its env never are.
  assert.ok(!JSON.stringify(parsed).includes('CANARY-DO-NOT-READ'));
  assert.ok(!JSON.stringify(parsed).includes('/secret/path'));
});
