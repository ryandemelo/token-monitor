import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

/**
 * An invest-MORE finding: the remedy costs tokens rather than saving them, so
 * it deliberately has no savings function and no family. Rules are allowed to
 * be advice without a price tag.
 */
const rule: Rule = {
  key: 'low-think-code',
  metric: 'thinkToCodeRatio',
  direction: 'up',
  title: 'Very low think:code ratio',
  docs: `Planning and exploration tokens per coding token. Teams that spend 15-30%
of their tokens understanding the problem before writing code ship with
measurably less rework; going straight to code trades a small planning cost for a
larger fix-loop one.

Fires below 0.15 once coding spend passes 50k tokens. There is no savings figure
on purpose — the advice is to spend more up front, and pricing that as a saving
would be dishonest. Watch reworkRatio to see whether it worked.`,
  fires: (m) =>
    m.thinkToCodeRatio < 0.15 && m.byActivity.coding.tokens > 50_000
      ? 'Very low think:code ratio. Teams that spend 15-30% of tokens on planning/exploration ship with less rework.'
      : undefined,
  score: (s) => ({
    score: s.m.thinkToCodeRatio < 0.15 ? s.m.byActivity.coding.tokens : 0,
    label: `think:code ${s.m.thinkToCodeRatio.toFixed(2)} · ${fmtTokens(s.m.byActivity.coding.tokens)} coding tok`,
  }),
};
export default rule;
