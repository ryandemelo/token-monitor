import type { StoredEvent } from './store.js';
import { groupBy, parseTools, parseResultChars, estTokens, carriedTurnsOf } from './metrics.js';
import { costOf } from './pricing.js';
import type { BlendedRates } from './rules/types.js';
import { declaredMcpServers } from './mcp-config.js';

/**
 * Context economics: what the standing tool surface costs.
 *
 * Every other measurement in this tool prices what a turn DID. This one prices
 * what a turn had to carry before it did anything — the results still riding in
 * the context, and the servers whose definitions are re-read on every request.
 *
 * Three facts, all derived from data already collected:
 *
 * - per-MCP-server spend, from the `mcp__<server>__<tool>` names already stored
 *   raw in `events.tools` (only the classifier strips the prefix);
 * - the carry tax per tool — result size × the turns it survived;
 * - which connected servers were never invoked at all.
 *
 * Server and tool names never leave the machine: they are local display only,
 * exactly like `agentType`.
 */

/** `mcp__server__tool` -> `server`; undefined for a built-in tool. */
export function serverOf(tool: string): string | undefined {
  const parts = tool.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' && parts[1] ? parts[1] : undefined;
}

/**
 * A tool name safe to send off the machine: the server identity is dropped,
 * the tool kept. `mcp__acme_billing__refund` -> `mcp:refund`. Which tool keeps
 * failing is the signal; WHOSE server it is can name a client or an internal
 * system, and that is the same line `agentType` draws.
 */
export function redactToolName(tool: string): string {
  const parts = tool.split('__');
  return serverOf(tool) ? `mcp:${parts.slice(2).join('__')}` : tool;
}

export interface ToolCarryStat {
  tool: string;
  server?: string;
  /** Turns on which this tool returned something measurable. */
  calls: number;
  returnedTokens: number;
  carryTokens: number;
  /** Mean number of later turns each result rode along in. */
  avgCarriedTurns: number;
  /** Carry priced at the blended cache-read rate; 0 when no rates were given. */
  carryUsd: number;
}

export interface ServerStat {
  server: string;
  tools: number;
  turns: number;
  spendTokens: number;
  costUsd: number;
  returnedTokens: number;
  carryTokens: number;
  errorTurns: number;
  errorRate: number;
  lastUsed: string;
}

export interface ToolSurface {
  tools: ToolCarryStat[];
  servers: ServerStat[];
  /** Connected servers, from the local agent config. Local display only. */
  declaredServers: string[];
  /** Connected but never invoked in this window — still paying their definitions. */
  unusedServers: string[];
  /**
   * Servers that were invoked but appear in no config we can read (project
   * `.mcp.json`, a plugin). Their existence means the connected list is a
   * lower bound, so `unusedServers` must be read as "of the ones we can see".
   */
  undeclaredServers: string[];
  /** Why declaredServers is empty, when it is. */
  configNote?: string;
  /**
   * False when no source in this window persists tool results. The carry
   * numbers then describe nothing and must be reported as unmeasured rather
   * than as zero.
   */
  measured: boolean;
  totalReturnedTokens: number;
  totalCarryTokens: number;
  totalCarryUsd: number;
}

export function computeToolSurface(
  events: StoredEvent[],
  opts: { rates?: BlendedRates; configPath?: string } = {},
): ToolSurface {
  const tools = new Map<string, { calls: number; returned: number; carry: number; carried: number }>();
  const servers = new Map<string, {
    tools: Set<string>; turns: number; spend: number; cost: number;
    returned: number; carry: number; errors: number; last: string;
  }>();
  let measured = false;

  for (const [, arr] of groupBy(events, 'session_id')) {
    // Same carry horizon computeMetrics uses, so the per-tool table and the
    // headline can never disagree about one session.
    const carried = carriedTurnsOf(arr);
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      const remaining = carried[i];
      const sizes = parseResultChars(e.tool_result_chars);
      if (Object.keys(sizes).length > 0) measured = true;
      for (const [tool, chars] of Object.entries(sizes)) {
        if (!(chars > 0)) continue;
        const est = estTokens(chars);
        const t = tools.get(tool) ?? { calls: 0, returned: 0, carry: 0, carried: 0 };
        t.calls++;
        t.returned += est;
        t.carry += est * remaining;
        t.carried += remaining;
        tools.set(tool, t);
      }

      const spend = e.input_tokens + e.output_tokens;
      const cost = costOf(e.model, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_creation_tokens).usd;
      // One turn can call several tools from the same server; the server is
      // credited once per turn so shares stay comparable with activity shares.
      const seen = new Set<string>();
      for (const tool of parseTools(e.tools)) {
        const name = serverOf(tool);
        if (!name) continue;
        const s = servers.get(name) ?? {
          tools: new Set<string>(), turns: 0, spend: 0, cost: 0,
          returned: 0, carry: 0, errors: 0, last: e.ts,
        };
        s.tools.add(tool);
        if (!seen.has(name)) {
          seen.add(name);
          s.turns++;
          s.spend += spend;
          s.cost += cost;
          if (e.is_error) s.errors++;
        }
        const chars = sizes[tool] ?? 0;
        if (chars > 0) {
          s.returned += estTokens(chars);
          s.carry += estTokens(chars) * remaining;
        }
        if (e.ts > s.last) s.last = e.ts;
        servers.set(name, s);
      }
    }
  }

  const cacheRead = opts.rates?.cacheRead ?? 0;
  const toolRows: ToolCarryStat[] = [...tools.entries()]
    .map(([tool, t]) => ({
      tool,
      server: serverOf(tool),
      calls: t.calls,
      returnedTokens: t.returned,
      carryTokens: t.carry,
      avgCarriedTurns: t.calls ? t.carried / t.calls : 0,
      carryUsd: t.carry * cacheRead,
    }))
    .sort((a, b) => b.carryTokens - a.carryTokens);

  const serverRows: ServerStat[] = [...servers.entries()]
    .map(([server, s]) => ({
      server,
      tools: s.tools.size,
      turns: s.turns,
      spendTokens: s.spend,
      costUsd: s.cost,
      returnedTokens: s.returned,
      carryTokens: s.carry,
      errorTurns: s.errors,
      errorRate: s.turns ? s.errors / s.turns : 0,
      lastUsed: s.last.slice(0, 10),
    }))
    .sort((a, b) => b.spendTokens - a.spendTokens);

  const declared = declaredMcpServers(opts.configPath);
  const used = new Set(serverRows.map((s) => s.server));
  return {
    tools: toolRows,
    servers: serverRows,
    declaredServers: declared.servers,
    unusedServers: declared.servers.filter((s) => !used.has(s)),
    undeclaredServers: serverRows.map((s) => s.server).filter((s) => !declared.servers.includes(s)),
    configNote: declared.note,
    measured,
    totalReturnedTokens: toolRows.reduce((n, t) => n + t.returnedTokens, 0),
    totalCarryTokens: toolRows.reduce((n, t) => n + t.carryTokens, 0),
    totalCarryUsd: toolRows.reduce((n, t) => n + t.carryUsd, 0),
  };
}
