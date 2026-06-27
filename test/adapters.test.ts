import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { collectClaudeCode } from '../src/adapters/claude-code.js';
import { collectGeminiCli } from '../src/adapters/gemini-cli.js';
import { collectCodex } from '../src/adapters/codex.js';
import { collectCursor } from '../src/adapters/cursor.js';
import { collectAntigravity } from '../src/adapters/antigravity.js';
import { collectCopilot } from '../src/adapters/copilot.js';
import { makeCursorFixture, makeAntigravityFixture } from './helpers.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// dist/test/ -> repo root -> test/fixtures
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

test('claude-code adapter parses turns, links tool errors, classifies', () => {
  const { events } = collectClaudeCode(join(FIXTURES, 'claude'));
  assert.equal(events.length, 3);

  const [e1, e2, e3] = events;
  assert.equal(e1.eventKey, 'u1');
  assert.equal(e1.project, 'proj-alpha');
  assert.equal(e1.gitBranch, 'main');
  assert.equal(e1.model, 'claude-opus-4-7');
  assert.equal(e1.inputTokens, 100);
  assert.equal(e1.outputTokens, 200);
  assert.equal(e1.cacheReadTokens, 1000);
  assert.equal(e1.cacheCreationTokens, 50);
  assert.equal(e1.activity, 'testing'); // pytest command
  assert.equal(e1.isError, true); // linked from the tool_result line

  assert.equal(e2.activity, 'thinking');
  assert.equal(e2.hasThinking, true);
  assert.equal(e2.isError, false);

  // user-declined prompt: an is_error tool_result, but a choice — not a failure
  assert.equal(e3.eventKey, 'u3');
  assert.equal(e3.activity, 'conversation'); // AskUserQuestion is interactive
  assert.equal(e3.isError, false);
});

test('gemini-cli adapter parses checkpoints incl. thoughts and tool errors', () => {
  const { events } = collectGeminiCli(join(FIXTURES, 'gemini'));
  assert.equal(events.length, 2);

  const [m1, m2] = events;
  assert.equal(m1.eventKey, 'g1:m1');
  assert.equal(m1.project, 'proj-g');
  assert.equal(m1.model, 'gemini-3-flash-preview');
  assert.equal(m1.inputTokens, 50);
  assert.equal(m1.outputTokens, 13); // output + tool tokens
  assert.equal(m1.cacheReadTokens, 5);
  assert.equal(m1.thinkingTokens, 7);
  assert.equal(m1.activity, 'coding'); // replace tool

  assert.equal(m2.activity, 'shipping'); // git commit command
  assert.equal(m2.isError, true); // failed tool call

  // User-turn prompt carries forward to the assistant turns it triggered.
  assert.equal(m1.intentText, 'refactor the database connection pooling logic');
  assert.equal(m2.intentText, 'refactor the database connection pooling logic');
});

test('codex adapter diffs cumulative token counts into per-turn events', () => {
  const { events, result } = collectCodex(join(FIXTURES, 'codex'));
  assert.equal(events.length, 2);
  assert.ok(result.note?.includes('experimental'));

  const [t1, t2] = events;
  assert.equal(t1.sessionId, 'sess-c1');
  assert.equal(t1.project, 'proj-c');
  assert.equal(t1.model, 'gpt-5-codex');
  assert.equal(t1.inputTokens, 80); // 100 - 20 cached
  assert.equal(t1.cacheReadTokens, 20);
  assert.equal(t1.outputTokens, 50);
  assert.equal(t1.thinkingTokens, 10);
  assert.deepEqual(t1.commands, ['pytest -q']);
  assert.equal(t1.activity, 'testing');

  assert.equal(t2.inputTokens, 180); // (300-100) - (40-20)
  assert.equal(t2.cacheReadTokens, 20);
  assert.equal(t2.outputTokens, 70);
  assert.equal(t2.thinkingTokens, 5);
  assert.equal(t2.activity, 'coding'); // apply_patch

  // User message carries forward to the turns it triggered.
  assert.equal(t1.intentText, 'run the failing tests and patch the bug');
  assert.equal(t2.intentText, 'run the failing tests and patch the bug');
});

