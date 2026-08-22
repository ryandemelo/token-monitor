import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

const rule: Rule = {
  key: 'high-rework',
  metric: 'reworkRatio',
  direction: 'down',
  family: 'rework',
  title: 'High rework after failures',
  docs: `Share of spend on coding/testing turns that happen after the first failed
turn in a session. High rework is the signature of work that started before it
was specified: the agent codes, the test fails, and every subsequent turn pays a
full context to iterate.

Distinct from analyze's fix iterations, which counts testing->coding transitions
— a session that barely tests can have high rework and no visible loops.
User-declined permission prompts are not failures and never count.

Fires above 20%. Savings price the excess over the target at the blended spend
rate.`,
  fires: (m) =>
    m.reworkRatio > 0.2
      ? `${(m.reworkRatio * 100).toFixed(0)}% of spend happens after test failures. Plan-first workflows and tighter task specs cut this.`
      : undefined,
  score: (s) => ({ score: s.m.reworkTokens, label: `${fmtTokens(s.m.reworkTokens)} rework tok` }),
  target: 0.1,
  personalTarget: { metric: (m) => m.reworkRatio, direction: 'down' },
  savings: ({ m, rates, target }) =>
    Math.max(0, m.reworkRatio - (target?.value ?? 0)) * m.spendTokens * rates.spend,
};
export default rule;
