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

test('e2e: categorize captures intent text from every adapter, not just claude-code', async () => {
  // The shared HOME has all sources collected. categorize re-collects intent
  // text in-memory across adapters, so cursor/copilot/gemini/codex sessions now
  // yield real-text fingerprints (has_text=1) — the PR2 fan-out.
  const cat = run(['categorize', ...DAYS]);
  assert.equal(cat.code, 0, cat.stderr);

  const { openDb, loadIntents } = await import('../src/store.js');
  const dbPath = join(HOME, '.token-monitor', 'token-monitor.sqlite');
  const sids = ['c1', 'g1', 'sess-c1', 'cop-s1']; // cursor, gemini, codex, copilot
  const intents = loadIntents(openDb(dbPath), sids);
  for (const sid of sids) {
    assert.equal(intents.get(sid)?.has_text, 1, `expected a text-derived intent for ${sid}`);
    const fp = JSON.parse(intents.get(sid)!.fingerprint) as string[];
    assert.ok(fp.length >= 1 && fp.length <= 8, `fingerprint out of bounds for ${sid}`);
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

test('e2e: --track records nothing when the agent fails or returns no JSON', () => {
  // (1) valid JSON but a nonzero exit -> not recorded, CLI propagates failure.
  const failJson = join(HOME, 'fail-json.mjs');
  writeFileSync(
    failJson,
    "process.stdout.write(JSON.stringify({interventions:[{metric:'retryShare',title:'x',rationale:'y'}]}));process.exit(3);",
  );
  const r1 = run(['analyze', '--track', ...DAYS], { env: { TOKEN_MONITOR_LLM_CMD: `${process.execPath} ${failJson}` } });
  assert.notEqual(r1.code, 0);
  assert.match(r1.stderr, /exited with status/);

  // (2) clean exit but no parseable JSON -> nonzero, nothing recorded.
  const noJson = join(HOME, 'no-json.mjs');
  writeFileSync(noJson, "process.stdout.write('I have no structured advice for you.');");
  const r2 = run(['analyze', '--track', ...DAYS], { env: { TOKEN_MONITOR_LLM_CMD: `${process.execPath} ${noJson}` } });
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /No trackable interventions/);

  // Neither attempt persisted a retryShare row.
  assert.ok(!run(['report', ...DAYS]).stdout.includes('llm:retryShare'));
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

test('e2e: categorize clusters intents offline, flags cross-project dup, never leaks raw prompts', async () => {
  // Fresh HOME with hand-built claude transcripts: two projects do the SAME
  // auth task (a duplicate-work cluster), one does something unrelated. One
  // prompt embeds secrets that must be redacted on-device.
  const home = mkdtempSync(join(tmpdir(), 'tm-e2e-categorize-'));
  const SECRET_KEY = 'sk-CANARYdeadbeef1234567';
  const SECRET_EMAIL = 'leak@secret.example';
  const RAW_PHRASE = 'admin credential is';

  const writeSession = (project: string, sid: string, uuid: string, prompt: string) => {
    const dir = join(home, '.claude', 'projects', project);
    mkdirSync(dir, { recursive: true });
    const cwd = `/Users/dev/${project}`;
    const lines = [
      { type: 'user', sessionId: sid, timestamp: '2026-06-01T10:00:00.000Z', message: { content: [{ type: 'text', text: prompt }] } },
      { type: 'assistant', uuid, sessionId: sid, cwd, gitBranch: 'main', timestamp: '2026-06-01T10:00:05.000Z',
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 500, output_tokens: 300 }, content: [{ type: 'tool_use', id: uuid + 't', name: 'Edit', input: {} }] } },
    ];
    writeFileSync(join(dir, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };

  writeSession('proj-auth-a', 'sa', 'ua',
    `Add JWT authentication and login to the REST API service. The ${RAW_PHRASE} ${SECRET_KEY} and contact ${SECRET_EMAIL}`);
  writeSession('proj-auth-b', 'sb', 'ub',
    'Implement JWT authentication and a login endpoint for the REST API');
  writeSession('proj-css', 'sc', 'uc',
    'Fix the CSS flexbox layout on the dashboard settings page');

  // Two tool-only sessions (no user text) in different projects: they share an
  // activity+tool fallback fingerprint and cluster, but must NEVER be flagged as
  // duplicate work or an org-skill candidate (no real-text evidence).
  const writeToolSession = (project: string, sid: string, uuid: string) => {
    const dir = join(home, '.claude', 'projects', project);
    mkdirSync(dir, { recursive: true });
    const line = {
      type: 'assistant', uuid, sessionId: sid, cwd: `/Users/dev/${project}`, gitBranch: 'main',
      timestamp: '2026-06-01T11:00:00.000Z',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 300, output_tokens: 100 }, content: [{ type: 'tool_use', id: uuid + 't', name: 'Bash', input: { command: 'ls' } }] },
    };
    writeFileSync(join(dir, sid + '.jsonl'), JSON.stringify(line) + '\n');
  };
  writeToolSession('proj-tool-x', 'sd', 'ud');
  writeToolSession('proj-tool-y', 'se', 'ue');

  assert.equal(run(['collect', '--source', 'claude-code'], { home }).code, 0);

  const cat = run(['categorize', ...DAYS], { home });
  assert.equal(cat.code, 0, cat.stderr);
  assert.ok(cat.stdout.includes('By category'), 'missing By category section');
  assert.match(cat.stdout, /auth|jwt|login/, 'auth cluster name missing');
  assert.ok(cat.stdout.includes('Duplicate work'), 'missing Duplicate work section');
  assert.ok(cat.stdout.includes('proj-auth-a') && cat.stdout.includes('proj-auth-b'),
    'duplicate-work cluster must name both projects');

  // Secrets must never reach stdout.
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!cat.stdout.includes(leak), `leaked "${leak}" to stdout`);
  }

  // DB canary: the sqlite file must contain no secret and no verbatim sentence.
  const dbPath = join(home, '.token-monitor', 'token-monitor.sqlite');
  const dbBytes = readFileSync(dbPath).toString('latin1');
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!dbBytes.includes(leak), `leaked "${leak}" into the database`);
  }

  // session_intents holds 3 labels-only rows, each a bounded redacted fingerprint.
  const { openDb, loadIntents } = await import('../src/store.js');
  const db = openDb(dbPath);
  const intents = loadIntents(db, ['sa', 'sb', 'sc']);
  assert.equal(intents.size, 3, 'expected one intent row per session');
  for (const row of intents.values()) {
    const fp = JSON.parse(row.fingerprint) as string[];
    assert.ok(fp.length <= 8, 'fingerprint exceeded 8 tokens');
    assert.ok(!fp.some((t) => t.toLowerCase().includes('canary')), 'secret token persisted in fingerprint');
    assert.equal(row.has_text, 1, 'these sessions had real user text');
  }
  const idsBefore = [...intents.values()].map((r) => r.intent_id).sort();

  // --json surfaces the deterministic duplicate-work signal across 2 projects.
  const json = JSON.parse(run(['categorize', '--json', ...DAYS], { home }).stdout);
  assert.ok(json.duplicates.length >= 1, 'expected a duplicate-work cluster');
  assert.ok(json.duplicates.some((d: { projects: string[] }) => d.projects.length >= 2));

  // No-text fallback clusters must be gated out of the high-trust signals.
  type Cat = { hasText: boolean; sessions: number };
  assert.ok(json.duplicates.every((d: Cat) => d.hasText), 'no-text cluster wrongly flagged as duplicate work');
  assert.ok(json.categories.some((c: Cat) => !c.hasText && c.sessions >= 2), 'expected the tool-only sessions to cluster');
  assert.ok(!json.skillCandidates.some((c: Cat) => !c.hasText), 'no-text cluster wrongly offered as an org-skill candidate');

  // Idempotent: a second run records nothing new and freezes intent ids first-wins.
  const idsAfter = [...loadIntents(openDb(dbPath), ['sa', 'sb', 'sc']).values()].map((r) => r.intent_id).sort();
  assert.deepEqual(idsAfter, idsBefore, 'intent ids must be stable across runs');

  // PR3: --html writes a self-contained categorize dashboard, still leak-free.
  const htmlPath = join(home, 'cat.html');
  assert.equal(run(['categorize', '--html', htmlPath, ...DAYS], { home }).code, 0);
  const catHtml = readFileSync(htmlPath, 'utf8');
  assert.ok(catHtml.startsWith('<!doctype html>'));
  assert.ok(catHtml.includes('Duplicate work'), 'dashboard missing Duplicate work section');
  assert.ok(catHtml.includes('proj-auth-a') && catHtml.includes('proj-auth-b'), 'dashboard must name both projects');
  assert.ok(catHtml.includes('raw prompt text is never stored'), 'dashboard missing privacy footnote');
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!catHtml.includes(leak), `categorize --html leaked "${leak}"`);
  }

  // PR3: report cross-surfaces the duplicate-work signal from the frozen intents.
  const rep = run(['report', ...DAYS], { home });
  assert.equal(rep.code, 0);
  assert.match(rep.stdout, /🔁 1 recurring task spanning ≥2 projects/, 'report missing the duplicate-work callout');
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!rep.stdout.includes(leak), `report duplicate-work line leaked "${leak}"`);
  }
});

