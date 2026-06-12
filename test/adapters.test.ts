import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { collectClaudeCode } from '../src/adapters/claude-code.js';
import { collectGeminiCli } from '../src/adapters/gemini-cli.js';
import { collectCodex } from '../src/adapters/codex.js';
import { collectAntigravity } from '../src/adapters/antigravity.js';
import { makeAntigravityFixture } from './helpers.js';
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

test('adapters return a note instead of throwing when logs are absent', () => {
  for (const collect of [collectClaudeCode, collectGeminiCli, collectCodex, collectAntigravity]) {
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
