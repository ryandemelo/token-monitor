import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageEvent, CollectResult } from '../types.js';
import { classify } from '../classify.js';
import { sessionProjectOf } from '../project-family.js';

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
  /** Subagent transcripts only: the run's own id, and the type that spawned it. */
  agentId?: string;
  attributionAgent?: string;
  /**
   * Current Claude Code writes this false on every main-loop line and true in
   * agent files. Older versions inlined sidechain turns into the main
   * transcript with this flag set; honouring it keeps those turns out of the
   * main-loop-scoped hygiene metrics.
   */
  isSidechain?: boolean;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      /**
       * Per-TTL breakdown of cache_creation_input_tokens. Present on every
       * assistant line current Claude Code writes; absent on older
       * transcripts, where the whole write is 5-minute by definition.
       */
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
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

/** One parsed turn, still carrying the raw cwd its project is resolved from. */
interface ParsedTurn {
  ev: UsageEvent;
  cwd?: string;
}

interface TranscriptOpts {
  /** Session id for lines that omit one — the transcript's own file id. */
  fallbackSessionId: string;
  /**
   * Present for a subagent transcript. The run gets its OWN session id
   * (`agentId`) plus a link to the session that spawned it — see the comment
   * on collectClaudeCode for why the file's `sessionId` can't be used as-is.
   */
  sidechain?: { agentId: string; parentSessionId: string };
}

/** Parse one JSONL transcript (main-loop or subagent) into usage turns. */
function parseTranscript(text: string, opts: TranscriptOpts): ParsedTurn[] {
  // tool_use id -> event, so a failed tool_result can flag its turn
  const byToolUseId = new Map<string, UsageEvent>();
  // The most recent genuine user prompt, carried forward onto the assistant
  // turns it triggered (transient — used only by `categorize`).
  let lastUserText = '';
  const turns: ParsedTurn[] = [];
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
    const responseParts: string[] = [];
    let hasThinking = false;
    const toolUseIds: string[] = [];
    const blocks = Array.isArray(d.message.content) ? d.message.content : [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        responseParts.push(block.text);
      }
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
      sessionId: opts.sidechain
        ? d.agentId || opts.sidechain.agentId
        : (d.sessionId ?? opts.fallbackSessionId),
      project: '', // assigned per-session by the caller, see collectClaudeCode
      timestamp: d.timestamp ?? new Date(0).toISOString(),
      model: d.message.model ?? 'unknown',
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      cacheCreation1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      thinkingTokens: 0,
      tools,
      commands,
      hasThinking,
      isError: false,
      gitBranch: d.gitBranch,
      // A subagent's "user" prompt is written by the parent agent, not by the
      // human, so it is deliberately NOT carried as intent text: feeding
      // machine-authored task briefs into categorize would drown the handful
      // of sentences the person actually typed.
      intentText: opts.sidechain ? undefined : lastUserText || undefined,
      // Sidechain output is machine-authored and never hand-pasted by a
      // person, so it is not a relay source — same reasoning as intentText.
      responseText: opts.sidechain ? undefined : responseParts.join('\n') || undefined,
    };
    if (opts.sidechain) {
      ev.isSidechain = true;
      ev.parentSessionId = opts.sidechain.parentSessionId;
      if (typeof d.attributionAgent === 'string' && d.attributionAgent) ev.agentType = d.attributionAgent;
    } else if (d.isSidechain === true) {
      // Legacy inline format: the turn belongs to a fan-out even though it
      // lives in the main transcript. It keeps the main session's id (there
      // is no separate transcript to key on) but must not count as main-loop
      // context for the hygiene ratios.
      ev.isSidechain = true;
      ev.parentSessionId = ev.sessionId;
    }
    ev.activity = classify(ev);
    turns.push({ ev, cwd: d.cwd });
    for (const id of toolUseIds) byToolUseId.set(id, ev);
  }
  return turns;
}

/**
 * One project per session: the dominant per-event cwd label after descendant
 * adoption (see project-family.ts). A single-cwd session stays byte-identical
 * to plain basename(cwd). Sessions with no cwd at all are simply absent, and
 * the caller falls back to the log directory name.
 */
function projectsBySession(turns: ParsedTurn[]): Map<string, string> {
  const cwdsBySession = new Map<string, string[]>();
  for (const { ev, cwd } of turns) {
    if (!cwd) continue;
    let list = cwdsBySession.get(ev.sessionId);
    if (!list) cwdsBySession.set(ev.sessionId, (list = []));
    list.push(cwd); // one entry PER EVENT — dominance needs the counts
  }
  const out = new Map<string, string>();
  for (const [sessionId, cwds] of cwdsBySession) {
    const project = sessionProjectOf(cwds);
    if (project) out.set(sessionId, project);
  }
  return out;
}

