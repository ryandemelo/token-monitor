import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which MCP servers are CONNECTED, as opposed to which were actually invoked.
 *
 * A connected server contributes its tool definitions to every request of
 * every session whether or not anything calls it — that is the whole point of
 * the session-floor metric — so the list of declared servers is what turns
 * "nothing invoked server X" into "server X is being paid for and never used".
 *
 * The file is vendor-internal and undocumented, so every field is optional and
 * parsing is fail-soft (the Antigravity precedent): an unreadable or reshaped
 * config costs the comparison, never the command.
 *
 * ONLY THE KEYS ARE READ. A server's `command`, `args` and `env` hold paths,
 * hostnames and credentials; none of them is parsed, stored or printed. The
 * names themselves are treated like `agentType` — local display only, never in
 * an export or an LLM payload, because a server can be named after a client,
 * an internal system or a private endpoint.
 */
const CLAUDE_JSON = join(homedir(), '.claude.json');

export interface DeclaredServers {
  /** Server names declared anywhere in the config, sorted and de-duplicated. */
  servers: string[];
  /** Why the list is empty, when it is. */
  note?: string;
}

function namesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

export function declaredMcpServers(path: string = CLAUDE_JSON): DeclaredServers {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { servers: [], note: 'no Claude Code config found — connected servers unknown' };
  }
  let data: {
    mcpServers?: unknown;
    projects?: Record<string, { mcpServers?: unknown; enabledMcpjsonServers?: unknown }>;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    return { servers: [], note: 'Claude Code config could not be parsed — connected servers unknown' };
  }
  const out = new Set<string>(namesOf(data.mcpServers));
  // Project-scoped servers count too: they are connected for every session in
  // that directory, which is where the spend they explain happens.
  for (const project of Object.values(data.projects ?? {})) {
    for (const name of namesOf(project?.mcpServers)) out.add(name);
    for (const name of namesOf(project?.enabledMcpjsonServers)) out.add(name);
  }
  return { servers: [...out].sort() };
}
