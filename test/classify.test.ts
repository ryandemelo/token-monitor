import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';
import { makeEvent } from './helpers.js';

test('write tools classify as coding', () => {
  assert.equal(classify(makeEvent({ tools: ['Edit'] })), 'coding');
  assert.equal(classify(makeEvent({ tools: ['replace'] })), 'coding'); // gemini
  assert.equal(classify(makeEvent({ tools: ['apply_patch'] })), 'coding'); // codex
});

test('test-runner commands classify as testing, beating write tools? no — commands win', () => {
  assert.equal(
    classify(makeEvent({ tools: ['Bash'], commands: ['pytest -q tests/'] })),
    'testing',
  );
  assert.equal(
    classify(makeEvent({ tools: ['run_shell_command'], commands: ['npm test'] })),
    'testing',
  );
});

test('git commit/push/pr commands classify as shipping', () => {
  assert.equal(classify(makeEvent({ tools: ['Bash'], commands: ['git commit -m "x"'] })), 'shipping');
  assert.equal(classify(makeEvent({ tools: ['Bash'], commands: ['gh pr create'] })), 'shipping');
});

test('shipping beats testing in mixed command turns', () => {
  assert.equal(
    classify(makeEvent({ tools: ['Bash'], commands: ['npm test && git push'] })),
    'shipping',
  );
});

test('read-only tools classify as exploration', () => {
  assert.equal(classify(makeEvent({ tools: ['Read', 'Grep', 'Glob'] })), 'exploration');
  assert.equal(classify(makeEvent({ tools: ['read_file', 'google_web_search'] })), 'exploration');
  assert.equal(classify(makeEvent({ tools: ['Bash'], commands: ['ls -la'] })), 'exploration');
});

test('plan tools classify as thinking', () => {
  assert.equal(classify(makeEvent({ tools: ['ExitPlanMode'] })), 'thinking');
  assert.equal(classify(makeEvent({ tools: ['TodoWrite'] })), 'thinking');
});

test('tool-less turns: thinking if reasoning present, else conversation', () => {
  assert.equal(classify(makeEvent({ hasThinking: true })), 'thinking');
  assert.equal(classify(makeEvent({ thinkingTokens: 50 })), 'thinking');
  assert.equal(classify(makeEvent({})), 'conversation');
});

test('mcp-prefixed tool names are normalized', () => {
  assert.equal(classify(makeEvent({ tools: ['mcp__some_server__read_file'] })), 'exploration');
});

test('interactive prompt tools classify as conversation', () => {
  assert.equal(classify(makeEvent({ tools: ['AskUserQuestion'] })), 'conversation');
});
