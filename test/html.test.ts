import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml, renderCategorizeHtml } from '../src/html.js';
import { makeStored } from './helpers.js';
import type { FollowRow } from '../src/followthrough.js';
import type { CategorizeResult, CategoryRow } from '../src/categorize.js';

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

test('renderHtml surfaces the duplicate-work line only when a categorize summary is passed', () => {
  const ev = [makeStored({ activity: 'coding', input_tokens: 1000, output_tokens: 0 })];
  const without = renderHtml(ev, { days: 30 });
  assert.ok(!without.includes('🔁'));

  const withSummary = renderHtml(ev, {
    days: 30,
    categorize: { duplicateTasks: 3, duplicateSessions: 7, duplicateCost: 48.5, estimated: false },
  });
  assert.ok(withSummary.includes('🔁'));
  assert.ok(withSummary.includes('3 recurring tasks spanning ≥2 projects'));
  assert.ok(withSummary.includes('$48.50'));
});

const catRow = (p: Partial<CategoryRow>): CategoryRow => ({
  id: 'c', name: 'task', sessions: 1, projects: ['proj'], tokens: 1000, cost: 1, estimated: false, hasText: true, duplicate: false, ...p,
});

test('renderCategorizeHtml renders categories, duplicate work, and skill candidates', () => {
  const dup = catRow({ id: 'd1', name: 'jwt auth login', sessions: 3, projects: ['proj-a', 'proj-b'], tokens: 12000, cost: 4.2, duplicate: true });
  const solo = catRow({ id: 's1', name: 'css <flex>', sessions: 1, projects: ['proj-c'], tokens: 3000, cost: 1.1, estimated: true });
  const notext = catRow({ id: 'n1', name: 'coding edit', sessions: 2, projects: ['proj-d', 'proj-e'], tokens: 2000, cost: 0.5, hasText: false });
  const result: CategorizeResult = {
    days: 30, totalSessions: 6, textSessions: 4,
    categories: [dup, solo, notext], duplicates: [dup], skillCandidates: [dup],
  };
  const html = renderCategorizeHtml(result, 30);

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Task categories'));
  assert.ok(html.includes('jwt auth login'));
  assert.ok(html.includes('Duplicate work'));
  assert.ok(html.includes('proj-a, proj-b'), 'duplicate row names both projects');
  assert.ok(html.includes('Org-skill candidates'));
  assert.ok(html.includes('(no text)'), 'no-text category is marked');
  assert.ok(html.includes('raw prompt text is never stored'), 'privacy footnote present');
  // labels are HTML-escaped
  assert.ok(!html.includes('css <flex>'));
  assert.ok(html.includes('css &#60;flex&#62;'));
  // self-contained
  assert.ok(!/<script\s+src|<link\s+rel="stylesheet"/.test(html));
});

test('renderCategorizeHtml shows an empty state when there are no sessions', () => {
  const html = renderCategorizeHtml(
    { days: 30, totalSessions: 0, textSessions: 0, categories: [], duplicates: [], skillCandidates: [] },
    30,
  );
  assert.ok(html.includes('No sessions in range'));
});

test('renderHtml marks LLM-origin follow-through rows with a robot', () => {
  const follow: FollowRow[] = [{
    key: 'llm:cacheHitRatio', metric: 'cacheHitRatio', direction: 'up',
    baseline: 0.1, current: 0.1, createdAt: '2026-06-01', status: 'tracking', origin: 'llm',
  }];
  const html = renderHtml(
    [makeStored({ activity: 'coding', input_tokens: 1000, output_tokens: 0 })],
    { days: 30, follow },
  );
  assert.ok(html.includes('🤖'));
  assert.ok(html.includes('llm:cacheHitRatio'));
});
