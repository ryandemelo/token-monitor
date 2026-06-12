import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageEvent } from '../src/types.js';
import type { StoredEvent } from '../src/store.js';

export function makeEvent(partial: Partial<UsageEvent> = {}): UsageEvent {
  return {
    source: 'claude-code',
    eventKey: 'k-' + Math.random().toString(36).slice(2),
    sessionId: 's1',
    project: 'proj',
    timestamp: '2026-06-01T00:00:00.000Z',
    model: 'claude-opus-4-7',
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    tools: [],
    commands: [],
    hasThinking: false,
    isError: false,
    ...partial,
  };
}

/**
 * Build a synthetic Cursor User dir (globalStorage/state.vscdb + one mapped
 * workspace) the way Cursor lays it out. Two composers: c1 has two completed
 * turns (testing, then an errored edit), c2 was aborted before its final
 * bubble, so it must yield no events. The ItemTable auth canary must never
 * surface anywhere in adapter output.
 */
export function makeCursorFixture(userDir: string): void {
  const globalDir = join(userDir, 'globalStorage');
  mkdirSync(globalDir, { recursive: true });
  const db = new DatabaseSync(join(globalDir, 'state.vscdb'));
  db.exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
           CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);`);
  const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'cursorAuth/accessToken', 'AUTH-CANARY-DO-NOT-READ',
  );

  const bubble = (extra: object) => JSON.stringify({ _v: 3, ...extra });
  put.run('composerData:c1', JSON.stringify({
    _v: 13, composerId: 'c1', unifiedMode: 'agent',
    createdAt: 1748700000000, lastUpdatedAt: 1748700300000,
    modelConfig: { modelName: 'default' },
    fullConversationHeadersOnly: [
      { bubbleId: 'b1' }, { bubbleId: 'b2' }, { bubbleId: 'b3' }, { bubbleId: 'b4' },
      { bubbleId: 'b5' }, { bubbleId: 'b6' }, { bubbleId: 'b7' },
    ],
  }));
  put.run('bubbleId:c1:b1', bubble({ type: 1, createdAt: '2026-06-01T10:00:00.000Z' }));
  put.run('bubbleId:c1:b2', bubble({
    type: 2, toolFormerData: { name: 'read_file', status: 'completed', rawArgs: '{}' },
  }));
  put.run('bubbleId:c1:b3', bubble({
    type: 2, toolFormerData: { name: 'run_terminal_cmd', status: 'completed', rawArgs: '{"command":"pytest -q"}' },
  }));
  put.run('bubbleId:c1:b4', bubble({
    type: 2, createdAt: '2026-06-01T10:01:00.000Z',
    tokenCount: { inputTokens: 1200, outputTokens: 300 },
    modelInfo: { modelName: 'default' },
  }));
  put.run('bubbleId:c1:b5', bubble({ type: 1, createdAt: '2026-06-01T10:02:00.000Z' }));
  put.run('bubbleId:c1:b6', bubble({
    type: 2, toolFormerData: { name: 'edit_file', status: 'error', rawArgs: '{}' },
  }));
  put.run('bubbleId:c1:b7', bubble({
    type: 2, createdAt: '2026-06-01T10:03:00.000Z',
    tokenCount: { inputTokens: 500, outputTokens: 100 },
  }));

  // Aborted session: bubbles exist but no token-bearing final bubble.
  put.run('composerData:c2', JSON.stringify({
    _v: 13, composerId: 'c2',
    fullConversationHeadersOnly: [{ bubbleId: 'b1' }],
  }));
  put.run('bubbleId:c2:b1', bubble({ type: 1 }));
  db.close();

  const wsDir = join(userDir, 'workspaceStorage', 'ws1');
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///home/u/proj-cur' }));
  const wsDb = new DatabaseSync(join(wsDir, 'state.vscdb'));
  wsDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  wsDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerData',
    JSON.stringify({ allComposers: [{ composerId: 'c1', name: 'fix tests' }] }),
  );
  wsDb.close();
}

let seq = 0;
export function makeStored(partial: Partial<StoredEvent> = {}): StoredEvent {
  seq++;
  return {
    source: 'claude-code',
    session_id: 's1',
    project: 'proj',
    ts: `2026-06-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    model: 'claude-opus-4-7',
    input_tokens: 100,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    thinking_tokens: 0,
    tools: '[]',
    has_thinking: 0,
    is_error: 0,
    activity: 'coding',
    ...partial,
  };
}
