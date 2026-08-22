import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoredEvent } from './store.js';
import { loadEvents, findSessions } from './store.js';
import { parseResultChars, parseTools } from './metrics.js';
import { serverOf } from './tool-surface.js';
import { toolClass } from './classify.js';

/**
 * Turn one real session into a synthetic transcript a contributor can commit.
 *
 * Writing a waste rule needs data with the shape of real work in it — a fix
 * loop, a fan-out, a session that bloats — and the only corpus for that is
 * whatever happens to be on the author's own machine. This command makes that
 * corpus shareable.
 *
 * The privacy argument is structural rather than a promise: the generator
 * reads the DATABASE, not the transcript, and the database has no column that
 * can hold prompt or response text. What survives is what the rules actually
 * measure — turn count, timing, token counts, model, tool names, error flags,
 * result SIZES, the sidechain structure — and everything else is synthesized.
 *
 * The three judgement calls, all made toward saying less:
 *
 * - **Projects and branches** become `project-1`, `main`. A branch name is the
 *   same sensitivity class as a file path: it names features and clients.
 * - **MCP tool names** become `mcp__server-1__tool-1`. Built-in tool names are
 *   kept, because which built-in was called is the signal a rule reads and
 *   `Bash` says nothing about anyone. Server names are local-only everywhere
 *   else in this codebase, and a donated fixture is the most public artifact
 *   there is.
 * - **Timestamps** are shifted so the first turn lands on a fixed date, with
 *   every gap preserved exactly. Gaps are what cold-restart and session-shape
 *   rules measure; the wall-clock hour someone works is nobody's business.
 */

/** Every donated fixture starts here, so two donations diff against each other. */
const EPOCH = Date.parse('2026-01-01T09:00:00.000Z');

export interface DonateResult {
  /** Files written, relative to the output directory. */
  files: string[];
  /** Total bytes written — a fixture nobody wants to review is not a fixture. */
  bytes: number;
  sessionId: string;
  turns: number;
  agentRuns: number;
  /** Milliseconds every timestamp was shifted by. */
  shiftMs: number;
}

/**
 * A stand-in name for each class of tool, chosen so the CLASSIFIER sees the
 * same thing it saw originally. A server's tool called `read_file` is read-only
 * work; renaming it to `tool-1` would make the donated turn classify as coding
 * (unknown tools act on the world) and quietly change the session's activity
 * mix — which is exactly what a rule under test is reading.
 */
const CLASS_STANDIN: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  shell: 'run_command',
  plan: 'todowrite',
  interactive: 'ask_user',
};

/** Tool names a rule can read without naming anyone: built-ins keep their name. */
export function anonymizeTool(tool: string, servers: Map<string, number>, tools: Map<string, number>): string {
  const server = serverOf(tool);
  if (!server) return tool;
  if (!servers.has(server)) servers.set(server, servers.size + 1);
  if (!tools.has(tool)) tools.set(tool, tools.size + 1);
  const standin = CLASS_STANDIN[toolClass(tool)] ?? `tool-${tools.get(tool)}`;
  return `mcp__server-${servers.get(server)}__${standin}`;
}

/**
 * A shell command that re-classifies to the activity the stored turn had.
 *
 * The fixture has to survive a round trip: `collect` re-derives activity from
 * tools and commands, so a donated turn whose command is dropped would come
 * back as a different activity and the rule under test would see a different
 * session. Real command strings can carry paths, hostnames and ticket ids, so
 * they are replaced rather than kept.
 */