/**
 * Depth bound for the subagent walk. Observed shapes are `subagents/agent-*`
 * and `subagents/workflows/<run>/agent-*`; the bound just stops an unexpected
 * layout (or a hand-made symlink farm) from turning a collect into a full
 * disk crawl. Dirent.isDirectory() is lstat-based, so symlinked directories
 * are skipped outright and cycles are impossible.
 */
const MAX_SUBAGENT_DEPTH = 6;

function* agentTranscripts(dir: string, depth = 0): Generator<string> {
  if (depth > MAX_SUBAGENT_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* agentTranscripts(p, depth + 1);
    else if (ent.name.startsWith('agent-') && ent.name.endsWith('.jsonl')) yield p;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Parse Claude Code transcripts under ~/.claude/projects/<dir>/:
 *
 *   <session>.jsonl                              main loop
 *   <session>/subagents/agent-<id>.jsonl         one Task/Agent run
 *   <session>/subagents/workflows/<run>/agent-*  workflow fan-out
 *
 * The subagent files are real spend that appears NOWHERE else: current Claude
 * Code stopped inlining sidechain turns into the main transcript (every
 * main-loop line now carries `isSidechain: false`), so a collect that reads
 * only the top level undercounts by however much the fan-out cost — a fifth
 * of a heavy month, measured. Format is vendor-internal and undocumented, so
 * every field is optional and parsing is fail-soft (the Antigravity
 * precedent): an unreadable or reshaped agent file costs its own turns, never
 * the run.
 *
 * Two attribution decisions, both empirical:
 *
 * - **Session id.** An agent transcript's `sessionId` field is the PARENT's,
 *   not its own, so it cannot be used as the session key: folding a fan-out's
 *   interleaved turns into the parent would corrupt every chronology-based
 *   metric (fix loops, cold restarts, context-bloat trend). Each run keys on
 *   its `agentId` instead — a coherent little conversation of its own — and
 *   records the parent in `parentSessionId`, which is what `sessions` counts
 *   and what `categorize` aggregates by.
 * - **Project.** Agent turns inherit the parent session's resolved project
 *   rather than voting with their own cwd, because an isolated agent runs in
 *   a scratch git worktree whose basename would mint a pseudo-project. Their
 *   own cwds are the fallback for the case where the parent transcript is
 *   gone (rotated away) but its subagent directory survives.
 */
export function collectClaudeCode(root: string = ROOT): { events: UsageEvent[]; result: CollectResult } {
  const events: UsageEvent[] = [];
  let filesScanned = 0;
  if (!existsSync(root)) {
    return { events, result: { source: 'claude-code', filesScanned: 0, eventsFound: 0, eventsInserted: 0, note: `${root} not found` } };
  }

  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    // Main-loop transcripts first: their per-session projects are what the
    // subagent runs below inherit.
    const mainTurns: ParsedTurn[] = [];
    for (const ent of entries) {
      // Anything that isn't a directory: Dirent types are lstat-based, so an
      // archived transcript symlinked back into place reports as neither file
      // nor directory, and an isFile() test would silently drop the whole
      // session. readText's try/catch handles a dangling link.
      if (ent.isDirectory() || !ent.name.endsWith('.jsonl')) continue;
      filesScanned++;
      const text = readText(join(dirPath, ent.name));
      if (text === undefined) continue;
      mainTurns.push(
        ...parseTranscript(text, { fallbackSessionId: ent.name.replace(/\.jsonl$/, '') }),
      );
    }
    const projectBySession = projectsBySession(mainTurns);
    for (const { ev } of mainTurns) {
      ev.project = projectBySession.get(ev.sessionId) ?? dir;
      events.push(ev);
    }

    for (const ent of entries) {
      // Symlinked session directories count too, for the same archive-and-
      // link workflow the main-transcript scan supports: collecting a
      // session's main loop while silently dropping its whole fan-out is the
      // exact undercount this adapter exists to fix. The cycle guard lives in
      // agentTranscripts, which only recurses into real directories.
      if (ent.isFile()) continue;
      const subRoot = join(dirPath, ent.name, 'subagents');
      if (!existsSync(subRoot)) continue;
      const parentSessionId = ent.name; // the session directory IS the session id
      for (const file of agentTranscripts(subRoot)) {
        filesScanned++;
        const text = readText(file);
        if (text === undefined) continue;
        const agentId = basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
        const turns = parseTranscript(text, {
          fallbackSessionId: agentId,
          sidechain: { agentId, parentSessionId },
        });
        const own = projectBySession.has(parentSessionId) ? undefined : projectsBySession(turns);
        for (const { ev } of turns) {
          ev.project = projectBySession.get(parentSessionId) ?? own?.get(ev.sessionId) ?? dir;
          events.push(ev);
        }
      }
    }
  }
  return {
    events,
    result: { source: 'claude-code', filesScanned, eventsFound: events.length, eventsInserted: 0 },
  };
}
