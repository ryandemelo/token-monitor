import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, insertEvents, loadEvents } from '../src/store.js';
import { buildDonation, writeDonation, resolveSession, anonymizeTool } from '../src/donate.js';
import { collectClaudeCode } from '../src/adapters/claude-code.js';
import { computeMetrics } from '../src/metrics.js';
import { classify } from '../src/classify.js';
import { makeEvent } from './helpers.js';
import type { Activity, UsageEvent } from '../src/types.js';
import type { StoredEvent } from '../src/store.js';

/** A session worth donating: a fix loop, an MCP call with a big result, a fan-out. */
function seed(): UsageEvent[] {
  const base = (i: number, extra: Partial<UsageEvent> = {}): UsageEvent =>
    makeEvent({
      sessionId: 'aabbccdd-1111-2222-3333-444455556666',
      project: 'acme-billing',
      gitBranch: 'feat/acme-invoice-export',
      timestamp: `2026-05-0${1 + Math.floor(i / 6)}T1${i % 6}:07:00.000Z`,
      inputTokens: 1_000 + i,
      outputTokens: 200 + i,
      cacheReadTokens: 50_000,
      cacheCreationTokens: i === 0 ? 8_000 : 0,
      cacheCreation1hTokens: i === 0 ? 6_000 : 0,
      ...extra,
    });
  return [
    base(0, { tools: ['Read'], toolResultChars: { Read: 40_000 } }),
    base(1, {
      tools: ['mcp__acme_warehouse__query'],
      toolResultChars: { 'mcp__acme_warehouse__query': 12_000 },
    }),
    base(2, { tools: ['Bash'], commands: ['npm test'], isError: true }),
    base(3, { tools: ['Edit'] }),
    base(4, { tools: ['Bash'], commands: ['git commit -m "fix acme invoice rounding"'] }),
    base(5, { hasThinking: true }),
    // One subagent run under the same session.
    makeEvent({
      sessionId: 'agent-run-xyz',
      parentSessionId: 'aabbccdd-1111-2222-3333-444455556666',
      isSidechain: true,
      agentType: 'acme-secret-auditor',
      project: 'acme-billing',
      timestamp: '2026-05-01T13:30:00.000Z',
      tools: ['Grep'],
      toolResultChars: { Grep: 4_000 },
      inputTokens: 900,
      outputTokens: 90,
      cacheReadTokens: 20_000,
    }),
    makeEvent({
      sessionId: 'agent-run-xyz',
      parentSessionId: 'aabbccdd-1111-2222-3333-444455556666',
      isSidechain: true,
      agentType: 'acme-secret-auditor',
      project: 'acme-billing',
      timestamp: '2026-05-01T13:31:00.000Z',
      tools: ['Edit'],
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 21_000,
    }),
  ];
}

function donateToDisk(): { dir: string; source: StoredEvent[]; body: string } {
  const dbDir = mkdtempSync(join(tmpdir(), 'tm-donate-db-'));
  const db = openDb(join(dbDir, 'db.sqlite'));
  const events = seed().map((e) => ({ ...e, activity: classifyish(e) }));
  insertEvents(db, events);
  const sessionId = resolveSession(db, 'aabbccdd');
  const { files } = buildDonation(db, sessionId);
  const dir = mkdtempSync(join(tmpdir(), 'tm-donate-out-'));
  writeDonation(dir, files);
  return {
    dir,
    source: loadEvents(db, {}),
    body: files.map((f) => f.body).join('\n'),
  };
}

/** Seed rows the way `collect` would: the real classifier, same as the adapter. */
function classifyish(e: UsageEvent): Activity {
  return classify(e);
}