test('e2e: unknown command and bare invocation fail with help', () => {
  assert.equal(run(['definitely-not-a-command']).code, 1);
  const bare = run([]);
  assert.equal(bare.code, 1);
  assert.ok(bare.stdout.includes('Usage:'));
});

// ---- PR4 e2e: project families, category exports, cross-user merge ----------

test('e2e: two-member category exports merge into cross-user duplicate work, leak-free and deterministic', () => {
  const SECRET_KEY = 'sk-CANARYfeedface7654321';
  const SECRET_EMAIL = 'leak2@secret.example';
  const RAW_PHRASE = 'staging admin password is';

  const memberHome = (name: string, project: string, prompt: string): string => {
    const home = mkdtempSync(join(tmpdir(), `tm-e2e-${name}-`));
    const dir = join(home, '.claude', 'projects', project);
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'user', sessionId: 's1', timestamp: '2026-06-01T10:00:00.000Z', message: { content: [{ type: 'text', text: prompt }] } },
      { type: 'assistant', uuid: `${name}-u1`, sessionId: 's1', cwd: `/Users/${name}/${project}`, timestamp: '2026-06-01T10:00:05.000Z',
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 500, output_tokens: 300 }, content: [{ type: 'tool_use', id: `${name}-t1`, name: 'Edit', input: {} }] } },
    ];
    writeFileSync(join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.equal(run(['collect', '--source', 'claude-code'], { home }).code, 0);
    return home;
  };

  const homeA = memberHome('alice', 'proj-pay-a',
    `Add payment retry with exponential backoff to the billing worker. The ${RAW_PHRASE} ${SECRET_KEY}, contact ${SECRET_EMAIL}`);
  const homeB = memberHome('bob', 'proj-pay-b',
    'Implement payment retry and exponential backoff in the billing worker queue');

  // Exports carry categories (signed, labels only); canaries must not cross the wire.
  const exA = run(['report', '--json', ...DAYS], { home: homeA }).stdout;
  const exB = run(['report', '--json', ...DAYS], { home: homeB }).stdout;
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!exA.includes(leak), `export leaked "${leak}"`);
  }
  const parsedA = JSON.parse(exA);
  assert.equal(parsedA.version, 1, 'wire version must stay 1 (additive fields)');
  assert.ok(Array.isArray(parsedA.categories) && parsedA.categories.length >= 1, 'export missing categories');
  assert.ok(!('categories' in JSON.parse(run(['report', '--json', '--no-categories', ...DAYS], { home: homeA }).stdout)),
    '--no-categories must omit the key entirely');
  // No raw text classes in the category rows: allowlisted keys only.
  for (const c of parsedA.categories) {
    assert.deepEqual(Object.keys(c).sort(), ['cost', 'duplicate', 'estimated', 'id', 'name', 'projects', 'sessions', 'terms', 'tokens']);
  }

  const mergeHome = mkdtempSync(join(tmpdir(), 'tm-e2e-merge-'));
  const fA = join(mergeHome, 'a.json'), fB = join(mergeHome, 'b.json');
  writeFileSync(fA, exA);
  writeFileSync(fB, exB);

  const merged = run(['merge', fA, fB], { home: mergeHome });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(merged.stdout.includes('Cross-user duplicate work'), 'missing cross-user section');
  assert.match(merged.stdout, /done independently by ≥2 people/, 'missing cross-user headline');
  assert.ok(merged.stdout.includes('Org-skill candidates (team-wide)'), 'missing org-skill section');
  assert.ok(merged.stdout.includes('task categories from 2 of 2 export(s)'), 'missing coverage footer');
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!merged.stdout.includes(leak), `merge stdout leaked "${leak}"`);
  }

  // Deterministic: same inputs, byte-identical stdout.
  assert.equal(run(['merge', fA, fB], { home: mergeHome }).stdout, merged.stdout);

  // --json exposes the machine-readable tiers.
  const mj = JSON.parse(run(['merge', fA, fB, '--json'], { home: mergeHome }).stdout);
  assert.ok(mj.crossUserDuplicates.length >= 1, 'expected a cross-user duplicate');
  assert.ok(mj.crossUserDuplicates[0].userCount >= 2);
  assert.deepEqual(mj.categoryCoverage, { withCategories: 2, total: 2 });

  // --html renders the sections, escaped and leak-free.
  const htmlPath = join(mergeHome, 'team.html');
  assert.equal(run(['merge', fA, fB, '--html', htmlPath], { home: mergeHome }).code, 0);
  const html = readFileSync(htmlPath, 'utf8');
  assert.ok(html.includes('Cross-user duplicate work'));
  assert.ok(html.includes('Org-skill candidates'));
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!html.includes(leak), `merge --html leaked "${leak}"`);
  }

  // Raw sqlite bytes (incl. project_raw) never hold the canaries either.
  const dbBytes = readFileSync(join(homeA, '.token-monitor', 'token-monitor.sqlite')).toString('latin1');
  for (const leak of [SECRET_KEY, SECRET_EMAIL, 'CANARY', RAW_PHRASE]) {
    assert.ok(!dbBytes.includes(leak), `db leaked "${leak}"`);
  }

  // Pre-0.11 mix: stripping categories from one export downgrades gracefully.
  const legacy = JSON.parse(exB);
  delete legacy.categories;
  delete legacy.categorizeDays;
  delete legacy.sig; // edited payload can't stay signed
  writeFileSync(fB, JSON.stringify(legacy));
  const mixed = run(['merge', fA, fB, '--json'], { home: mergeHome });
  assert.equal(mixed.code, 0, mixed.stderr);
  const mixedJson = JSON.parse(mixed.stdout);
  assert.deepEqual(mixedJson.categoryCoverage, { withCategories: 1, total: 2 });
  assert.equal(mixedJson.crossUserDuplicates.length, 0);
});

