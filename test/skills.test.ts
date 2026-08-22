import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  skillTokens, autoLinks, loadSkillMap, summarizeUsage, computeRoi,
  ROI_MIN_BEFORE_SESSIONS,
} from '../src/skills.js';
import { openDb, recordSessionSkills, loadSessionSkills } from '../src/store.js';
import { collectClaudeCode } from '../src/adapters/claude-code.js';
import { buildExport } from '../src/team.js';
import { renderSkillAdoption } from '../src/report.js';
import { makeStored } from './helpers.js';
import type { CategoryRow } from '../src/categorize.js';
import type { SkillUsage } from '../src/skills.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const NOW = Date.parse('2026-06-30T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test('skillTokens drops the plugin prefix, short tokens, and generic words', () => {
  assert.deepEqual(skillTokens('caveman:caveman'), ['caveman']);
  assert.deepEqual(skillTokens('invoice-reconciler'), ['invoice', 'reconciler']);
  // "code" and "review" are both too generic to link on — this is the exact
  // pair that produced false four-figure claims against real data.
  assert.deepEqual(skillTokens('code-review'), []);
});

test('autoLinks needs two distinctive tokens, or one exact single-token match', () => {
  assert.equal(autoLinks('invoice-reconciler', ['invoice', 'reconciler', 'ledger']), true);
  assert.equal(autoLinks('invoice-reconciler', ['invoice', 'ledger']), false, 'one hit is not enough');
  assert.equal(autoLinks('caveman:caveman', ['caveman', 'ultra']), true);
  assert.equal(autoLinks('caveman:caveman', ['ultra', 'wenyan']), false);
  assert.equal(autoLinks('code-review', ['code', 'merge', 'review']), false, 'generic-only skills never link');
});

test('the skill map is optional, lowercased, and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-skillmap-'));
  assert.deepEqual(loadSkillMap(join(dir, 'missing.json')), {});
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{oops');
  assert.deepEqual(loadSkillMap(bad), {});
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ 'API Auth JWT': 'auth-helper', ignored: 42 }));
  assert.deepEqual(loadSkillMap(good), { 'api auth jwt': 'auth-helper' });
});

test('usage aggregates turns and sessions, and flags skills unused in the window', () => {
  const rows = [
    { source: 'claude-code', session_id: 's1', skill: 'alpha', turns: 10, first_ts: daysAgo(20), last_ts: daysAgo(2) },
    { source: 'claude-code', session_id: 's2', skill: 'alpha', turns: 5, first_ts: daysAgo(3), last_ts: daysAgo(1) },
    { source: 'claude-code', session_id: 's3', skill: 'stale', turns: 7, first_ts: daysAgo(90), last_ts: daysAgo(60) },
  ];
  const usage = summarizeUsage(rows, daysAgo(30));
  assert.equal(usage.length, 2);
  const alpha = usage.find((u) => u.skill === 'alpha')!;
  assert.equal(alpha.turns, 15);
  assert.equal(alpha.sessions, 2);
  assert.equal(alpha.dormant, false);
  assert.equal(usage.find((u) => u.skill === 'stale')!.dormant, true);
});

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 'c1', name: 'invoice reconciler ledger', terms: ['invoice', 'reconciler', 'ledger'],
    sessions: 8, projects: ['p'], tokens: 100_000, cost: 80, estimated: false,
    hasText: true, duplicate: false, ...overrides,
  };
}

function usageFor(skill: string, opts: { firstSeen: string; dormant?: boolean }): SkillUsage[] {
  return [{ skill, turns: 40, sessions: 4, firstSeen: opts.firstSeen, lastSeen: opts.dormant ? daysAgo(40) : daysAgo(1), dormant: Boolean(opts.dormant) }];
}

/** 5 sessions in the first half of a 60-day window, 1 in the second. */
const DROPPING_DATES = [daysAgo(58), daysAgo(55), daysAgo(50), daysAgo(45), daysAgo(40), daysAgo(5)];
const roiOpts = { windowStart: daysAgo(60), windowEnd: new Date(NOW).toISOString() };

test('a mapped link with a real drop and the skill in use realizes a figure', () => {
  const rows = computeRoi(
    [category()],
    new Map([['c1', DROPPING_DATES]]),
    usageFor('auth-helper', { firstSeen: daysAgo(30) }),
    { ...roiOpts, map: { 'invoice reconciler ledger': 'auth-helper' } },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].link, 'map');
  assert.equal(rows[0].status, 'realized');
  assert.ok(rows[0].realizedUsdPerMonth! > 0);
  assert.ok(rows[0].beforePer30 > rows[0].afterPer30);
  assert.equal(rows[0].estimated, true);
});

test('an automatic link is a candidate: numbers yes, dollar claim never', () => {
  const rows = computeRoi(
    [category()],
    new Map([['c1', DROPPING_DATES]]),
    usageFor('invoice-reconciler', { firstSeen: daysAgo(30) }),
    roiOpts,
  );
  assert.equal(rows[0].link, 'terms');
  assert.equal(rows[0].status, 'tracking');
  assert.equal(rows[0].realizedUsdPerMonth, undefined);
  assert.ok(rows[0].beforePer30 > 0);
});

