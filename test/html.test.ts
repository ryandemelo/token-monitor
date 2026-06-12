import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../src/html.js';
import { makeStored } from './helpers.js';

test('renderHtml produces a self-contained document with key sections', () => {
  const html = renderHtml(
    [
      makeStored({ project: 'alpha', activity: 'coding', input_tokens: 1000, output_tokens: 500 }),
      makeStored({ project: 'alpha', activity: 'exploration', input_tokens: 200, output_tokens: 0 }),
    ],
    { days: 30 },
  );
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('alpha'));
  assert.ok(html.includes('Where the tokens go'));
  assert.ok(html.includes('claude-opus-4-7'));
  // self-contained: no external scripts or stylesheets
  assert.ok(!/<script\s+src|<link\s+rel="stylesheet"/.test(html));
});

test('renderHtml escapes project names', () => {
  const html = renderHtml(
    [makeStored({ project: '<img src=x onerror=alert(1)>', activity: 'coding' })],
    { days: 30 },
  );
  assert.ok(!html.includes('<img src=x'));
});
