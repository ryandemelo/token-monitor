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
  put.run('bubbleId:c1:b1', bubble({
    type: 1, createdAt: '2026-06-01T10:00:00.000Z',
    text: 'add retry with backoff to the http client',
  }));
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
  put.run('bubbleId:c1:b5', bubble({
    type: 1, createdAt: '2026-06-01T10:02:00.000Z',
    text: 'fix the failing authentication unit test',
  }));
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

/** Tiny protobuf wire-format encoder for building synthetic vendor blobs. */
export interface ProtoMsg {
  [field: number]: number | string | Uint8Array | ProtoMsg | Array<number | string | Uint8Array | ProtoMsg>;
}

function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}

export function encodeProto(msg: ProtoMsg): Uint8Array {
  const parts: number[] = [];
  for (const [field, value] of Object.entries(msg)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      const id = Number(field);
      if (typeof v === 'number') {
        parts.push(...varint((id << 3) | 0), ...varint(v));
      } else {
        const bytes =
          typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : encodeProto(v);
        parts.push(...varint((id << 3) | 2), ...varint(bytes.length), ...bytes);
      }
    }
  }
  return Uint8Array.from(parts);
}

/**
 * Synthetic Antigravity conversation db mirroring the real layout (issue #10):
 * three generations — an exploration turn, a failed `npm test` turn, and a
 * user-cancelled command (which must NOT count as an error).
 */
export function makeAntigravityFixture(root: string): void {
  const convDir = join(root, 'conversations');
  mkdirSync(convDir, { recursive: true });
  const db = new DatabaseSync(join(convDir, 'conv-1.db'));
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id));
    CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id));
    CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
      metadata blob, error_details blob, step_payload blob, PRIMARY KEY (idx));
    CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
  `);

  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
    'main',
    encodeProto({ 1: { 1: 'file:///home/u/proj-anti', 4: 'feat/x' }, 7: 'file:///home/u/proj-anti' }),
  );

  const step = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload, error_details) VALUES (?, ?, ?, ?, ?)');
  const planner = encodeProto({ 1: 15, 4: 3 });
  step.run(0, 14, 3, encodeProto({ 1: 14, 4: 3 }), null);
  step.run(1, 98, 3, null, null);
  step.run(2, 15, 3, planner, null);
  step.run(3, 8, 3, encodeProto({ 1: 8, 4: 3 }), null);
  step.run(4, 15, 3, planner, null);
  step.run(5, 21, 7,
    encodeProto({ 1: 21, 4: 7, 28: { 2: '/home/u/proj-anti', 23: 'npm test', 25: 'npm test' } }),
    encodeProto({ 2: 'exit status 1', 3: 'exit status 1\nlong trace' }));
  step.run(6, 15, 3, planner, null);
  step.run(7, 21, 7,
    encodeProto({ 1: 21, 4: 7, 28: { 25: 'sleep 100' } }),
    encodeProto({ 2: 'context canceled', 3: 'context canceled\n(1) attached stack trace' }));

  const gen = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
  const genBlob = (g: ProtoMsg) => encodeProto({ 1: g });
  gen.run(0, genBlob({
    4: { 1: 1020, 2: 1000, 3: 50 },
    6: 0,
    9: { 4: { 1: 1780000000, 2: 500000000 } },
    19: 'gemini-3-flash-a',
    20: [{ 1: 'last_step_index', 2: '1' }, { 1: 'used_claude', 2: 'false' }],
    21: 'Gemini 3.5 Flash (Medium)',
  }), 0);
  gen.run(1, genBlob({
    4: { 1: 1020, 2: 1500, 3: 80, 5: 2000 },
    6: 2,
    9: { 4: { 1: 1780000100, 2: 0 } },
    19: 'gemini-3-pro-x',
    20: [{ 1: 'last_step_index', 2: '3' }],
  }), 0);
  gen.run(2, genBlob({
    4: { 1: 1020, 2: 500, 3: 20 },
    6: 4,
    9: { 4: { 1: 1780000200, 2: 0 } },
    20: [{ 1: 'last_step_index', 2: '5' }],
    21: 'Claude Sonnet',
  }), 0);
  db.close();
}
