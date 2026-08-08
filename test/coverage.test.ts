import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCoverage, fmtCoverage, readRetentionDays, retentionNote, trendIsComparable,
  DEFAULT_RETENTION_DAYS,
} from '../src/coverage.js';
import { makeStored } from './helpers.js';

const NOW = Date.parse('2026-06-30T12:00:00Z');
const day = (d: string, source = 'claude-code') =>
  makeStored({ source: source as never, ts: `${d}T10:00:00.000Z` });

test('coverage counts active days, the largest internal gap, and staleness', () => {
  const [c] = computeCoverage(
    // 4 active days spanning the 10th to the 20th: an 6-day hole in the middle.
    [day('2026-06-10'), day('2026-06-11'), day('2026-06-18'), day('2026-06-20')],
    30, NOW,
  );
  assert.equal(c.source, 'claude-code');
  assert.equal(c.activeDays, 4);
  assert.equal(c.largestGapDays, 6); // 12th..17th inclusive
  assert.equal(c.first, '2026-06-10');
  assert.equal(c.last, '2026-06-20');
  assert.equal(c.staleDays, 10);
  assert.ok(Math.abs(c.ratio - 4 / 30) < 1e-9);
});

test('a duplicated day is one active day, and each source is measured separately', () => {
  const rows = computeCoverage(
    [day('2026-06-10'), day('2026-06-10'), day('2026-06-11'), day('2026-06-10', 'cursor')],
    30, NOW,
  );
  assert.deepEqual(rows.map((r) => [r.source, r.activeDays]), [['claude-code', 2], ['cursor', 1]]);
});

test('the coverage line flags gaps and staleness, and stays quiet when healthy', () => {
  const healthy = computeCoverage(
    Array.from({ length: 30 }, (_, i) => day(`2026-06-${String(i + 1).padStart(2, '0')}`)),
    30, Date.parse('2026-06-30T12:00:00Z'),
  );
  assert.equal(fmtCoverage(healthy), 'claude-code 30/30d');
  assert.match(fmtCoverage(computeCoverage([day('2026-06-01'), day('2026-06-20')], 30, NOW)), /⚠/);
  assert.equal(fmtCoverage([]), '');
});

test('retention note fires only when the record runs out where deletion would cut it', () => {
  const short = computeCoverage([day('2026-06-01'), day('2026-06-29')], 90, NOW);
  // Window reaches past retention and the record is ~30d long: consistent.
  assert.match(retentionNote(short, 90, 30, NOW), /likely deleted .* 30-day retention/);
  // Same data, but the window is inside retention — nothing to explain.
  assert.equal(retentionNote(short, 30, 30, NOW), '');
  // A user who collects regularly has a record far longer than retention.
  const long = computeCoverage([day('2025-06-01'), day('2026-06-29')], 400, NOW);
  assert.equal(retentionNote(long, 400, 30, NOW), '');
  // No claude-code data: we don't know the other tools' retention, so silent.
  assert.equal(retentionNote(computeCoverage([day('2026-06-01', 'cursor')], 90, NOW), 90, 30, NOW), '');
});

test('retention days read from settings.json, fail-soft to the documented default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-ret-'));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
  writeFileSync(join(dir, 'bad.json'), '{not json');
  writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ cleanupPeriodDays: 'soon' }));
  assert.equal(readRetentionDays(join(dir, 'ok.json')), 90);
  assert.equal(readRetentionDays(join(dir, 'bad.json')), DEFAULT_RETENTION_DAYS);
  assert.equal(readRetentionDays(join(dir, 'wrong.json')), DEFAULT_RETENTION_DAYS);
  assert.equal(readRetentionDays(join(dir, 'missing.json')), DEFAULT_RETENTION_DAYS);
});

test('trend arrows are suppressed when the previous window is far thinner', () => {
  const many = Array.from({ length: 10 }, (_, i) => day(`2026-06-${String(i + 10).padStart(2, '0')}`));
  const few = [day('2026-05-01')];
  assert.equal(trendIsComparable(many, few).comparable, false);
  assert.equal(trendIsComparable(many, many).comparable, true);
  // Exactly at the threshold (60%) still counts as comparable.
  assert.equal(trendIsComparable(many, many.slice(0, 6)).comparable, true);
  assert.equal(trendIsComparable(many, many.slice(0, 5)).comparable, false);
});
