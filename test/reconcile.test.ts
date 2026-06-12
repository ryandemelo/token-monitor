import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { compareUsage, reconcile, renderReconcile } from '../src/reconcile.js';
import { makeStored } from './helpers.js';

test('compareUsage: coverage, tamper flag, local-only models', () => {
  const events = [
    makeStored({ model: 'claude-opus-4-7', input_tokens: 800, output_tokens: 200 }), // 1000 local
    makeStored({ model: 'claude-haiku-4-5', input_tokens: 5000, output_tokens: 0 }), // exceeds api
    makeStored({ model: 'gemini-2.5-flash', input_tokens: 100, output_tokens: 0 }), // other vendor
  ];
  const rows = compareUsage(events, [
    { model: 'claude-opus-4-7', inputTokens: 3000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);

  const opus = rows.find((r) => r.model === 'claude-opus-4-7')!;
  assert.equal(opus.verdict, 'ok');
  assert.ok(Math.abs(opus.coverage - 0.25) < 1e-9); // 1000 / 4000

  const haiku = rows.find((r) => r.model === 'claude-haiku-4-5')!;
  assert.equal(haiku.verdict, 'local-exceeds-api'); // 5000 local vs 1000 billed

  const gemini = rows.find((r) => r.model === 'gemini-2.5-flash')!;
  assert.equal(gemini.verdict, 'local-only');
  assert.equal(gemini.apiTokens, 0);
});

test('compareUsage: small overshoot stays within tolerance', () => {
  const events = [makeStored({ model: 'm', input_tokens: 1030, output_tokens: 0 })];
  const rows = compareUsage(events, [
    { model: 'm', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  assert.equal(rows[0].verdict, 'ok'); // 1.03x < 1.05 tolerance (bucket snapping / clock skew)
});

function serve(handler: (url: string) => object): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(handler(req.url ?? '')));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('reconcile: anthropic shape parsed, paginated, env-keyed', async () => {
  let calls = 0;
  const { server, url } = await serve((reqUrl) => {
    calls++;
    assert.match(reqUrl, /\/v1\/organizations\/usage_report\/messages/);
    const paged = reqUrl.includes('page=p2');
    return {
      data: [
        {
          starting_at: '2026-06-12T00:00:00Z',
          ending_at: '2026-06-13T00:00:00Z',
          results: [
            {
              model: 'claude-opus-4-7',
              uncached_input_tokens: paged ? 500 : 1000,
              output_tokens: paged ? 100 : 200,
              cache_read_input_tokens: 0,
              cache_creation: { ephemeral_5m_input_tokens: paged ? 0 : 300, ephemeral_1h_input_tokens: 0 },
            },
          ],
        },
      ],
      has_more: !paged,
      next_page: paged ? null : 'p2',
    };
  });
  try {
    const events = [makeStored({ model: 'claude-opus-4-7', input_tokens: 900, output_tokens: 100 })];
    const { rows, breach } = await reconcile('anthropic', events, 7, {
      ANTHROPIC_ADMIN_KEY: 'test-key',
      TOKEN_MONITOR_ANTHROPIC_URL: url,
    } as NodeJS.ProcessEnv);
    assert.equal(calls, 2); // pagination followed
    assert.equal(breach, false);
    const row = rows[0];
    assert.equal(row.model, 'claude-opus-4-7');
    assert.equal(row.apiTokens, 1500 + 300 + 300); // both pages: input+output+cacheCreate
    assert.equal(row.localTokens, 1000);
    assert.ok(renderReconcile('anthropic', rows, 7).includes('✓ reconciles'));
  } finally {
    server.close();
  }
});

test('reconcile: openai shape splits cached tokens out of input', async () => {
  const { server, url } = await serve((reqUrl) => {
    assert.match(reqUrl, /\/v1\/organization\/usage\/completions/);
    return {
      data: [
        {
          results: [
            { model: 'gpt-5-codex', input_tokens: 1000, input_cached_tokens: 400, output_tokens: 100 },
          ],
        },
      ],
      has_more: false,
    };
  });
  try {
    const { rows } = await reconcile('openai', [], 7, {
      OPENAI_ADMIN_KEY: 'k',
      TOKEN_MONITOR_OPENAI_URL: url,
    } as NodeJS.ProcessEnv);
    // 600 fresh input + 400 cache read + 100 output
    assert.equal(rows[0].apiTokens, 1100);
  } finally {
    server.close();
  }
});

test('reconcile: missing key and unknown provider fail with clear messages', async () => {
  await assert.rejects(() => reconcile('anthropic', [], 7, {} as NodeJS.ProcessEnv), /ANTHROPIC_ADMIN_KEY is not set/);
  await assert.rejects(() => reconcile('grok', [], 7, {} as NodeJS.ProcessEnv), /Unknown provider/);
});

test('reconcile: HTTP errors surface the status, not a crash', async () => {
  const { server, url } = await serve(() => ({}));
  server.removeAllListeners('request');
  server.on('request', (_req, res) => {
    res.statusCode = 401;
    res.end('{"error": "unauthorized"}');
  });
  try {
    await assert.rejects(
      () => reconcile('anthropic', [], 7, { ANTHROPIC_ADMIN_KEY: 'bad', TOKEN_MONITOR_ANTHROPIC_URL: url } as NodeJS.ProcessEnv),
      /responded 401/,
    );
  } finally {
    server.close();
  }
});
