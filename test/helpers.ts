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
