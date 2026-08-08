export type Source = 'claude-code' | 'gemini-cli' | 'codex' | 'cursor' | 'antigravity' | 'copilot';

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
  /**
   * The share of cacheCreationTokens written against the 1-HOUR ephemeral
   * cache rather than the default 5-minute one. Only Claude Code reports the
   * split; absent (treated as 0) everywhere else, which keeps every other
   * source on the 5-minute assumption it has always used.
   */
  cacheCreation1hTokens?: number;
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
  /**
   * Turn came from a subagent (sidechain) transcript rather than the main
   * loop. Claude Code writes each Task/Agent run to its own file under
   * `<session>/subagents/**`; those turns are real spend the main transcript
   * never mentions.
   */
  isSidechain?: boolean;
  /** The session that spawned this one — set only on sidechain turns. */
  parentSessionId?: string;
  /**
   * Subagent type as the harness labelled it ("general-purpose", "Explore").
   * Local-only: it can name a user's private custom agent, so it never enters
   * an export or an LLM payload.
   */
  agentType?: string;
  /**
   * The user's prompt text for this turn, carried in-memory ONLY for `categorize`
   * to derive an on-device intent fingerprint. Never persisted: insertEvents has
   * no column for it. Redaction happens in intent.ts before anything is stored.
   */
  intentText?: string;
}

export interface CollectResult {
  source: Source;
  filesScanned: number;
  eventsFound: number;
  eventsInserted: number;
  /** Historical rows re-attributed to project families by this collect. */
  eventsRelabeled?: number;
  note?: string;
}
