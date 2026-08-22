import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

/** Cache reads cost ~10% of fresh input, so this is the biggest single lever. */
const rule: Rule = {
  key: 'low-cache-hit',
  metric: 'cacheHitRatio',
  direction: 'up',
  family: 'caching',
  title: 'Low cache hit ratio',
  docs: `Cache reads are billed at roughly a tenth of fresh input, so the share of
input-side tokens served from cache is the single largest cost lever in the data.
A low ratio usually means sessions are short-lived, the system context keeps
changing between turns, or work is spread across many cold starts.

Fires below 50% on windows with more than 100k spend tokens. The savings figure
prices the tokens that would move from the fresh-input rate to the cache-read
rate if the ratio reached its target — the user's own top-quartile sessions when
there are enough of them, 80% otherwise.`,
  fires: (m) =>
    m.cacheHitRatio < 0.5 && m.spendTokens > 100_000
      ? `Cache hit ratio ${(m.cacheHitRatio * 100).toFixed(0)}% — low. Cache reads cost ~10% of fresh input; long-lived sessions and stable system context raise this. Biggest single cost lever.`
      : undefined,
  score: (s) => ({
    score: s.m.inputTokens,
    label: `cache ${(s.m.cacheHitRatio * 100).toFixed(0)}% · ${fmtTokens(s.m.inputTokens)} fresh input`,
  }),
  target: 0.8,
  personalTarget: { metric: (m) => m.cacheHitRatio, direction: 'up' },
  savings: ({ m, rates, target }) => {
    const inputSide = m.cacheReadTokens + m.inputTokens + m.cacheCreationTokens;
    // Tokens that would shift from fresh input to cache reads.
    const moved = Math.max(0, (target?.value ?? 0) - m.cacheHitRatio) * inputSide;
    return moved * (rates.input - rates.cacheRead);
  },
};
export default rule;