test('antigravity adapter decodes gen_metadata blobs and attributes tool steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-antigravity-fixture-'));
  makeAntigravityFixture(root);
  const { events, result } = collectAntigravity(root);

  assert.equal(result.filesScanned, 1);
  assert.equal(events.length, 3);
  const [g0, g1, g2] = events;

  assert.equal(g0.eventKey, 'conv-1:0');
  assert.equal(g0.sessionId, 'conv-1');
  assert.equal(g0.project, 'proj-anti'); // trajectory_metadata_blob workspace URI
  assert.equal(g0.gitBranch, 'feat/x');
  assert.equal(g0.model, 'gemini-3-flash-a');
  assert.equal(g0.inputTokens, 1000);
  assert.equal(g0.outputTokens, 50);
  assert.equal(g0.cacheReadTokens, 0); // f5 absent = 0
  assert.equal(g0.timestamp, new Date(1780000000500).toISOString());
  assert.deepEqual(g0.tools, ['view_file']); // steps between this and next gen snapshot
  assert.equal(g0.activity, 'exploration');
  assert.equal(g0.isError, false);

  assert.equal(g1.inputTokens, 1500);
  assert.equal(g1.cacheReadTokens, 2000);
  assert.deepEqual(g1.commands, ['npm test']);
  assert.equal(g1.activity, 'testing');
  assert.equal(g1.isError, true); // run_command failed with "exit status 1"

  assert.equal(g2.model, 'Claude Sonnet'); // f21 display-name fallback
  assert.equal(g2.isError, false); // "context canceled" is a user choice, not a failure
  assert.equal(g2.activity, 'exploration'); // bare shell command

  // Privacy: no conversation text in output.
  assert.ok(!JSON.stringify(events).includes('long trace'));
});

test('cursor adapter emits turn-final token events, maps workspaces, skips aborted turns', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'tm-cursor-fixture-'));
  makeCursorFixture(userDir);
  const { events, result } = collectCursor(userDir);

  assert.equal(events.length, 2); // c2 aborted -> nothing
  const [t1, t2] = events;
  assert.equal(t1.eventKey, 'c1:b4');
  assert.equal(t1.sessionId, 'c1');
  assert.equal(t1.project, 'proj-cur'); // via workspaceStorage join
  assert.equal(t1.model, 'cursor-auto'); // "default" = Auto mode, backend model not persisted
  assert.equal(t1.inputTokens, 1200);
  assert.equal(t1.outputTokens, 300);
  assert.equal(t1.timestamp, '2026-06-01T10:01:00.000Z');
  assert.deepEqual(t1.tools, ['read_file', 'run_terminal_cmd']);
  assert.deepEqual(t1.commands, ['pytest -q']);
  assert.equal(t1.activity, 'testing');
  assert.equal(t1.isError, false);

  assert.equal(t2.eventKey, 'c1:b7');
  assert.equal(t2.activity, 'coding'); // edit_file
  assert.equal(t2.isError, true); // errored tool linked to its turn

  // Each turn-final event inherits the user prompt of its type-1 bubble.
  assert.equal(t1.intentText, 'add retry with backoff to the http client');
  assert.equal(t2.intentText, 'fix the failing authentication unit test');

  // The auth canary in ItemTable must never appear in adapter output.
  assert.ok(!JSON.stringify({ events, result }).includes('AUTH-CANARY'));
  assert.ok(result.note?.includes('completed turns'));
});