function commandFor(activity: string): string | undefined {
  if (activity === 'testing') return 'npm test';
  if (activity === 'shipping') return 'git commit -m "synthetic"';
  return undefined;
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** One turn as the Claude Code transcript format writes it, plus its result sizes. */
function turnLines(
  e: StoredEvent,
  index: number,
  opts: { shiftMs: number; sidechain?: { agentId: string; parentSessionId: string }; sessionId: string; servers: Map<string, number>; toolIds: Map<string, number> },
): string[] {
  const uuid = `${opts.sidechain ? opts.sidechain.agentId : opts.sessionId}-t${index}`;
  const ts = new Date(Date.parse(e.ts) + opts.shiftMs).toISOString();
  const tools = parseTools(e.tools).map((t) => anonymizeTool(t, opts.servers, opts.toolIds));
  const sizes = parseResultChars(e.tool_result_chars);
  const command = commandFor(e.activity);

  const content: unknown[] = [];
  if (e.has_thinking) content.push({ type: 'thinking', thinking: 'synthetic' });
  if (tools.length === 0) content.push({ type: 'text', text: 'synthetic' });
  tools.forEach((name, i) => {
    content.push({
      type: 'tool_use',
      id: `${uuid}-c${i}`,
      name,
      // Only the shell-command field is reproduced, and only as the generic
      // string the classifier needs; no other tool input is carried at all.
      input: command && i === 0 ? { command } : {},
    });
  });

  const out = [
    line({
      type: 'assistant',
      uuid,
      sessionId: opts.sidechain ? opts.sidechain.parentSessionId : opts.sessionId,
      ...(opts.sidechain ? { agentId: opts.sidechain.agentId, isSidechain: true, ...(e.agent_type ? { attributionAgent: 'general-purpose' } : {}) } : {}),
      cwd: '/Users/dev/project-1',
      gitBranch: 'main',
      timestamp: ts,
      message: {
        model: e.model,
        usage: {
          input_tokens: e.input_tokens,
          output_tokens: e.output_tokens,
          cache_read_input_tokens: e.cache_read_tokens,
          cache_creation_input_tokens: e.cache_creation_tokens,
          ...(e.cache_creation_1h_tokens
            ? { cache_creation: { ephemeral_5m_input_tokens: Math.max(0, e.cache_creation_tokens - e.cache_creation_1h_tokens), ephemeral_1h_input_tokens: e.cache_creation_1h_tokens } }
            : {}),
        },
        content,
      },
    }),
  ];

  // Results: one user line carrying an is_error flag where the turn failed and
  // a padded body of exactly the recorded LENGTH — the size is the datum, the
  // characters are filler.
  const results = tools
    .map((name, i) => {
      const original = parseTools(e.tools)[i];
      const chars = sizes[original] ?? 0;
      const isError = e.is_error === 1 && i === 0;
      if (chars === 0 && !isError) return undefined;
      return {
        type: 'tool_result',
        tool_use_id: `${uuid}-c${i}`,
        ...(isError ? { is_error: true } : {}),
        content: 'x'.repeat(chars),
      };
    })
    .filter(Boolean);
  if (results.length > 0) {
    out.push(
      line({
        type: 'user',
        uuid: `${uuid}-r`,
        sessionId: opts.sidechain ? opts.sidechain.parentSessionId : opts.sessionId,
        timestamp: ts,
        message: { content: results },
      }),
    );
  }
  return out;
}

/**
 * Build the fixture for one session. Subagent runs are emitted as their own
 * `subagents/agent-<n>.jsonl` files under the session directory, because the
 * fan-out IS the shape a lot of interesting rules need and it exists nowhere
 * else in the fixture corpus.
 */
export function buildDonation(
  db: DatabaseSync,
  sessionId: string,
  opts: { now?: number } = {},
): { files: Array<{ path: string; body: string }>; result: DonateResult } {
  const rows = loadEvents(db, { session: sessionId });
  if (rows.length === 0) throw new Error(`no stored turns for session ${sessionId}`);
  const agents = loadEvents(db, {}).filter((e) => e.is_sidechain === 1 && e.parent_session_id === sessionId);

  const first = Math.min(...[...rows, ...agents].map((e) => Date.parse(e.ts)));
  const shiftMs = EPOCH - first;
  const servers = new Map<string, number>();
  const toolIds = new Map<string, number>();
  const dir = '-Users-dev-project-1';
  const synthetic = 'session-1';

  const main = rows
    .filter((e) => e.is_sidechain !== 1)
    .flatMap((e, i) => turnLines(e, i, { shiftMs, sessionId: synthetic, servers, toolIds }));

  const files = [{ path: join(dir, `${synthetic}.jsonl`), body: main.join('\n') + '\n' }];

  const byAgent = new Map<string, StoredEvent[]>();
  for (const e of agents) {
    const list = byAgent.get(e.session_id) ?? [];
    list.push(e);
    byAgent.set(e.session_id, list);
  }
  let n = 0;
  for (const [, runRows] of byAgent) {
    n++;
    const agentId = String(n);
    const body = runRows
      .flatMap((e, i) => turnLines(e, i, { shiftMs, sessionId: synthetic, servers, toolIds, sidechain: { agentId, parentSessionId: synthetic } }))
      .join('\n');
    // The adapter keys a run on the id in its FILENAME (`agent-<id>.jsonl`),
    // so the id and the name have to agree.
    files.push({ path: join(dir, synthetic, 'subagents', `agent-${agentId}.jsonl`), body: body + '\n' });
  }

  return {
    files,
    result: {
      files: files.map((f) => f.path),
      bytes: files.reduce((n, f) => n + Buffer.byteLength(f.body), 0),
      sessionId: synthetic,
      turns: main.length > 0 ? rows.filter((e) => e.is_sidechain !== 1).length : 0,
      agentRuns: byAgent.size,
      shiftMs,
    },
  };
}

export function writeDonation(outDir: string, files: Array<{ path: string; body: string }>): void {
  for (const f of files) {
    const full = join(outDir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.body);
  }
}

/** Resolve a session id or unique prefix; throws with guidance when ambiguous. */
export function resolveSession(db: DatabaseSync, prefix: string): string {
  const matches = findSessions(db, prefix);
  if (matches.length === 0) throw new Error(`no session id starts with "${prefix}" — ids are printed as evidence by \`report\``);
  if (matches.length > 1) {
    const list = matches.slice(0, 5).map((m) => `  ${m.session_id}  ${m.turns} turns, last ${m.last_ts.slice(0, 10)}`).join('\n');
    throw new Error(`"${prefix}" matches ${matches.length} sessions:\n${list}\nUse more characters.`);
  }
  return matches[0].session_id;
}
