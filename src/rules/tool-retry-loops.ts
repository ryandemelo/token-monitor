import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

const rule: Rule = {
  key: 'tool-retry-loops',
  metric: 'retryShare',
  direction: 'down',
  family: 'rework',
  title: 'Paying to retry a tool that just failed',
  docs: `Spend on turns that re-run a tool which errored in the immediately
previous turn. Each retry re-pays a full context to try the same thing again, and
the underlying cause is almost always structural: a flaky command, a wrong path, a
missing permission, a service that is down.

Fires above 5% of spend — a low bar deliberately, because the fix is cheap and
one-off. \`analyze\` names the offending tools and their error rates.

Savings price the retry tokens at the blended spend rate.`,
  fires: (m) =>
    m.retryShare >= 0.05
      ? `${(m.retryShare * 100).toFixed(0)}% of spend goes to turns re-running a tool right after it errored. \`analyze\` shows which tools — fix the recurring cause (flaky command, bad path, missing permission) instead of paying for retries.`
      : undefined,
  score: (s) => ({ score: s.m.retryTokens, label: `${fmtTokens(s.m.retryTokens)} retry tok` }),
  savings: ({ m, rates }) => m.retryTokens * rates.spend,
};
export default rule;
