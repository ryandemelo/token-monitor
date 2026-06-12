import { mkdirSync } from 'node:fs';
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
