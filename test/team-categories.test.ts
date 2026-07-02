import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeCategories } from '../src/team-categories.js';
import type { ExportV1, ExportCategory, SignedExport } from '../src/team.js';
import { signObject } from '../src/sign.js';
import { computeMetrics } from '../src/metrics.js';
import { makeStored } from './helpers.js';

const cat = (p: Partial<ExportCategory>): ExportCategory => ({
  id: 'c1', name: 'payment retry', terms: ['payment', 'retry', 'backoff'], sessions: 2,
  projects: ['shop'], tokens: 1000, cost: 5, estimated: false, duplicate: false, ...p,
});

function makeExport(user: string, host: string, categories: ExportCategory[] | undefined): SignedExport {
  const ex: ExportV1 = {
    version: 1, user, host, generatedAt: '2026-06-01T00:00:00.000Z', days: 30,
    overall: computeMetrics([makeStored({ session_id: `${user}-s` })]),
    byProject: {},
    ...(categories ? { categories, categorizeDays: 30 } : {}),
  };
  return ex;
}

test('same task by two people clusters into one cross-user duplicate', () => {
  const alice = makeExport('alice', 'h1', [cat({ id: 'a1', terms: ['payment', 'retry', 'backoff'], cost: 5, sessions: 2 })]);
  const bob = makeExport('bob', 'h2', [cat({ id: 'b1', terms: ['retry', 'backoff', 'payment', 'client'], cost: 3, sessions: 1, estimated: true, projects: ['store'] })]);
  const mc = mergeCategories([bob, alice]); // order must not matter

  assert.equal(mc.withCategories, 2);
  assert.equal(mc.crossUserDuplicates.length, 1);
  const d = mc.crossUserDuplicates[0];
  assert.equal(d.crossUser, true);
  assert.equal(d.userCount, 2);
  assert.deepEqual(d.users, ['alice (unsigned)', 'bob (unsigned)']); // sorted, flagged
  assert.equal(d.sessions, 3);
  assert.equal(d.cost, 8);
  assert.equal(d.estimated, true); // ORed
  assert.equal(d.score, 6); // sessions x userCount
  assert.deepEqual(d.projects, ['shop', 'store']);
  assert.equal(mc.anyUnsigned, true);
});

test('one person recurring is a skill candidate, never a cross-user accusation', () => {
  const solo = makeExport('alice', 'h1', [cat({ id: 'a1', sessions: 4 })]);
  const mc = mergeCategories([solo]);
  assert.equal(mc.crossUserDuplicates.length, 0);
  assert.equal(mc.orgSkillCandidates.length, 1);
  assert.equal(mc.orgSkillCandidates[0].crossUser, false);
});

test('same unsigned user on two hosts counts as two identities — pinned, flagged', () => {
  // Documented behavior: without signatures we CANNOT know it is one human,
  // so it counts as 2 but every users entry carries the (unsigned) caveat.
  const m1 = makeExport('ryan', 'laptop', [cat({ id: 'r1' })]);
  const m2 = makeExport('ryan', 'desktop', [cat({ id: 'r2' })]);
  const mc = mergeCategories([m1, m2]);
  assert.equal(mc.crossUserDuplicates.length, 1);
  assert.equal(mc.crossUserDuplicates[0].userCount, 2);
  assert.deepEqual(mc.crossUserDuplicates[0].users, ['ryan (unsigned)']);
  assert.equal(mc.anyUnsigned, true);
});

test('signed exports use the keyring name and drop the unsigned flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-tc-keys-'));
  const signed = signObject(
    makeExport('alice', 'h1', [cat({ id: 'a1' })]) as unknown as Record<string, unknown>,
    dir,
  ) as unknown as SignedExport;
  const mc = mergeCategories([signed, makeExport('bob', 'h2', [cat({ id: 'b1' })])]);
  assert.equal(mc.crossUserDuplicates[0].userCount, 2);
  assert.ok(mc.crossUserDuplicates[0].users.includes('alice'));
  assert.ok(mc.crossUserDuplicates[0].users.includes('bob (unsigned)'));
});

test('malformed hand-built categories are skipped, never crash the merge', () => {
  const hostile = makeExport('mallory', 'h9', [
    cat({ id: 'ok1' }),
    { id: 'bad1', terms: [] } as unknown as ExportCategory,
    { id: 'bad2', terms: [7, null] } as unknown as ExportCategory,
    { name: 'no-id' } as unknown as ExportCategory,
    null as unknown as ExportCategory,
  ]);
  const mc = mergeCategories([hostile]);
  assert.equal(mc.withCategories, 1);
  assert.equal(mc.categories.length, 1); // only the usable row survives
});

test('threshold gates weak matches; shuffled input yields identical output', () => {
  const a = makeExport('alice', 'h1', [cat({ id: 'a1', terms: ['payment', 'retry', 'backoff', 'stripe'] })]);
  const b = makeExport('bob', 'h2', [cat({ id: 'b1', terms: ['retry', 'docs', 'readme', 'typo'] })]);
  const loose = mergeCategories([a, b], { threshold: 0.1 });
  const strict = mergeCategories([a, b], { threshold: 0.9 });
  assert.equal(loose.crossUserDuplicates.length, 1); // single shared term links at 0.1
  assert.equal(strict.crossUserDuplicates.length, 0);

  const c = makeExport('carol', 'h3', [cat({ id: 'c1', terms: ['payment', 'retry', 'backoff'] })]);
  const one = mergeCategories([a, b, c]);
  const two = mergeCategories([c, a, b]);
  assert.deepEqual(one, two);
});

test('pre-0.11 exports merge as metrics-only; coverage counts category-bearing ones', () => {
  const legacy = makeExport('old-timer', 'h0', undefined);
  const modern = makeExport('alice', 'h1', [cat({ id: 'a1', duplicate: true, cost: 12 })]);
  const mc = mergeCategories([legacy, modern]);
  assert.equal(mc.withCategories, 1);
  assert.equal(mc.crossUserDuplicates.length, 0);
  // within-member tier: carried duplicate flags aggregate, never conflated with cross-user
  assert.equal(mc.withinMemberDupCost, 12);
  assert.equal(mc.withinMemberDupMembers, 1);
});
