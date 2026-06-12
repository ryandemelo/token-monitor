import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, fetchReport, renderDashboard, statusText, formatTokens, formatCost } from '../src/bridge';

/**
 * End-to-end over the extension's data path: the bridge spawns the REAL CLI
 * (built at the repo root) against a synthetic HOME seeded with the repo's
 * claude fixtures — exactly what the extension does at runtime, minus the
 * VS Code UI shell.
 */

// dist/test -> extension -> repo root
const ROOT = join(dirname(__dirname), '..', '..');
const COMMAND = `${process.execPath} ${join(ROOT, 'dist', 'src', 'cli.js')}`;

const HOME = mkdtempSync(join(tmpdir(), 'tm-ext-e2e-'));
cpSync(join(ROOT, 'test', 'fixtures', 'claude'), join(HOME, '.claude', 'projects'), { recursive: true });
const ENV = { ...process.env, HOME, USERPROFILE: HOME, APPDATA: join(HOME, 'AppData', 'Roaming') };

test('e2e: collect then report --json through the bridge', async () => {
  const out = await collect(COMMAND, ENV);
  assert.match(out, /claude-code\s+\d+ files\s+3 turns\s+3 new/);

  const report = await fetchReport(COMMAND, 36500, ENV);
  assert.equal(report.overall.events, 3);
  assert.ok(report.byProject['proj-alpha']);
  assert.ok(report.overall.spendTokens > 0);
});

test('e2e: dashboard html renders self-contained through the bridge', async () => {
  const html = await renderDashboard(COMMAND, 36500, ENV);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('proj-alpha'));
});

test('bridge surfaces CLI failures as errors, not crashes', async () => {
  await assert.rejects(
    () => fetchReport(`${process.execPath} /nonexistent/cli.js`, 30, ENV),
    /token-monitor CLI failed/,
  );
});

test('status text picks the project slice, falls back to overall', async () => {
  const report = await fetchReport(COMMAND, 36500, ENV);
  const projText = statusText(report, 'proj-alpha');
  const overallText = statusText(report, 'no-such-project');
  assert.match(projText, /·/);
  assert.equal(overallText, statusText(report, undefined));
});

test('formatters', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(formatTokens(3_400_000_000), '3.4B');
  assert.equal(
    formatCost({ costUsd: 12.345, costEstimated: true, costUnpricedTokens: 5, events: 0, sessions: 0, spendTokens: 0, cacheHitRatio: 0, reworkRatio: 0 }),
    '~$12.35+',
  );
  assert.equal(
    formatCost({ costUsd: 250, costEstimated: false, costUnpricedTokens: 0, events: 0, sessions: 0, spendTokens: 0, cacheHitRatio: 0, reworkRatio: 0 }),
    '$250',
  );
});
