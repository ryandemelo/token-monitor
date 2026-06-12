import type { UsageEvent, CollectResult, Source } from '../types.js';
import { collectClaudeCode } from './claude-code.js';
import { collectGeminiCli } from './gemini-cli.js';
import { collectCodex } from './codex.js';
import { collectCursor } from './cursor.js';
import { collectAntigravity } from './antigravity.js';

export type Adapter = () => { events: UsageEvent[]; result: CollectResult };

/**
 * Adapter registry. To support a new agent CLI, add a module that parses its
 * local logs into UsageEvent[] and register it here — see CONTRIBUTING in the
 * README. Adapters must be safe to run when the tool isn't installed
 * (return zero events with a note).
 */
export const ADAPTERS: Record<Source, Adapter> = {
  'claude-code': collectClaudeCode,
  'gemini-cli': collectGeminiCli,
  codex: collectCodex,
  cursor: collectCursor,
  antigravity: collectAntigravity,
};
