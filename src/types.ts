export type Source = 'claude-code' | 'gemini-cli' | 'codex';

export type Activity =
  | 'thinking'
  | 'exploration'
  | 'coding'
  | 'testing'
  | 'shipping'
  | 'conversation';

export const ACTIVITIES: Activity[] = [
  'thinking',
  'exploration',
  'coding',
  'testing',
  'shipping',
  'conversation',
];

/** One assistant turn (or usage tick) in any supported agent, normalized. */
export interface UsageEvent {
  source: Source;
  /** Unique within source — used for dedup across repeated collects. */
  eventKey: string;
  sessionId: string;
  project: string;
  /** ISO 8601 */
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Reported separately only by some vendors (Gemini); 0 when unknown. */
  thinkingTokens: number;
  /** Names of tools invoked in this turn. */
  tools: string[];
  /** Shell command strings, for test/ship detection. */
  commands: string[];
  /** Turn produced visible reasoning (thinking blocks / thoughts). */
  hasThinking: boolean;
  /** A tool in this turn errored (test failure, bad command, etc.). */
  isError: boolean;
  gitBranch?: string;
  activity?: Activity;
}

export interface CollectResult {
  source: Source;
  filesScanned: number;
  eventsFound: number;
  eventsInserted: number;
  note?: string;
}
