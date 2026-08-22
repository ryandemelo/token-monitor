import type { Rule } from './types.js';
import { MEGA_TURN_FLOOR_TOKENS } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

const rule: Rule = {
  key: 'mega-turns',
  metric: 'megaTurnShare',
  direction: 'down',
  family: 'rework',
  title: 'Single turns emitting runaway output',
  docs: `Spend on turns whose OUTPUT alone cleared the window's bar: a whole file
rewritten to change three lines, or a runaway generation. Output tokens are the
most expensive tokens there are, and one such turn can quietly cost more than a
day of reading.

The bar adapts to the window instead of being a magic constant: the larger of an
absolute floor (${fmtTokens(MEGA_TURN_FLOOR_TOKENS)}) and the 99.9th percentile of the
window's own turn outputs. A user whose models legitimately write long files
sets their own bar higher rather than being accused for it, because a long file
legitimately needs a long write. That is also why the message stays descriptive:
it names what happened, not what the user should feel about it.

Savings price only the EXCESS above the bar at the blended spend rate: the part
of each mega-turn that had no reason to exist even if the work was real.
Everything up to the bar is treated as legitimate, which keeps the number
conservative and easy to defend.`,
  fires: (m) =>
    m.megaTurns > 0
      ? `${m.megaTurns} turn(s) emitted ${fmtTokens(m.megaTurnThreshold)}+ output tokens in one go: ${fmtTokens(m.megaTurnTokens)} of spend, the worst writing ${fmtTokens(m.largestTurnOutput)}. Prefer targeted edits over whole-file rewrites, and cap max output where the client allows it.`
      : undefined,
  score: (s) => ({
    score: s.m.megaTurnTokens,
    label: `${fmtTokens(s.m.largestTurnOutput)} tok single turn`,
  }),
  savings: ({ m, rates }) => m.megaTurnExcessTokens * rates.spend,
};
export default rule;
