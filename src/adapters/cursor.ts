import { readdirSync, readFileSync, existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';

/**
 * Cursor stores composer (chat/agent) state in a SQLite key/value store:
 *   <User dir>/globalStorage/state.vscdb, table cursorDiskKV
 *     composerData:<composerId>            one JSON doc per session
 *     bubbleId:<composerId>:<bubbleId>     one JSON doc per turn event
 * Token counts (tokenCount.inputTokens/outputTokens) are populated only on
 * the turn-final assistant bubble and are that turn's totals; intermediate
 * tool bubbles carry zeros. Cache tokens, cost, and the resolved backend
 * model are not persisted locally (model reads "default" in Auto mode).
 *
 * SECURITY: the same database's ItemTable holds Cursor auth credentials
 * (cursorAuth/*). This adapter must only ever read the two cursorDiskKV key
 * prefixes above from globalStorage, and the single `composer.composerData`
 * ItemTable key from per-workspace databases (composer -> workspace mapping).
 * Never SELECT * and never touch globalStorage ItemTable.
 */

export function cursorUserDir(home: string = homedir()): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  }
  return join(home, '.config', 'Cursor', 'User');
}

interface Bubble {
  type?: number; // 1 = user, 2 = assistant
  createdAt?: string;
  /** User-prompt text (type 1 bubbles); carried in-memory only, for `categorize`. */
  text?: string;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  toolFormerData?: { name?: string; status?: string; rawArgs?: string };
  modelInfo?: { modelName?: string };
}

interface ComposerDoc {
  composerId?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  modelConfig?: { modelName?: string };
  fullConversationHeadersOnly?: Array<{ bubbleId?: string }>;
}

const SHELL_TOOL_RE = /terminal|shell|command/i;

/** Open a copy of a (possibly WAL-journaled, possibly live) SQLite db read-only. */
function openDbCopy(dbPath: string, scratch: string, name: string): DatabaseSync {
  const copy = join(scratch, name);
  copyFileSync(dbPath, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
  }
  return new DatabaseSync(copy);
}

