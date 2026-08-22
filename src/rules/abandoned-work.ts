import type { Rule } from './types.js';
import { ABANDON_IDLE_DAYS } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

/**
 * The first finding in this tool that is about an OUTCOME rather than a
 * habit, which makes it the one most likely to be misread — so the gates are
 * deliberately conservative and the wording deliberately flat.
 */
const rule: Rule = {
  key: 'abandoned-work',
  metric: 'abandonedShare',
  direction: 'down',
  family: 'outcomes',
  title: 'Coding work that never reached a ship signal',
  docs: `Spend in work STREAMS — a project plus a branch — that contain coding turns
and reached no commit, push, PR or merge anywhere in the window, and have then sat
idle for at least ${ABANDON_IDLE_DAYS} days.

Three guards keep this from becoming an accusation:

- **Streams, not sessions.** Coding on Monday and shipping on Wednesday from a new
  session is one stream that shipped. Sources with no branch information fall back
  to per-session grouping, which is coarser and says so.
- **Never work in flight.** A stream touched inside the idle window is reported as
  *open* and excluded from the finding entirely. Accusing someone's current branch
  of being abandoned is the fastest way to make an outcome metric worthless.
- **Main loop only, and coding only.** A subagent run ships through its caller, and
  a stream that never wrote code was never trying to ship.

Research, spikes and learning ship nothing by design and are not waste. The metric
answers exactly one question: how much of this window's spend went to code that
reached no ship signal. \`analyze\` lists the streams — locally; branch names name
features and clients and never leave the machine.

Fires above 25% of spend with at least two idle streams. Savings are priced at the
blended spend rate over the idle streams only, and are a **ceiling**: they assume
the work would not have been done at all, which is rarely the whole truth.`,
  fires: (m) =>
    (m.abandonedStreams ?? 0) >= 2 && (m.abandonedShare ?? 0) >= 0.25
      ? `${(m.abandonedShare * 100).toFixed(0)}% of spend (${fmtTokens(m.abandonedTokens)} tok) is in ${m.abandonedStreams} coding stream(s) that reached no commit, PR or merge and have been idle ${ABANDON_IDLE_DAYS}+ days${m.openStreams ? `, with ${m.openStreams} more still open` : ''}. \`analyze\` lists them — if they are dead, the tokens bought nothing; if they are paused, that is worth knowing too.`
      : undefined,
  score: (s) => ({
    score: s.m.abandonedTokens ?? 0,
    label: `${fmtTokens(s.m.abandonedTokens ?? 0)} unshipped`,
  }),
  target: 0.1,
  savings: ({ m, rates, target }) => {
    const excess = Math.max(0, (m.abandonedShare ?? 0) - (target?.value ?? 0)) * m.spendTokens;
    return excess * rates.spend;
  },
};
export default rule;
