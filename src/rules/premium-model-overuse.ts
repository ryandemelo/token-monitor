import type { Rule } from './types.js';
import type { Metrics } from '../metrics.js';
import { premiumShare } from '../metrics.js';
import { PREMIUM_MODEL_RE } from '../pricing.js';
import { fmtTokens } from '../fmt.js';

function premiumTokensOf(m: Metrics): number {
  return Object.entries(m.byModel)
    .filter(([name]) => PREMIUM_MODEL_RE.test(name))
    .reduce((s, [, v]) => s + v.tokens, 0);
}

const rule: Rule = {
  key: 'premium-model-overuse',
  metric: 'premiumShare',
  direction: 'down',
  family: 'routing',
  title: 'Almost everything on the premium tier',
  docs: `Share of spend on premium models. Fires above 90% — and only when the mix
already contains more than one model, because advice to route work to a cheaper
tier is useless to someone who has never run one.

The target is static (50%), not personalized: model choice is a routing decision,
not a per-session skill, so "your best sessions" says nothing about it. Savings
price the moved tokens at the premium-minus-cheap rate delta, where "cheap" is
the cheapest tier already in the user's own mix.`,
  fires: (m) => {
    const share = premiumShare(m);
    return share > 0.9 && Object.keys(m.byModel).length > 1
      ? `${(share * 100).toFixed(0)}% of tokens on premium models. Route exploration and boilerplate turns to a cheaper tier.`
      : undefined;
  },
  score: (s) => ({
    score: premiumTokensOf(s.m),
    label: `${fmtTokens(premiumTokensOf(s.m))} premium tok`,
  }),
  target: 0.5,
  savings: ({ m, rates, target }) => {
    const moved = Math.max(0, premiumShare(m) - (target?.value ?? 0)) * m.spendTokens;
    return moved * Math.max(0, rates.premium - rates.cheap);
  },
};
export default rule;
