import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';

const ROOT = join(homedir(), '.gemini', 'tmp');
const PROJECTS_JSON = join(homedir(), '.gemini', 'projects.json');

interface GeminiMessage {
  id?: string;
  type?: string;
  timestamp?: string;
  model?: string;
  /** User-turn prompt; a plain string or block array. In-memory only, for `categorize`. */
  content?: string | Array<{ text?: string }>;
  tokens?: { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number };
  thoughts?: unknown[];
  toolCalls?: Array<{ name?: string; status?: string; args?: { command?: string } }>;
}

interface GeminiChat {
  sessionId?: string;
  projectHash?: string;
  messages?: GeminiMessage[];
}

/** Flatten a message `content` (plain string or parts array) into one string. */
function textOf(content: string | Array<{ text?: string }> | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((c) => c?.text)
      .filter((x): x is string => typeof x === 'string')
      .join(' ')
      .trim();
  }
  return '';
}

/** ~/.gemini/projects.json maps project paths to the hash dirs under tmp/. */
function loadHashToProject(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const data = JSON.parse(readFileSync(PROJECTS_JSON, 'utf8'));
    const entries = data?.projects ?? data;
    if (entries && typeof entries === 'object') {
      for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
        // Either {path: hash} or {hash: {path}} shapes have been seen across versions.
        if (typeof v === 'string') map.set(v, basename(k));
        else if (v && typeof v === 'object' && typeof (v as { path?: string }).path === 'string') {
          map.set(k, basename((v as { path: string }).path));
        }
      }
    }
  } catch {
    /* optional */
  }
  return map;
}

/** Parse Gemini CLI chat checkpoints: ~/.gemini/tmp/<project>/chats/session-*.json */
export function collectGeminiCli(root: string = ROOT): { events: UsageEvent[]; result: CollectResult } {
  const events: UsageEvent[] = [];
  let filesScanned = 0;
  if (!existsSync(root)) {
    return { events, result: { source: 'gemini-cli', filesScanned: 0, eventsFound: 0, eventsInserted: 0, note: `${root} not found` } };
  }
  const hashToProject = loadHashToProject();

  for (const dir of readdirSync(root)) {
    const chatsDir = join(root, dir, 'chats');
    let files: string[];
    try {
      files = readdirSync(chatsDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    const project = hashToProject.get(dir) ?? (/^[0-9a-f]{40,}$/.test(dir) ? dir.slice(0, 12) : dir);
    for (const file of files) {
      filesScanned++;
      let chat: GeminiChat;
      try {
        chat = JSON.parse(readFileSync(join(chatsDir, file), 'utf8'));
      } catch {
        continue;
      }
      const sessionId = chat.sessionId ?? file;
      // Carry the latest user prompt forward to the assistant turns it triggered.
      let lastUserText: string | undefined;
      for (const m of chat.messages ?? []) {
        if (m.type === 'user') {
          // content may be a plain string or a parts array, depending on version.
          const t = textOf(m.content);
          if (t) lastUserText = t;
          continue;
        }
        if (!m.tokens || !m.id) continue;
        const tools = (m.toolCalls ?? []).map((t) => t.name ?? 'unknown');
        const commands = (m.toolCalls ?? [])
          .map((t) => t.args?.command)
          .filter((c): c is string => typeof c === 'string');
        const isError = (m.toolCalls ?? []).some(
          (t) => t.status === 'error' || t.status === 'failed',
        );
        const ev: UsageEvent = {
          source: 'gemini-cli',
          eventKey: `${sessionId}:${m.id}`,
          sessionId,
          project,
          timestamp: m.timestamp ?? new Date(0).toISOString(),
          model: m.model ?? 'gemini',
          inputTokens: m.tokens.input ?? 0,
          outputTokens: (m.tokens.output ?? 0) + (m.tokens.tool ?? 0),
          cacheReadTokens: m.tokens.cached ?? 0,
          cacheCreationTokens: 0,
          thinkingTokens: m.tokens.thoughts ?? 0,
          tools,
          commands,
          hasThinking: Array.isArray(m.thoughts) && m.thoughts.length > 0,
          isError,
          intentText: lastUserText || undefined,
        };
        ev.activity = classify(ev);
        events.push(ev);
      }
    }
  }
  return {
    events,
    result: { source: 'gemini-cli', filesScanned, eventsFound: events.length, eventsInserted: 0 },
  };
}
