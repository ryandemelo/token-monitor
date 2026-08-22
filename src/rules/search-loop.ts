import type { Rule } from './types.js';
import { SEARCH_LOOP_MIN_RUN } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

const rule: Rule = {
  key: 'search-loop',
  metric: 'searchLoopShare',
  direction: 'down',
  family: 'caching',
  title: 'Unbroken exploration runs that land nothing',
  docs: `Spend on main-loop turns forming an unbroken run of at least
${SEARCH_LOOP_MIN_RUN} read-only exploration turns: reading, searching,
globbing, fetching, over and over with no coding, testing, planning or
shipping turn anywhere in between. Past that length the run has stopped being
research and become the agent re-orienting because it lost the thread (or was
never given one). It is the cheapest kind of waste to fix: the remedy is
context hygiene, so the rule shares the caching family.

Main loop only. A subagent's job IS long unbroken reading; an explore agent
that pauses to edit is the broken one, so fan-outs are excluded rather than
flagged. Runs shorter than the floor stay quiet too: a focused dig of a few
read-only turns is exactly what an agent should be doing.

Savings price only what sits PAST the floor inside each qualifying run: the
first ${SEARCH_LOOP_MIN_RUN} turns of every run are treated as legitimate
research, which keeps the number conservative and easy to defend.`,
  fires: (m) =>
    m.searchLoopRuns > 0
      ? `${m.searchLoopRuns} unbroken exploration run(s) of ${SEARCH_LOOP_MIN_RUN}+ read-only turns across ${m.searchLoopSessions} session(s): ${fmtTokens(m.searchLoopTokens)} of spend, the longest ${m.searchLoopLongestRun} turns straight. Name the files up front or hand the agent a written plan; a loop that long is re-orienting, not researching.`
      : undefined,
  score: (s) => ({
    score: s.m.searchLoopTokens,
    label: `${s.m.searchLoopLongestRun}-turn unbroken explore`,
  }),
  savings: ({ m, rates }) => m.searchLoopExcessTokens * rates.spend,
};
export default rule;