test('copilot adapter estimates tokens from text, parses json and jsonl sessions', () => {
  const { events, result } = collectCopilot(join(FIXTURES, 'copilot'));

  assert.equal(result.filesScanned, 3);
  assert.equal(events.length, 3); // empty stub session yields nothing
  assert.ok(result.note?.includes('EXPERIMENTAL'));
  const [r1, r2, s2] = events;

  assert.equal(r1.eventKey, 'cop-s1:r1');
  assert.equal(r1.project, 'proj-cop1');
  assert.equal(r1.model, 'copilot/gpt-4.1 (est)');
  assert.equal(r1.timestamp, new Date(1780000050000).toISOString());
  assert.equal(r1.inputTokens, Math.ceil('Fix the failing test in utils.spec.ts'.length / 4));
  assert.equal(r1.outputTokens, Math.ceil('The test fails because the fixture date is wrong. Updated it.'.length / 4));
  assert.deepEqual(r1.tools, ['copilot_runInTerminal']);
  assert.deepEqual(r1.commands, ['npm test']);
  assert.equal(r1.activity, 'testing');
  assert.equal(r1.isError, false);
  assert.equal(r1.intentText, 'Fix the failing test in utils.spec.ts'); // request message text

  assert.equal(r2.isError, true); // errorDetails without cancellation
  assert.equal(r2.activity, 'conversation');
  assert.equal(r2.model, 'copilot (est)'); // no modelId on the request

  // .jsonl: line 0 snapshot parsed, later ops ignored
  assert.equal(s2.sessionId, 'cop-s2');
  assert.equal(s2.project, 'proj-cop2');
  assert.equal(s2.timestamp, new Date(1780000200000).toISOString());
});

test('adapters tolerate non-array (string/object) user-content shapes without throwing', () => {
  // Local logs are untyped JSON: a user message `content` can be a plain string
  // (Responses-style) or, for Copilot, a non-string `text`. None may crash the
  // collector — adapters must fail soft. Regression guard for the PR2 fan-out.
  const dir = mkdtempSync(join(tmpdir(), 'tm-shape-'));

  // gemini: user content is a plain string
  const gchats = join(dir, 'gemini', 'h1', 'chats');
  mkdirSync(gchats, { recursive: true });
  writeFileSync(join(gchats, 'session-x.json'), JSON.stringify({
    sessionId: 'gx',
    messages: [
      { id: 'u', type: 'user', content: 'please refactor the connection pooling logic' },
      { id: 'a', type: 'gemini', timestamp: '2026-06-01T00:00:00.000Z', model: 'gemini', tokens: { input: 10, output: 5 } },
    ],
  }));
  const g = collectGeminiCli(join(dir, 'gemini'));
  assert.equal(g.events.length, 1);
  assert.equal(g.events[0].intentText, 'please refactor the connection pooling logic');

  // codex: user content is a plain string
  const cdir = join(dir, 'codex', '2026', '06', '01');
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'rollout-x.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'cx', cwd: '/p' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'run the failing tests' } }),
    JSON.stringify({ timestamp: '2026-06-01T00:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } } }),
  ].join('\n') + '\n');
  const c = collectCodex(join(dir, 'codex'));
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].intentText, 'run the failing tests');

  // copilot: message.text is a non-string object -> empty intent, no NaN tokens
  const wsDir = join(dir, 'code', 'workspaceStorage', 'w1');
  const sessDir = join(wsDir, 'chatSessions');
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///home/u/proj-x' }));
  writeFileSync(join(sessDir, 's.json'), JSON.stringify({
    sessionId: 'cs',
    requests: [{ requestId: 'r', message: { text: { weird: true } }, response: [{ value: 'ok' }] }],
  }));
  const cop = collectCopilot(join(dir, 'code'));
  assert.equal(cop.events.length, 1);
  assert.equal(cop.events[0].intentText, undefined);
  assert.ok(!Number.isNaN(cop.events[0].inputTokens), 'object text must not yield NaN tokens');
});

test('adapters return a note instead of throwing when logs are absent', () => {
  for (const collect of [collectClaudeCode, collectGeminiCli, collectCodex, collectCursor, collectAntigravity, collectCopilot]) {
    const { events, result } = collect('/nonexistent/path/xyz');
    assert.equal(events.length, 0);
    assert.ok(result.note);
  }
});

test('isDeclination matches harness rejection phrasings, not real errors', async () => {
  const { isDeclination } = await import('../src/adapters/claude-code.js');
  assert.equal(isDeclination("The user doesn't want to proceed with this tool use. The tool use was rejected."), true);
  assert.equal(isDeclination('Request interrupted by user'), true);
  assert.equal(isDeclination([{ type: 'text', text: 'The user rejected the edit' }]), true);
  assert.equal(isDeclination('<tool_use_error>InputValidationError: too_big</tool_use_error>'), false);
  assert.equal(isDeclination('Error: ENOENT no such file'), false);
});
