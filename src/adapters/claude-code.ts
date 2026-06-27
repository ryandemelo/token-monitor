import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';

const ROOT = join(homedir(), '.claude', 'projects');

/**
 * User declinations arrive as is_error tool_results but are choices, not
 * failures — counting them poisons tool-error and rework metrics. Matches
 * the harness's standard rejection/interruption phrasings.
 */
const DECLINED_RE =
  /user doesn't want to proceed|tool use was rejected|user rejected|request interrupted by user|user declined/i;

export function isDeclination(content: unknown): boolean {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
        : '';
  return DECLINED_RE.test(text);
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    // User messages can be a plain string or a block array; assistant messages
    // are always a block array.
    content?: string | ContentBlock[];
  };
}

interface ContentBlock {
  type: string;
  name?: string;
  id?: string;
  text?: string;
  input?: { command?: string };
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** Pull the user's typed text out of a `user` line (string or text blocks). */
function userText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** Parse Claude Code session transcripts: ~/.claude/projects/<dir>/<session>.jsonl */
export function collectClaudeCode(root: string = ROOT): { events: UsageEvent[]; result: CollectResult } {
  const events: UsageEvent[] = [];
  let filesScanned = 0;
  if (!existsSync(root)) {
    return { events, result: { source: 'claude-code', filesScanned: 0, eventsFound: 0, eventsInserted: 0, note: `${root} not found` } };
  }

  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      filesScanned++;
      let text: string;
      try {
        text = readFileSync(join(dirPath, file), 'utf8');
      } catch {
        continue;
      }
      // tool_use id -> event, so a failed tool_result can flag its turn
      const byToolUseId = new Map<string, UsageEvent>();
      // The most recent genuine user prompt, carried forward onto the assistant
      // turns it triggered (transient — used only by `categorize`).
      let lastUserText = '';
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let d: ClaudeLine;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d.type === 'user') {
          const content = d.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block.type === 'tool_result' &&
                block.is_error &&
                block.tool_use_id &&
                !isDeclination(block.content)
              ) {
                const ev = byToolUseId.get(block.tool_use_id);
                if (ev) ev.isError = true;
              }
            }
          }
          const t = userText(content).trim();
          if (t) lastUserText = t;
          continue;
        }
        if (d.type !== 'assistant' || !d.message?.usage || !d.uuid) continue;
        const u = d.message.usage;
        const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        if (total === 0 && !(u.cache_read_input_tokens || u.cache_creation_input_tokens)) continue;

        const tools: string[] = [];
        const commands: string[] = [];
        let hasThinking = false;
        const toolUseIds: string[] = [];
        const blocks = Array.isArray(d.message.content) ? d.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name) {
            tools.push(block.name);
            if (block.id) toolUseIds.push(block.id);
            if (typeof block.input?.command === 'string') commands.push(block.input.command);
          } else if (block.type === 'thinking') {
            hasThinking = true;
          }
        }

        const ev: UsageEvent = {
          source: 'claude-code',
          eventKey: d.uuid,
          sessionId: d.sessionId ?? file.replace('.jsonl', ''),
          project: d.cwd ? basename(d.cwd) : dir,
          timestamp: d.timestamp ?? new Date(0).toISOString(),
          model: d.message.model ?? 'unknown',
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
          thinkingTokens: 0,
          tools,
          commands,
          hasThinking,
          isError: false,
          gitBranch: d.gitBranch,
          intentText: lastUserText || undefined,
        };
        ev.activity = classify(ev);
        events.push(ev);
        for (const id of toolUseIds) byToolUseId.set(id, ev);
      }
    }
  }
  return {
    events,
    result: { source: 'claude-code', filesScanned, eventsFound: events.length, eventsInserted: 0 },
  };
}
