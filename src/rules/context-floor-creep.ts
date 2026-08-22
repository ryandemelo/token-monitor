import type { Rule } from './types.js';
import { FLOOR_MIN_SESSIONS } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

const rule: Rule = {
  key: 'context-floor-creep',
  metric: 'floorShare',
  direction: 'down',
  family: 'caching',
  title: 'A standing context every turn re-reads',
  docs: `Before a session does anything it loads a block of context nobody chose
per-turn: the system prompt, the tool definitions of every connected MCP server,
loaded skills, CLAUDE.md and its imports. It is written once and re-read on every
later request. This rule measures the median first-turn input-side tokens across
main-loop sessions — the floor — and how much of the window's context spend it
accounts for.

The floor is not waste. It is what makes the agent useful, and no target of zero
exists. What matters is whether it is creeping: \`report --trend\` carries a floor
row, and adding an MCP server or a skill pack moves it permanently.

Main-loop only. A subagent run's first turn carries a task brief the user never
typed and cannot trim, and runs outnumber conversations by roughly 14 to 1.

Fires when the floor accounts for at least half of main-loop context spend, over
at least ${FLOOR_MIN_SESSIONS} sessions. The remedy is concrete: disconnect
servers nothing invokes (\`token-monitor context\` lists them), trim CLAUDE.md,
unload skill packs you are not using.`,
  fires: (m) =>
    (m.floorSessions ?? 0) >= FLOOR_MIN_SESSIONS && (m.floorShare ?? 0) >= 0.5
      ? `Your sessions start at ~${fmtTokens(m.sessionFloorTokens)} tokens before you type anything — ${(m.floorShare * 100).toFixed(0)}% of main-loop context spend is that standing floor, re-read every turn. Disconnect MCP servers nothing invokes and trim always-loaded memory files; \`context\` shows what contributes.`
      : undefined,
  score: (s) => {
    const first = s.events.find((e) => !e.is_sidechain);
    const floor = first ? first.input_tokens + first.cache_read_tokens + first.cache_creation_tokens : 0;
    return { score: floor * s.events.length, label: `${fmtTokens(floor)} floor × ${s.events.length} turns` };
  },
  target: 0.35,
  savings: ({ m, rates, target }) => {
    // The floor is re-read from cache on every turn after the first, so the
    // recoverable part is priced at the cache-read rate.
    const moved = Math.max(0, (m.floorShare ?? 0) - (target?.value ?? 0)) * (m.floorBaseTokens ?? 0);
    return moved * rates.cacheRead;
  },
};
export default rule;
