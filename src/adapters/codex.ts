import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';

const ROOT = join(homedir(), '.codex', 'sessions');

/**
 * EXPERIMENTAL — written from the documented Codex CLI rollout format
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl); not yet validated against
 * a live install. Each line is {timestamp, type, payload}. Cumulative token
 * usage arrives in event_msg/token_count payloads; we diff consecutive
 * counts to attribute per-turn usage, and collect function_call items seen
 * since the previous count as that turn's tools.
 */

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    model?: string;
    name?: string;
    arguments?: string;
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
    };
  };
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) yield p;
  }
}

export function collectCodex(root: string = ROOT): { events: UsageEvent[]; result: CollectResult } {
  const events: UsageEvent[] = [];
  let filesScanned = 0;
  if (!existsSync(root)) {
    return { events, result: { source: 'codex', filesScanned: 0, eventsFound: 0, eventsInserted: 0, note: `${root} not found — Codex CLI not detected` } };
  }

  for (const file of walk(root)) {
    filesScanned++;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let sessionId = basename(file, '.jsonl');
    let project = 'unknown';
    let model = 'codex';
    let prev: TokenUsage | null = null;
    let pendingTools: string[] = [];
    let pendingCommands: string[] = [];
    let tick = 0;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d: CodexLine;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const p = d.payload;
      if (!p) continue;
      if (d.type === 'session_meta' || p.type === 'session_meta') {
        if (p.id) sessionId = p.id;
        if (p.cwd) project = basename(p.cwd);
      } else if (p.type === 'turn_context' && p.model) {
        model = p.model;
      } else if (d.type === 'response_item' && p.type === 'function_call' && p.name) {
        pendingTools.push(p.name);
        if (/shell|exec/.test(p.name) && typeof p.arguments === 'string') {
          try {
            const args = JSON.parse(p.arguments);
            const cmd = Array.isArray(args.command) ? args.command.join(' ') : args.command;
            if (typeof cmd === 'string') pendingCommands.push(cmd);
          } catch { /* ignore */ }
        }
      } else if (d.type === 'event_msg' && p.type === 'token_count' && p.info) {
        const total = p.info.total_token_usage ?? p.info.last_token_usage;
        if (!total) continue;
        const delta: TokenUsage = prev
          ? {
              input_tokens: Math.max(0, (total.input_tokens ?? 0) - (prev.input_tokens ?? 0)),
              cached_input_tokens: Math.max(0, (total.cached_input_tokens ?? 0) - (prev.cached_input_tokens ?? 0)),
              output_tokens: Math.max(0, (total.output_tokens ?? 0) - (prev.output_tokens ?? 0)),
              reasoning_output_tokens: Math.max(0, (total.reasoning_output_tokens ?? 0) - (prev.reasoning_output_tokens ?? 0)),
            }
          : total;
        prev = total;
        tick++;
        const ev: UsageEvent = {
          source: 'codex',
          eventKey: `${sessionId}:${tick}`,
          sessionId,
          project,
          timestamp: d.timestamp ?? new Date(0).toISOString(),
          model,
          inputTokens: (delta.input_tokens ?? 0) - (delta.cached_input_tokens ?? 0),
          outputTokens: delta.output_tokens ?? 0,
          cacheReadTokens: delta.cached_input_tokens ?? 0,
          cacheCreationTokens: 0,
          thinkingTokens: delta.reasoning_output_tokens ?? 0,
          tools: pendingTools,
          commands: pendingCommands,
          hasThinking: (delta.reasoning_output_tokens ?? 0) > 0,
          isError: false,
        };
        ev.activity = classify(ev);
        events.push(ev);
        pendingTools = [];
        pendingCommands = [];
      }
    }
  }
  return {
    events,
    result: {
      source: 'codex',
      filesScanned,
      eventsFound: events.length,
      eventsInserted: 0,
      note: filesScanned > 0 ? 'codex adapter is experimental — verify totals against `codex` usage screens' : undefined,
    },
  };
}
