import { readdirSync, existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';
import { familyOf } from '../project-family.js';
import { decodeMessage, intField, strField, msgField, msgFields, type WireMessage } from './../protowire.js';

/**
 * Antigravity CLI stores one SQLite db per conversation under
 * ~/.gemini/antigravity-cli/conversations/<id>.db. The interesting table is
 * gen_metadata: one protobuf blob per LLM call, with token usage, model id,
 * and timestamps. The steps table records turn/tool events; a gen row's
 * "last step index at request time" lets us attribute the tool steps each
 * generation produced. Field numbers were mapped empirically (issue #10) —
 * the schema is vendor-internal, so everything here fails soft.
 *
 * Privacy: only usage/model/timing fields are decoded. The blobs also carry
 * full prompt/conversation snapshots (f1.1/f1.2/f1.8/f1.16) — those are
 * never descended into.
 */

const ROOT = join(homedir(), '.gemini', 'antigravity-cli');

// steps.step_type -> normalized tool name (observed enum values)
const STEP_TOOLS: Record<number, string> = {
  8: 'view_file',
  9: 'list_directory',
  21: 'run_command',
  23: 'update_plan',
};
// Non-tool step types: 14 = user input, 15 = planner response, 98 = history.
const NON_TOOL_STEPS = new Set([14, 15, 98]);

interface StepInfo {
  idx: number;
  type: number;
  status: number;
  command?: string;
  errorShort?: string;
}

function tsToIso(msg: WireMessage | undefined): string | undefined {
  const sec = intField(msg, 1);
  if (!sec) return undefined;
  return new Date(sec * 1000 + Math.floor(intField(msg, 2) / 1e6)).toISOString();
}

function collectConversation(dbPath: string, scratch: string, events: UsageEvent[]): void {
  const convId = basename(dbPath, '.db');
  const copy = join(scratch, `${convId}.db`);
  copyFileSync(dbPath, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
  }
  const db = new DatabaseSync(copy);
  try {
    // Workspace / branch attribution.
    let project = 'unknown';
    let gitBranch: string | undefined;
    try {
      const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get() as { data?: Uint8Array } | undefined;
      if (row?.data) {
        const ctx = msgField(decodeMessage(row.data), 1);
        const workspaceUri = strField(ctx, 1);
        if (workspaceUri) {
          const path = decodeURIComponent(workspaceUri.replace(/^file:\/\//, ''));
          project = familyOf(path) ?? basename(path);
        }
        gitBranch = strField(ctx, 4);
      }
    } catch {
      /* attribution is optional */
    }

    // Step events, for tool attribution per generation.
    const steps: StepInfo[] = [];
    try {
      const rows = db
        .prepare('SELECT idx, step_type, status, step_payload, error_details FROM steps ORDER BY idx')
        .all() as Array<{ idx: number; step_type: number; status: number; step_payload?: Uint8Array; error_details?: Uint8Array }>;
      for (const r of rows) {
        const info: StepInfo = { idx: r.idx, type: r.step_type, status: r.status };
        if (r.step_type === 21 && r.step_payload) {
          try {
            const payload = msgField(decodeMessage(r.step_payload), 28);
            info.command = strField(payload, 25) ?? strField(payload, 23);
          } catch { /* ignore */ }
        }
        if (r.status === 7 && r.error_details) {
          try {
            info.errorShort = strField(decodeMessage(r.error_details), 2);
          } catch { /* ignore */ }
        }
        steps.push(info);
      }
    } catch {
      /* steps are optional — events still carry tokens */
    }

    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{ idx: number; data?: Uint8Array }>;
    interface Gen { idx: number; lastStep: number; gen: WireMessage }
    const gens: Gen[] = [];
    for (const r of genRows) {
      if (!r.data) continue;
      try {
        const gen = msgField(decodeMessage(r.data), 1);
        if (!gen) continue;
        // f20 is a repeated {1: key, 2: value} annotation list; last_step_index
        // is authoritative there (f6 is off by one from it).
        let lastStep = intField(gen, 6) + 1;
        for (const kv of msgFields(gen, 20)) {
          if (strField(kv, 1) === 'last_step_index') {
            const v = Number(strField(kv, 2));
            if (Number.isFinite(v)) lastStep = v;
          }
        }
        gens.push({ idx: r.idx, lastStep, gen });
      } catch {
        continue; // unknown layout — fail soft per row
      }
    }

    gens.forEach(({ idx, lastStep, gen }, i) => {
      const usage = msgField(gen, 4);
      if (!usage) return;
      // Steps produced by this generation: after its request snapshot, up to
      // the next generation's snapshot (or end of trajectory for the last).
      const upper = i + 1 < gens.length ? gens[i + 1].lastStep : Number.MAX_SAFE_INTEGER;
      const mySteps = steps.filter((s) => s.idx > lastStep && s.idx <= upper);
      const tools: string[] = [];
      const commands: string[] = [];
      let isError = false;
      for (const s of mySteps) {
        if (NON_TOOL_STEPS.has(s.type)) continue;
        tools.push(STEP_TOOLS[s.type] ?? `step_${s.type}`);
        if (s.command) commands.push(s.command);
        // status 7 covers both failures and user cancellations — a cancel is a choice, not an error.
        if (s.status === 7 && !/cancel/i.test(s.errorShort ?? '')) isError = true;
      }

      const timing = msgField(gen, 9);
      const ev: UsageEvent = {
        source: 'antigravity',
        eventKey: `${convId}:${idx}`,
        sessionId: convId,
        project,
        timestamp: tsToIso(msgField(timing, 4)) ?? new Date(0).toISOString(),
        model: strField(gen, 19) ?? strField(gen, 21) ?? 'antigravity',
        inputTokens: intField(usage, 2),
        outputTokens: intField(usage, 3),
        cacheReadTokens: intField(usage, 5),
        cacheCreationTokens: 0,
        thinkingTokens: 0,
        tools,
        commands,
        hasThinking: false,
        isError,
        gitBranch,
      };
      ev.activity = classify(ev);
      events.push(ev);
    });
  } finally {
    db.close();
  }
}

export function collectAntigravity(root: string = ROOT): { events: UsageEvent[]; result: CollectResult } {
  const events: UsageEvent[] = [];
  const convDir = join(root, 'conversations');
  if (!existsSync(convDir)) {
    return { events, result: { source: 'antigravity', filesScanned: 0, eventsFound: 0, eventsInserted: 0, note: `${convDir} not found — Antigravity not detected` } };
  }
  const scratch = mkdtempSync(join(tmpdir(), 'tm-antigravity-'));
  let filesScanned = 0;
  let failed = 0;
  try {
    for (const file of readdirSync(convDir)) {
      if (!file.endsWith('.db')) continue;
      filesScanned++;
      try {
        collectConversation(join(convDir, file), scratch, events);
      } catch {
        failed++; // vendor-internal format — skip conversations we can't read
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    events,
    result: {
      source: 'antigravity',
      filesScanned,
      eventsFound: events.length,
      eventsInserted: 0,
      note: failed > 0 ? `${failed} conversation db(s) skipped (unreadable or unknown format)` : undefined,
    },
  };
}
