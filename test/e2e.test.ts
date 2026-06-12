import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeCursorFixture, makeAntigravityFixture } from './helpers.js';
import { cursorUserDir } from '../src/adapters/cursor.js';
import { codeUserDir } from '../src/adapters/copilot.js';

/**
 * True end-to-end: runs the built CLI as a subprocess against a synthetic
 * $HOME containing fixture logs for all three adapters, exercising the full
 * collect -> report -> export -> verify -> merge -> html -> analyze pipeline
 * exactly as a user would.
 */

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/test
const CLI = join(HERE, '..', 'src', 'cli.js');
const FIXTURES = join(HERE, '..', '..', 'test', 'fixtures');

// One synthetic HOME shared by the sequential steps below.
const HOME = mkdtempSync(join(tmpdir(), 'tm-e2e-home-'));
cpSync(join(FIXTURES, 'claude'), join(HOME, '.claude', 'projects'), { recursive: true });
cpSync(join(FIXTURES, 'gemini'), join(HOME, '.gemini', 'tmp'), { recursive: true });
cpSync(join(FIXTURES, 'codex'), join(HOME, '.codex', 'sessions'), { recursive: true });
makeCursorFixture(cursorUserDir(HOME));
makeAntigravityFixture(join(HOME, '.gemini', 'antigravity-cli'));
cpSync(join(FIXTURES, 'copilot'), codeUserDir(HOME), { recursive: true });

function run(args: string[], opts: { home?: string } = {}) {
  const home = opts.home ?? HOME;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    // APPDATA keeps win32 path resolution inside the synthetic home too.
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

// Fixture windows are dated 2026-06-01; keep a generous window.
const DAYS = ['--days', '36500'];

test('e2e: collect parses all sources into the default db', () => {
  const { stdout, code } = run(['collect']);
  assert.equal(code, 0);
  assert.match(stdout, /claude-code\s+\d+ files\s+3 turns\s+3 new/);
  assert.match(stdout, /gemini-cli\s+\d+ files\s+2 turns\s+2 new/);
  assert.match(stdout, /codex\s+\d+ files\s+2 turns\s+2 new/);
  assert.match(stdout, /cursor\s+\d+ files\s+2 turns\s+2 new/);
  assert.match(stdout, /antigravity\s+\d+ files\s+3 turns\s+3 new/);
  assert.match(stdout, /copilot\s+\d+ files\s+3 turns\s+3 new/);
  assert.ok(existsSync(join(HOME, '.token-monitor', 'token-monitor.sqlite')));
});

test('e2e: collect is idempotent', () => {
  const { stdout, code } = run(['collect']);
  assert.equal(code, 0);
  assert.match(stdout, /claude-code\s+\d+ files\s+3 turns\s+0 new/);
});

test('e2e: report renders all sections from collected data', () => {
  const { stdout, code } = run(['report', ...DAYS]);
  assert.equal(code, 0);
  for (const expected of ['Where the tokens go', 'By project', 'By model', 'Recommendations', 'proj-alpha', 'proj-g', 'proj-c', 'proj-cur', 'proj-anti', 'proj-cop1', 'gpt-5-codex']) {
    assert.ok(stdout.includes(expected), `report missing "${expected}"`);
  }
});

test('e2e: report --json emits a signed v1 export; fingerprint command matches it', () => {
  const exportJson = run(['report', '--json', ...DAYS]).stdout;
  const data = JSON.parse(exportJson);
  assert.equal(data.version, 1);
  assert.equal(data.overall.events, 15); // 3 claude + 2 gemini + 2 codex + 2 cursor + 3 antigravity + 3 copilot
  assert.equal(data.sig.alg, 'ed25519');

  const fp = run(['fingerprint']).stdout.trim();
  assert.match(fp, /^[0-9a-f]{16}$/);

  writeFileSync(join(HOME, 'me.json'), exportJson);
  const verify = run(['merge', join(HOME, 'me.json'), '--verify']);
  assert.equal(verify.code, 0);
  assert.ok(verify.stderr.includes(fp), 'merge --verify must report the same fingerprint');
});

test('e2e: merge --verify refuses a tampered export with exit 1', () => {
  const data = JSON.parse(readFileSync(join(HOME, 'me.json'), 'utf8'));
  data.overall.costUsd = 0.01;
  writeFileSync(join(HOME, 'tampered.json'), JSON.stringify(data));
  const { code, stderr } = run(['merge', join(HOME, 'tampered.json'), '--verify']);
  assert.equal(code, 1);
  assert.match(stderr, /modified after signing/);
});

test('e2e: merge with team config produces discipline rollups', () => {
  writeFileSync(join(HOME, 'team.yaml'), 'nobody: frontend\n');
  const { stdout, code } = run(['merge', join(HOME, 'me.json'), '--team', join(HOME, 'team.yaml')]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('By discipline'));
  assert.ok(stdout.includes('unassigned')); // current user not in team.yaml
});

test('e2e: html writes a self-contained dashboard', () => {
  const out = join(HOME, 'dash.html');
  const { code } = run(['html', '--out', out, ...DAYS]);
  assert.equal(code, 0);
  const html = readFileSync(out, 'utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('proj-alpha'));
});

test('e2e: analyze renders the deep dive', () => {
  const { stdout, code } = run(['analyze', ...DAYS]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Deep analysis'));
  assert.ok(stdout.includes('Most expensive sessions'));
});

test('e2e: init from local config + push delivers a verifiable export', () => {
  const home2 = mkdtempSync(join(tmpdir(), 'tm-e2e-init-'));
  cpSync(join(FIXTURES, 'claude'), join(home2, '.claude', 'projects'), { recursive: true });
  const drop = join(home2, 'drop');
  mkdirSync(drop);
  writeFileSync(
    join(home2, 'team.json'),
    JSON.stringify({ teamName: 'e2e-team', push: { type: 'path', dir: drop }, windowDays: 36500 }),
  );

  const init = run(['init', '--from', join(home2, 'team.json')], { home: home2 });
  assert.equal(init.code, 0);
  assert.match(init.stdout, /Joined team "e2e-team"/);
  assert.match(init.stdout, /[0-9a-f]{16}/);

  const push = run(['push'], { home: home2 });
  assert.equal(push.code, 0, push.stderr);
  const files = readdirSync(drop);
  assert.equal(files.length, 1);

  // the lead can verify what landed
  const verify = run(['merge', join(drop, files[0]), '--verify'], { home: home2 });
  assert.equal(verify.code, 0);
});

test('e2e: unknown command and bare invocation fail with help', () => {
  assert.equal(run(['definitely-not-a-command']).code, 1);
  const bare = run([]);
  assert.equal(bare.code, 1);
  assert.ok(bare.stdout.includes('Usage:'));
});