test('a mapped link claims nothing when the skill went unused in the window', () => {
  const rows = computeRoi(
    [category()],
    new Map([['c1', DROPPING_DATES]]),
    usageFor('auth-helper', { firstSeen: daysAgo(30), dormant: true }),
    { ...roiOpts, map: { 'invoice reconciler ledger': 'auth-helper' } },
  );
  assert.equal(rows[0].status, 'tracking');
  assert.equal(rows[0].realizedUsdPerMonth, undefined);
});

test('too few sessions before the skill is history, not evidence', () => {
  const thin = [daysAgo(50), daysAgo(45), daysAgo(5)]; // 2 before the split
  assert.ok(ROI_MIN_BEFORE_SESSIONS > 2);
  const rows = computeRoi(
    [category()],
    new Map([['c1', thin]]),
    usageFor('auth-helper', { firstSeen: daysAgo(30) }),
    { ...roiOpts, map: { 'invoice reconciler ledger': 'auth-helper' } },
  );
  assert.equal(rows[0].status, 'insufficient-history');
  assert.equal(rows[0].realizedUsdPerMonth, undefined);
});

test('recurrence that did not fall is reported as no change', () => {
  const rising = [daysAgo(55), daysAgo(50), daysAgo(45), daysAgo(10), daysAgo(8), daysAgo(6), daysAgo(4), daysAgo(2)];
  const rows = computeRoi(
    [category()],
    new Map([['c1', rising]]),
    usageFor('auth-helper', { firstSeen: daysAgo(30) }),
    { ...roiOpts, map: { 'invoice reconciler ledger': 'auth-helper' } },
  );
  assert.equal(rows[0].status, 'no-change');
});

test('a skill that predates the window cannot be split, and says so', () => {
  const rows = computeRoi(
    [category()],
    new Map([['c1', DROPPING_DATES]]),
    usageFor('auth-helper', { firstSeen: daysAgo(59) }), // under a week of "before"
    { ...roiOpts, map: { 'invoice reconciler ledger': 'auth-helper' } },
  );
  assert.equal(rows[0].status, 'insufficient-history');
});

test('skill rows upsert to the widest span and highest turn count', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tm-skills-')), 'db.sqlite'));
  const row = { source: 'claude-code', session_id: 's1', skill: 'alpha', turns: 5, first_ts: daysAgo(10), last_ts: daysAgo(9) };
  recordSessionSkills(db, [row]);
  recordSessionSkills(db, [{ ...row, turns: 9, first_ts: daysAgo(12), last_ts: daysAgo(2) }]);
  recordSessionSkills(db, [{ ...row, turns: 3, first_ts: daysAgo(11), last_ts: daysAgo(8) }]);
  const [stored] = loadSessionSkills(db);
  assert.equal(stored.turns, 9);
  assert.equal(stored.first_ts, daysAgo(12));
  assert.equal(stored.last_ts, daysAgo(2));
  assert.equal(loadSessionSkills(db, 1).length, 0, 'the days filter bounds by last use');
});

test('the adapter attributes turns to skills, and exports never carry the name', () => {
  const { events } = collectClaudeCode(join(FIXTURES, 'claude-results'));
  const attributed = events.filter((e) => e.skill === 'acme-onboarding');
  assert.equal(attributed.length, 2);
  assert.equal(events.filter((e) => e.skill === undefined).length, 1);

  const stored = events.map((e) => makeStored({ session_id: e.sessionId, ts: e.timestamp }));
  assert.ok(!JSON.stringify(buildExport(stored, 30)).includes('acme-onboarding'));
});

test('renderSkillAdoption shows adoption, dormancy, and the candidate caveat', () => {
  const out = renderSkillAdoption({
    days: 30, totalSessions: 3, textSessions: 3, categories: [], duplicates: [], skillCandidates: [],
    skills: {
      unmeasured: false,
      usage: [
        { skill: 'auth-helper', turns: 40, sessions: 4, firstSeen: daysAgo(20), lastSeen: daysAgo(1), dormant: false },
        { skill: 'old-thing', turns: 5, sessions: 1, firstSeen: daysAgo(90), lastSeen: daysAgo(60), dormant: true },
      ],
      roi: [{ skill: 'auth-helper', category: 'invoice ledger', link: 'terms', beforePer30: 3, afterPer30: 1, estimated: true, status: 'tracking' }],
    },
  }).join('\n');
  assert.match(out, /auth-helper/);
  assert.match(out, /1 skill\(s\) used historically but not once in this window/);
  assert.match(out, /old-thing/);
  assert.match(out, /CANDIDATES/);
  assert.match(out, /Turns, not invocations/);
});

test('nothing is rendered when no source records skills', () => {
  const out = renderSkillAdoption({
    days: 30, totalSessions: 0, textSessions: 0, categories: [], duplicates: [], skillCandidates: [],
    skills: { usage: [], roi: [], unmeasured: true },
  });
  assert.deepEqual(out, []);
});