/** composerId -> project basename, via each workspace's composer list + folder URI. */
function loadWorkspaceMap(userDir: string, scratch: string): Map<string, string> {
  const map = new Map<string, string>();
  const wsRoot = join(userDir, 'workspaceStorage');
  let dirs: string[];
  try {
    dirs = readdirSync(wsRoot);
  } catch {
    return map;
  }
  for (const dir of dirs) {
    let project: string | undefined;
    try {
      const ws = JSON.parse(readFileSync(join(wsRoot, dir, 'workspace.json'), 'utf8'));
      const folder = ws.folder ?? ws.workspace;
      if (typeof folder === 'string') project = basename(decodeURIComponent(folder.replace(/^file:\/\//, '')));
    } catch {
      continue;
    }
    const wsDb = join(wsRoot, dir, 'state.vscdb');
    if (!project || !existsSync(wsDb)) continue;
    try {
      const db = openDbCopy(wsDb, scratch, `ws-${dir}.vscdb`);
      try {
        // Only this exact key — workspace ItemTable is UI state, but stay narrow anyway.
        const row = db
          .prepare(`SELECT value FROM ItemTable WHERE key = 'composer.composerData'`)
          .get() as { value?: string } | undefined;
        if (row?.value) {
          const data = JSON.parse(row.value);
          for (const c of data.allComposers ?? []) {
            if (typeof c?.composerId === 'string') map.set(c.composerId, project);
          }
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return map;
}

export function collectCursor(userDir: string = cursorUserDir()): { events: UsageEvent[]; result: CollectResult } {
  const events: UsageEvent[] = [];
  const globalDb = join(userDir, 'globalStorage', 'state.vscdb');
  if (!existsSync(globalDb)) {
    return { events, result: { source: 'cursor', filesScanned: 0, eventsFound: 0, eventsInserted: 0, note: `${globalDb} not found — Cursor not detected` } };
  }

  const scratch = mkdtempSync(join(tmpdir(), 'tm-cursor-'));
  try {
    const composers = new Map<string, ComposerDoc>();
    const bubbles = new Map<string, Map<string, Bubble>>(); // composerId -> bubbleId -> bubble

    const db = openDbCopy(globalDb, scratch, 'state.vscdb');
    try {
      const rows = db
        .prepare(
          `SELECT key, value FROM cursorDiskKV
           WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'`,
        )
        .all() as Array<{ key: string; value: string | null }>;
      for (const { key, value } of rows) {
        if (!value) continue;
        let doc: unknown;
        try {
          doc = JSON.parse(value);
        } catch {
          continue;
        }
        if (key.startsWith('composerData:')) {
          composers.set(key.slice('composerData:'.length), doc as ComposerDoc);
        } else {
          const [, composerId, bubbleId] = key.split(':');
          if (!composerId || !bubbleId) continue;
          let forComposer = bubbles.get(composerId);
          if (!forComposer) bubbles.set(composerId, (forComposer = new Map()));
          forComposer.set(bubbleId, doc as Bubble);
        }
      }
    } finally {
      db.close();
    }

    const projects = loadWorkspaceMap(userDir, scratch);

    for (const [composerId, composer] of composers) {
      const byId = bubbles.get(composerId);
      if (!byId || byId.size === 0) continue;
      const headers = composer.fullConversationHeadersOnly ?? [];
      const ordered: Array<[string, Bubble]> = headers.length
        ? headers.flatMap((h) => {
            const b = h.bubbleId ? byId.get(h.bubbleId) : undefined;
            return b && h.bubbleId ? [[h.bubbleId, b] as [string, Bubble]] : [];
          })
        : [...byId.entries()];

      const project = projects.get(composerId) ?? 'unknown';
      let tools: string[] = [];
      let commands: string[] = [];
      let isError = false;
      // Carry the latest user prompt forward to the turn-final assistant bubble
      // that it triggered — that's the only bubble we emit an event for.
      let lastUserText: string | undefined;

      for (const [bubbleId, bubble] of ordered) {
        if (bubble.type === 1 && typeof bubble.text === 'string' && bubble.text.trim()) {
          lastUserText = bubble.text.trim();
        }
        const tf = bubble.toolFormerData;
        if (tf?.name) {
          tools.push(tf.name);
          if (tf.status === 'error' || tf.status === 'failed') isError = true;
          if (SHELL_TOOL_RE.test(tf.name) && typeof tf.rawArgs === 'string') {
            try {
              const cmd = JSON.parse(tf.rawArgs).command;
              if (typeof cmd === 'string') commands.push(cmd);
            } catch { /* ignore */ }
          }
        }
        const input = bubble.tokenCount?.inputTokens ?? 0;
        const output = bubble.tokenCount?.outputTokens ?? 0;
        // Zero on intermediate bubbles; the turn-final bubble carries turn totals.
        if (input === 0 && output === 0) continue;

        const modelName = bubble.modelInfo?.modelName ?? composer.modelConfig?.modelName;
        const ts =
          bubble.createdAt ??
          (composer.lastUpdatedAt ? new Date(composer.lastUpdatedAt).toISOString() : new Date(0).toISOString());
        const ev: UsageEvent = {
          source: 'cursor',
          eventKey: `${composerId}:${bubbleId}`,
          sessionId: composerId,
          project,
          timestamp: ts,
          model: !modelName || modelName === 'default' ? 'cursor-auto' : modelName,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          thinkingTokens: 0,
          tools,
          commands,
          hasThinking: false,
          isError,
          intentText: lastUserText || undefined,
        };
        ev.activity = classify(ev);
        events.push(ev);
        tools = [];
        commands = [];
        isError = false;
      }
    }

    return {
      events,
      result: {
        source: 'cursor',
        filesScanned: 1,
        eventsFound: events.length,
        eventsInserted: 0,
        note: events.length > 0 ? 'tokens cover completed turns only; Cursor does not persist cache tokens or the resolved model locally' : undefined,
      },
    };
  } catch (err) {
    return {
      events: [],
      result: { source: 'cursor', filesScanned: 1, eventsFound: 0, eventsInserted: 0, note: `cursor parse failed: ${err instanceof Error ? err.message : String(err)}` },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
