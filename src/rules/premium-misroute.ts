import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

const rule: Rule = {
  key: 'premium-misroute',
  metric: 'premiumWasteShare',
  direction: 'down',
  family: 'routing',
  title: 'Premium tokens on reading and chat',
  docs: `The sharper half of the routing story: premium-model tokens spent on
exploration and conversation turns, where a cheaper tier does the same job. Unlike
premium-model-overuse this makes no claim about coding turns — keep the expensive
model where it writes code.

Fires above 30% of spend on windows over 100k tokens. Savings price those exact
tokens at the premium-minus-cheap delta; no target is involved, because the
number is already the misrouted tokens themselves.`,
  fires: (m) =>
    m.premiumWasteShare >= 0.3 && m.spendTokens > 100_000
      ? `${(m.premiumWasteShare * 100).toFixed(0)}% of spend is premium-model tokens on exploration/conversation turns. Route reads and chat to a cheaper tier; keep the premium model for code-writing turns.`
      : undefined,
  score: (s) => ({
    score: s.m.premiumWasteTokens,
    label: `${fmtTokens(s.m.premiumWasteTokens)} premium on exploration/chat`,
  }),
  savings: ({ m, rates }) => m.premiumWasteTokens * Math.max(0, rates.premium - rates.cheap),
};
export default rule;
