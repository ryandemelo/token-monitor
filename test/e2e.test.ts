import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
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

function run(args: string[], opts: { home?: string; env?: NodeJS.ProcessEnv } = {}) {
  const home = opts.home ?? HOME;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    // APPDATA keeps win32 path resolution inside the synthetic home too.
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), ...opts.env },
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
  // recommendations 2.0: enriched details ride along, aggregate-only
  assert.ok(Array.isArray(data.recommendationDetails));
  for (const rec of data.recommendationDetails) {
    assert.ok(Array.isArray(rec.evidence));
    assert.ok(typeof rec.key === 'string');
  }

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

test('e2e: multi-team merge — two-level teams.yaml, --by team, fingerprint dedup, --html', () => {
  // Second member: same OS username, different machine (home) -> different signing key.
  const home2 = mkdtempSync(join(tmpdir(), 'tm-e2e-member2-'));
  cpSync(join(FIXTURES, 'claude'), join(home2, '.claude', 'projects'), { recursive: true });
  assert.equal(run(['collect'], { home: home2 }).code, 0);
  writeFileSync(join(HOME, 'member2.json'), run(['report', '--json', ...DAYS], { home: home2 }).stdout);

  // Same signer exports twice: the older one must be dropped, not double-counted.
  writeFileSync(join(HOME, 'me-stale.json'), readFileSync(join(HOME, 'me.json')));
  writeFileSync(join(HOME, 'me-fresh.json'), run(['report', '--json', ...DAYS]).stdout);

  const user = userInfo().username;
  writeFileSync(
    join(HOME, 'teams.yaml'),
    `platform:\n  ${user}: backend\ndata:\n  someone-else: ml\n`,
  );

  const htmlOut = join(HOME, 'team.html');
  const { stdout, stderr, code } = run([
    'merge',
    join(HOME, 'me-stale.json'), join(HOME, 'me-fresh.json'), join(HOME, 'member2.json'),
    '--team', join(HOME, 'teams.yaml'), '--by', 'team', '--html', htmlOut,
  ]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('By team'));
  assert.ok(stdout.includes('platform')); // user mapped via two-level config
  assert.match(stderr, /skipped stale export/);

  const html = readFileSync(htmlOut, 'utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('platform'));

  // --json: stale export deduped -> 2 exports remain (one per machine), one member name
  const json = JSON.parse(run([
    'merge',
    join(HOME, 'me-stale.json'), join(HOME, 'me-fresh.json'), join(HOME, 'member2.json'),
    '--team', join(HOME, 'teams.yaml'), '--by', 'team', '--json',
  ]).stdout);
  assert.deepEqual(json.members, [user]);
  assert.equal(json.by, 'team');
  assert.equal(json.rollups[0].group, 'platform');
  // 3 claude fixture sessions per machine, two machines, stale export excluded
  const me = JSON.parse(readFileSync(join(HOME, 'me-fresh.json'), 'utf8'));
  const m2 = JSON.parse(readFileSync(join(HOME, 'member2.json'), 'utf8'));
  assert.equal(json.overall.events, me.overall.events + m2.overall.events);
});

test('e2e: merge rejects an invalid --by axis', () => {
  const { code, stderr } = run(['merge', join(HOME, 'me.json'), '--by', 'planet']);
  assert.equal(code, 1);
  assert.match(stderr, /--by must be/);
});

test('e2e: report --trend renders the trend section (empty previous window)', () => {
  const { stdout, code } = run(['report', '--trend', ...DAYS]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Trend — last 36500 days vs the 36500 before'));
  assert.ok(stdout.includes('No events in the previous window'));
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

test('e2e: analyze --llm --track records LLM advice into follow-through', () => {
  // A fake agent CLI: reads the prompt on stdin, returns strict JSON (wrapped in
  // prose + a fence, to exercise the tolerant parser).
  const fake = join(HOME, 'fake-llm.mjs');
  writeFileSync(fake, [
    "let s='';",
    "process.stdin.on('data', (d) => (s += d));",
    "process.stdin.on('end', () => {",
    "  const body = JSON.stringify({ interventions: [",
    "    { metric: 'cacheHitRatio', direction: 'up', title: 'Reuse the system prompt across turns', rationale: 'cache hit is low' },",
    "    { metric: 'reworkRatio', direction: 'down', title: 'Plan before coding', rationale: 'rework is high' },",
    "  ] });",
    "  process.stdout.write('Here are my picks:\\n```json\\n' + body + '\\n```\\n');",
    "});",
  ].join('\n'));
  const env = { TOKEN_MONITOR_LLM_CMD: `${process.execPath} ${fake}` };

  const tracked = run(['analyze', '--llm', '--track', ...DAYS], { env });
  assert.equal(tracked.code, 0, tracked.stderr);
  assert.ok(tracked.stdout.includes('now tracked through follow-through'));
  assert.ok(tracked.stdout.includes('cacheHitRatio'));

  // The advice now appears in the report's follow-through, marked LLM-origin.
  const rep = run(['report', ...DAYS]);
  assert.ok(rep.stdout.includes('llm:cacheHitRatio'), 'report must track the LLM finding');
  assert.ok(rep.stdout.includes('🤖'), 'LLM-origin rows are marked');

  // --track refuses a filtered window (would pollute baselines).
  const filtered = run(['analyze', '--track', '--project', 'proj-alpha', ...DAYS], { env });
  assert.equal(filtered.code, 1);
  assert.match(filtered.stderr, /unfiltered window/);
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

test('e2e: reconcile verifies local totals against a mock usage API', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  // The mock server runs in THIS process — the CLI must run async (spawn, not
  // spawnSync) or the blocked event loop can never serve the request.
  const runAsync = (args: string[], env: NodeJS.ProcessEnv) =>
    new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
  // Fixture claude events: 3 turns of claude-opus-4-7. Org API reports more
  // than local (normal) first, then less than local (tamper flag).
  const mkBody = (uncached: number) => JSON.stringify({
    data: [{
      starting_at: '2026-06-01T00:00:00Z',
      ending_at: '2026-06-02T00:00:00Z',
      results: [{
        model: 'claude-opus-4-7',
        uncached_input_tokens: uncached,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      }],
    }],
    has_more: false,
  });
  let body = mkBody(100_000_000);
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  const url: string = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
  try {
    const runReconcile = (home: string) =>
      runAsync(['reconcile', '--days', '31'], {
        HOME: home, USERPROFILE: home,
        ANTHROPIC_ADMIN_KEY: 'e2e-test-key',
        TOKEN_MONITOR_ANTHROPIC_URL: url,
      });

    // Org reports far more than this machine collected — normal, reconciles.
    const ok = await runReconcile(HOME);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes('Reconcile'));
    assert.ok(ok.stdout.includes('claude-opus-4-7'));
    assert.ok(ok.stdout.includes('reconciles'));

    // Tamper case: a db whose local totals exceed what the org was billed.
    const home3 = mkdtempSync(join(tmpdir(), 'tm-e2e-reconcile-'));
    const { openDb, insertEvents } = await import('../src/store.js');
    const db = openDb(join(home3, '.token-monitor', 'token-monitor.sqlite'));
    insertEvents(db, [{
      source: 'claude-code', eventKey: 'tamper-1', sessionId: 's', project: 'p',
      timestamp: new Date().toISOString(), model: 'claude-opus-4-7',
      inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      thinkingTokens: 0, tools: [], commands: [], hasThinking: false, isError: false,
    }]);
    body = mkBody(1);
    const tampered = await runReconcile(home3);
    assert.equal(tampered.status, 1, tampered.stderr);
    assert.ok(tampered.stdout.includes('investigate'));

    // Missing key fails with the env-var instruction, exit 1.
    const noKey = spawnSync(process.execPath, [CLI, 'reconcile'], {
      encoding: 'utf8',
      env: { ...process.env, HOME, USERPROFILE: HOME, ANTHROPIC_ADMIN_KEY: '' },
    });
    assert.equal(noKey.status, 1);
    assert.match(noKey.stderr, /ANTHROPIC_ADMIN_KEY is not set/);

    // Unknown provider exits 1.
    const bad = spawnSync(process.execPath, [CLI, 'reconcile', '--provider', 'grok'], {
      encoding: 'utf8',
      env: { ...process.env, HOME, USERPROFILE: HOME, ANTHROPIC_ADMIN_KEY: 'x' },
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown provider/);
  } finally {
    server.close();
  }
});

test('e2e: unknown command and bare invocation fail with help', () => {
  assert.equal(run(['definitely-not-a-command']).code, 1);
  const bare = run([]);
  assert.equal(bare.code, 1);
  assert.ok(bare.stdout.includes('Usage:'));
});