test('e2e: collect relabels fragmented historical rows into project families once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-e2e-relabel-'));
  const dbPath = join(home, '.token-monitor', 'token-monitor.sqlite');

  // Seed the DB with pre-0.11 fragmented rows for a session whose transcript
  // still exists: same session split across "process" and "backend".
  const { openDb: open, insertEvents: insert } = await import('../src/store.js');
  const { makeEvent } = await import('./helpers.js');
  const db = open(dbPath);
  insert(db, [
    makeEvent({ eventKey: 'frag-u1', sessionId: 'sfrag', project: 'process', timestamp: '2026-06-01T10:00:05.000Z' }),
    makeEvent({ eventKey: 'frag-u2', sessionId: 'sfrag', project: 'backend', timestamp: '2026-06-01T10:00:06.000Z' }),
  ]);
  db.close();

  // The transcript the adapter re-reads: both events, cwds root + subdir (dead
  // paths → descendant adoption → both resolve to "process").
  const dir = join(home, '.claude', 'projects', 'enc');
  mkdirSync(dir, { recursive: true });
  const mkLine = (uuid: string, cwd: string) => JSON.stringify({
    type: 'assistant', uuid, sessionId: 'sfrag', cwd, timestamp: '2026-06-01T10:00:05.000Z',
    message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 10 }, content: [] },
  });
  writeFileSync(join(dir, 'sfrag.jsonl'),
    mkLine('frag-u1', '/gone/kevq/process') + '\n' + mkLine('frag-u2', '/gone/kevq/process/backend') + '\n');

  const first = run(['collect', '--source', 'claude-code'], { home });
  assert.equal(first.code, 0);
  assert.match(first.stdout, /1 relabeled into project families/, 'expected the relabel note');

  const db2 = open(dbPath);
  const rows = db2.prepare(`SELECT event_key, project, project_raw FROM events ORDER BY event_key`).all() as
    Array<{ event_key: string; project: string; project_raw: string | null }>;
  assert.deepEqual(rows.map((r) => r.project), ['process', 'process']);
  assert.deepEqual(rows.map((r) => r.project_raw), [null, 'backend']); // only the changed row is audited
  db2.close();

  // Steady state: the note disappears, nothing relabels again.
  const second = run(['collect', '--source', 'claude-code'], { home });
  assert.equal(second.code, 0);
  assert.ok(!second.stdout.includes('relabeled into project families'), 'relabel must be idempotent');
});