test('donated fixture round-trips: same turns, tokens, errors, activities, fan-out', () => {
  const { dir, source } = donateToDisk();
  const { events } = collectClaudeCode(dir);

  const asStored = (e: (typeof events)[number]): StoredEvent => ({
    source: e.source, session_id: e.sessionId, project: e.project, ts: e.timestamp, model: e.model,
    input_tokens: e.inputTokens, output_tokens: e.outputTokens, cache_read_tokens: e.cacheReadTokens,
    cache_creation_tokens: e.cacheCreationTokens, thinking_tokens: e.thinkingTokens,
    tools: JSON.stringify(e.tools), has_thinking: e.hasThinking ? 1 : 0, is_error: e.isError ? 1 : 0,
    activity: e.activity ?? 'conversation', is_sidechain: e.isSidechain ? 1 : 0,
    parent_session_id: e.parentSessionId ?? null, agent_type: e.agentType ?? null,
    cache_creation_1h_tokens: e.cacheCreation1hTokens ?? 0,
    tool_result_chars: e.toolResultChars ? JSON.stringify(e.toolResultChars) : null,
  });

  const before = computeMetrics(source);
  const after = computeMetrics(events.map(asStored));

  assert.equal(after.events, before.events);
  assert.equal(after.spendTokens, before.spendTokens);
  assert.equal(after.cacheReadTokens, before.cacheReadTokens);
  assert.equal(after.cacheCreationTokens, before.cacheCreationTokens);
  assert.equal(after.extendedCacheTokens, before.extendedCacheTokens);
  assert.equal(after.errorEvents, before.errorEvents);
  assert.equal(after.subagentSessions, before.subagentSessions);
  assert.equal(after.toolResultTokens, before.toolResultTokens);
  assert.equal(after.toolResultCarryTokens, before.toolResultCarryTokens);
  for (const a of ['coding', 'testing', 'shipping', 'exploration', 'thinking'] as const) {
    assert.equal(after.byActivity[a].events, before.byActivity[a].events, `activity ${a} changed`);
  }
});

test('donated fixture carries no project, branch, session id, MCP or agent-type name', () => {
  const { body } = donateToDisk();
  for (const secret of [
    'acme-billing',
    'feat/acme-invoice-export',
    'aabbccdd-1111-2222-3333-444455556666',
    'agent-run-xyz',
    'acme_warehouse',
    'acme-secret-auditor',
    'fix acme invoice rounding',
  ]) {
    assert.ok(!body.includes(secret), `donated fixture leaked "${secret}"`);
  }
  assert.ok(body.includes('/Users/dev/project-1'));
  // The MCP tool keeps its CLASS so the fixture re-classifies identically.
  assert.ok(body.includes('mcp__server-1__'));
});

test('timestamps are shifted to a fixed start with every gap preserved', () => {
  const { dir, source } = donateToDisk();
  const { events } = collectClaudeCode(dir);
  const gaps = (list: string[]) => {
    const t = list.map((s) => Date.parse(s)).sort((a, b) => a - b);
    return t.slice(1).map((v, i) => v - t[i]);
  };
  assert.deepEqual(gaps(events.map((e) => e.timestamp)), gaps(source.map((e) => e.ts)));
  const earliest = Math.min(...events.map((e) => Date.parse(e.timestamp)));
  assert.equal(new Date(earliest).toISOString(), '2026-01-01T09:00:00.000Z');
});

test('subagent runs land in their own files the adapter can key on', () => {
  const { dir } = donateToDisk();
  const sub = join(dir, '-Users-dev-project-1', 'session-1', 'subagents');
  const files = readdirSync(sub);
  assert.deepEqual(files, ['agent-1.jsonl']);
  const line = JSON.parse(readFileSync(join(sub, files[0]), 'utf8').split('\n')[0]);
  assert.equal(line.agentId, '1');
  assert.equal(line.isSidechain, true);
  // The run's TYPE is replaced: a custom agent can be named after anything.
  assert.equal(line.attributionAgent, 'general-purpose');
});

test('anonymizeTool keeps built-ins and numbers MCP servers stably', () => {
  const servers = new Map<string, number>();
  const tools = new Map<string, number>();
  assert.equal(anonymizeTool('Bash', servers, tools), 'Bash');
  // Unknown tools stay unknown (they classify as acting on the world)...
  assert.equal(anonymizeTool('mcp__alpha__refund_invoice', servers, tools), 'mcp__server-1__tool-1');
  // ...and tools the classifier recognizes keep their class, not their name.
  assert.equal(anonymizeTool('mcp__alpha__read_file', servers, tools), 'mcp__server-1__read_file');
  assert.equal(anonymizeTool('mcp__beta__write_file', servers, tools), 'mcp__server-2__write_file');
  assert.equal(anonymizeTool('mcp__alpha__refund_invoice', servers, tools), 'mcp__server-1__tool-1');
});

test('resolveSession refuses an ambiguous or unknown prefix', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'tm-donate-db2-'));
  const db = openDb(join(dbDir, 'db.sqlite'));
  insertEvents(db, [
    makeEvent({ sessionId: 'dupe-aaa', eventKey: 'k1' }),
    makeEvent({ sessionId: 'dupe-bbb', eventKey: 'k2' }),
    makeEvent({ sessionId: 'unique-1', eventKey: 'k3' }),
  ]);
  assert.equal(resolveSession(db, 'unique'), 'unique-1');
  assert.throws(() => resolveSession(db, 'dupe'), /matches 2 sessions/);
  assert.throws(() => resolveSession(db, 'nothing'), /no session id starts with/);
});
