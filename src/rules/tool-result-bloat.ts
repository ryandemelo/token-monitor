import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

/**
 * Volume gate. The carry share is a ratio of estimates, and on a handful of
 * turns it swings wildly — this is the number of measured result-bearing turns
 * below which the finding stays quiet.
 */
const MIN_MEASURED_TURNS = 40;

const rule: Rule = {
  key: 'tool-result-bloat',
  metric: 'toolResultCarryShare',
  direction: 'down',
  family: 'caching',
  title: 'Tool results riding along after they were read',
  docs: `A tool result is not paid once. It enters the context and is re-read in
every later request of that session, so a 40k-token search result on turn 3 of a
30-turn session is carried ~27 more times. This rule measures those carried
tokens as a share of all input-side tokens in the window.

Estimated, and marked as such: result sizes come from the transcript in
characters and are converted at ~4 chars per token. A result stops being carried
when its session ends or its context collapses — compaction and /clear are not
written to the transcript, but the drop they cause is, and that is what the
horizon is cut at. The total is additionally clamped per session to the
input-side tokens that session actually paid, so it can never claim more context
than was provably bought.

The remedy is usually a flag rather than a workflow change: bound the output
(head/tail, a line limit, a narrower glob), page the MCP call, or send the big
result to a subagent whose context ends with it. \`token-monitor context\` names
the specific tools.

Fires above 25% carry share once at least ${MIN_MEASURED_TURNS} turns have
measurable results. Sources that do not persist tool results report nothing
here — never zero.`,
  fires: (m) =>
    (m.toolResultTurns ?? 0) >= MIN_MEASURED_TURNS && (m.toolResultCarryShare ?? 0) >= 0.25
      ? `~${(m.toolResultCarryShare * 100).toFixed(0)}% of the context you paid for is tool results still riding along after they were read (~${fmtTokens(m.toolResultCarryTokens)} carried tokens). Bound the big outputs — a line limit, a narrower search, or a paged call — and run \`context\` to see which tools return the most.`
      : undefined,
  score: (s) => ({
    score: s.m.toolResultCarryTokens ?? 0,
    label: `~${fmtTokens(s.m.toolResultCarryTokens ?? 0)} carried tok`,
  }),
  target: 0.1,
  personalTarget: { metric: (m) => m.toolResultCarryShare ?? 0, direction: 'down' },
  savings: ({ m, rates, target }) => {
    // Carried context is re-read from cache, so it is priced at the cache-read
    // rate — the conservative end. Trimming it also avoids the cache WRITE that
    // put it there, which this deliberately does not count.
    const inputSide = m.cacheReadTokens + m.inputTokens + m.cacheCreationTokens;
    const moved = Math.max(0, (m.toolResultCarryShare ?? 0) - (target?.value ?? 0)) * inputSide;
    return moved * rates.cacheRead;
  },
};
export default rule;
