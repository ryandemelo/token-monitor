import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';

const ROOT = join(homedir(), '.claude', 'projects');

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
    content?: Array<{
      type: string;
      name?: string;
      id?: string;
      input?: { command?: string };
      tool_use_id?: string;
      is_error?: boolean;
    }>;
  };
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
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let d: ClaudeLine;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d.type === 'user' && Array.isArray(d.message?.content)) {
          for (const block of d.message.content) {
            if (block.type === 'tool_result' && block.is_error && block.tool_use_id) {
              const ev = byToolUseId.get(block.tool_use_id);
              if (ev) ev.isError = true;
            }
          }
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
        for (const block of d.message.content ?? []) {
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
