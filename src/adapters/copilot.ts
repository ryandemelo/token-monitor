import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';
import { familyOf } from '../project-family.js';

/**
 * EXPERIMENTAL — VS Code Copilot Chat persists sessions under
 * <User dir>/workspaceStorage/<hash>/chatSessions/ as either *.json (full
 * serialized session) or *.jsonl (line 0 = {kind: 0, v: <full session>},
 * later lines are incremental ops we don't apply). Copilot does NOT record
 * token usage locally, so per issue #11 token counts are ESTIMATED from
 * text length (~4 chars/token) and flagged as such in the collect note and
 * via the model name suffix. Turn counts, timestamps, tools, and error
 * linkage are real.
 */

export function codeUserDir(home: string = homedir()): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User');
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return join(home, '.config', 'Code', 'User');
}

interface ChatRequest {
  requestId?: string;
  timestamp?: number;
  modelId?: string;
  isCanceled?: boolean;
  message?: { text?: string };
  response?: unknown[];
  result?: { errorDetails?: { message?: string } };
}

interface ChatSession {
  sessionId?: string;
  creationDate?: number;
  lastMessageDate?: number;
  requests?: ChatRequest[];
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Harvest assistant-visible text and tool names from a response part array. */
function walkResponse(parts: unknown[]): { text: string; tools: string[]; commands: string[] } {
  let text = '';
  const tools: string[] = [];
  const commands: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (typeof p.value === 'string') text += p.value;
    else if (p.value && typeof (p.value as { value?: unknown }).value === 'string') {
      text += (p.value as { value: string }).value;
    }
    if (p.content && typeof (p.content as { value?: unknown }).value === 'string') {
      text += (p.content as { value: string }).value;
    }
    if (p.kind === 'toolInvocationSerialized' || p.kind === 'toolInvocation') {
      const name = (p.toolId ?? p.toolName ?? 'tool') as string;
      tools.push(name);
      if (/terminal|shell|command/i.test(name)) {
        const inv = p.invocationMessage as { value?: string } | string | undefined;
        const msg = typeof inv === 'string' ? inv : inv?.value;
        if (typeof msg === 'string') commands.push(msg.replace(/`/g, ''));
      }
    }
  }
  return { text, tools, commands };
}

function parseSessionFile(path: string): ChatSession | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    if (path.endsWith('.jsonl')) {
      const first = raw.slice(0, raw.indexOf('\n') === -1 ? raw.length : raw.indexOf('\n'));
      const line = JSON.parse(first);
      // kind 0 = initial full snapshot; later incremental ops are not applied.
      return line?.kind === 0 ? (line.v as ChatSession) : undefined;
    }
    return JSON.parse(raw) as ChatSession;
  } catch {
    return undefined;
  }
}

function projectOf(wsDir: string): string {
  try {
    const ws = JSON.parse(readFileSync(join(wsDir, 'workspace.json'), 'utf8'));
    const folder = ws.folder ?? ws.workspace;
    if (typeof folder === 'string') {
      const path = decodeURIComponent(folder.replace(/^file:\/\//, ''));
      return familyOf(path) ?? basename(path);
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

export function collectCopilot(userDir: string = codeUserDir()): { events: UsageEvent[]; result: CollectResult } {
  const events: UsageEvent[] = [];
  let filesScanned = 0;
  const wsRoot = join(userDir, 'workspaceStorage');
  if (!existsSync(wsRoot)) {
    return { events, result: { source: 'copilot', filesScanned: 0, eventsFound: 0, eventsInserted: 0, note: `${wsRoot} not found — VS Code not detected` } };
  }

  for (const dir of readdirSync(wsRoot)) {
    const sessionsDir = join(wsRoot, dir, 'chatSessions');
    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const project = projectOf(join(wsRoot, dir));

    for (const file of files) {
      filesScanned++;
      const session = parseSessionFile(join(sessionsDir, file));
      if (!session) continue;
      const sessionId = session.sessionId ?? basename(file).replace(/\.jsonl?$/, '');
      (session.requests ?? []).forEach((req, i) => {
        const userText = typeof req.message?.text === 'string' ? req.message.text : '';
        const { text: responseText, tools, commands } = walkResponse(req.response ?? []);
        if (!userText && !responseText) return;
        const ts = req.timestamp ?? session.lastMessageDate ?? session.creationDate;
        const ev: UsageEvent = {
          source: 'copilot',
          eventKey: `${sessionId}:${req.requestId ?? i}`,
          sessionId,
          project,
          timestamp: ts ? new Date(ts).toISOString() : new Date(0).toISOString(),
          // Suffix marks every per-model rollup row as an estimate.
          model: `${req.modelId ?? 'copilot'} (est)`,
          inputTokens: estimateTokens(userText),
          outputTokens: estimateTokens(responseText),
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          thinkingTokens: 0,
          tools,
          commands,
          hasThinking: false,
          isError: !!req.result?.errorDetails && !req.isCanceled,
          intentText: userText || undefined,
        };
        ev.activity = classify(ev);
        events.push(ev);
      });
    }
  }

  return {
    events,
    result: {
      source: 'copilot',
      filesScanned,
      eventsFound: events.length,
      eventsInserted: 0,
      note:
        events.length > 0
          ? 'EXPERIMENTAL — Copilot Chat does not record token usage; counts estimated from text length (~4 chars/token)'
          : undefined,
    },
  };
}
