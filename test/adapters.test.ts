import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { collectClaudeCode } from '../src/adapters/claude-code.js';
import { collectGeminiCli } from '../src/adapters/gemini-cli.js';
import { collectCodex } from '../src/adapters/codex.js';
import { collectCursor } from '../src/adapters/cursor.js';
import { makeCursorFixture } from './helpers.js';
import { mkdtempSync } from 'node:fs';
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

  // The auth canary in ItemTable must never appear in adapter output.
  assert.ok(!JSON.stringify({ events, result }).includes('AUTH-CANARY'));
  assert.ok(result.note?.includes('completed turns'));
});

test('adapters return a note instead of throwing when logs are absent', () => {
  for (const collect of [collectClaudeCode, collectGeminiCli, collectCodex, collectCursor]) {
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
