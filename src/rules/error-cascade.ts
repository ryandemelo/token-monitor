import type { Rule } from './types.js';
import { CASCADE_MIN_RUN, errorCascades } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

/** How many of the worst cascades the clause names. */
const TOP_N = 3;

const rule: Rule = {
  key: 'error-cascade',
  metric: 'cascadeShare',
  direction: 'down',
  family: 'rework',
  title: 'Error cascades: retrying against a broken premise',
  docs: `Spend inside runs of ${CASCADE_MIN_RUN}+ consecutive failed turns in one
session. A single failed turn is normal work; a run of them means the agent is
retrying against a broken premise (a wrong path, a missing permission, an
unavailable service) and every iteration re-pays full context to learn the same
thing again. Declinations are excluded upstream: a user saying no is not a
failure.

The accounting is deliberately conservative. The first two turns of every run
are treated as legitimate diagnosis and priced at zero; only the spend beyond
them counts as waste, and savings use that excess at the blended spend rate.
The gate and the message agree by construction: Metrics counts the runs (via
errorCascades) and the rule fires only when that count is above zero, so a
firing finding always has real runs behind it.

The fix is not "retry harder": it is to stop after the second failure and
change exactly one thing: name the wrong premise, then re-run.`,
  fires: (m) =>
    m.cascadeRuns > 0
      ? `${m.cascadeRuns} error cascade(s) this window: ${fmtTokens(m.cascadeTokens)} went to runs of ${CASCADE_MIN_RUN}+ consecutive failed turns, the longest stretching to ${m.longestCascadeRun}. After two failures in a row the next attempt buys nothing new — change one thing first.`
      : undefined,
  score: (s) =>
    s.m.cascadeTokens > 0
      ? {
          score: s.m.cascadeTokens,
          label: `${fmtTokens(s.m.cascadeTokens)} cascade (${s.m.longestCascadeRun}-turn worst)`,
        }
      : { score: 0, label: '' },
  savings: ({ m, rates }) => m.cascadeExcessTokens * rates.spend,
  clause: ({ events }) => {
    const list = errorCascades(events);
    if (!list.length) return '';
    const names = list
      .slice(0, TOP_N)
      .map((c) => `${c.project}/${c.sessionId.slice(0, 8)} (${c.runLength} turns, ${fmtTokens(c.runTokens)})`)
      .join(', ');
    return ` Worst cascades: ${names}. Only the spend past each run's second turn is priced as waste; the first two failures are treated as diagnosis, which is what they usually are.`;
  },
};

export default rule;
