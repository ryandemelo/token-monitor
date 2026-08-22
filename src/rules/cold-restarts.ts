import type { Rule } from './types.js';
import { extendedCacheOpportunity } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

/** "$1.2k" / "$84" / "$3.40" — local copy so the rule stays a leaf module. */
function usdShort(n: number): string {
  if (n >= 1_000) return '$' + (n / 1000).toFixed(1) + 'k';
  if (n >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

const rule: Rule = {
  key: 'cold-restarts',
  metric: 'coldRestartShare',
  direction: 'down',
  family: 'caching',
  title: 'Context re-paid after idle gaps',
  docs: `Turns that resume after a gap longer than their session's prompt-cache TTL
re-pay the whole context as fresh input instead of reading it cheaply. The gap is
measured against the TTL the session actually used: Claude Code reports how each
cache write split between the 5-minute and 1-hour tiers, and a session whose
writes are mostly 1-hour is scored against an hour.

Main-loop only on both sides of the ratio. A subagent run is a back-to-back burst
that never idles, and its remedy — batch prompts, split idle work — cannot be
applied to something that is spawned and exits.

Fires above 20% of main-loop fresh input, gated on main-loop spend so a small
conversation cannot clear the bar on the back of its fan-out. Beyond the target
savings, the rule adds a second, separately-priced remedy: for sessions still on
the 5-minute cache, what turning on the 1-hour cache would net after its higher
write premium.`,
  fires: (m) =>
    m.coldRestartShare >= 0.2 && m.spendTokens - (m.subagentSpendTokens ?? 0) > 100_000
      ? `${(m.coldRestartShare * 100).toFixed(0)}% of main-loop fresh input tokens were re-paid on ${m.coldRestartTurns} turns that resumed after their session's cache TTL${m.extendedCacheSessions ? ' (1 h where the session wrote to the extended cache, ~5 min otherwise)' : ' (~5 min)'}. Batch prompts within the cache window, or split long-idle work into new sessions.`
      : undefined,
  score: (s) => ({
    score: s.m.coldRestartTokens,
    label: `${fmtTokens(s.m.coldRestartTokens)} re-paid after gaps`,
  }),
  target: 0.05,
  personalTarget: { metric: (m) => m.coldRestartShare, direction: 'down' },
  savings: ({ m, rates, target }) => {
    // Price against the SAME population the ratio is measured over (main-loop
    // fresh-paid input), or the number is inflated by the whole fan-out.
    // Pre-0.13 exports have no base and no subagent rows either, so their own
    // fresh-paid input is the right one.
    const base = m.coldRestartBaseTokens ?? m.inputTokens + m.cacheCreationTokens;
    const saved = Math.max(0, m.coldRestartShare - (target?.value ?? 0)) * base;
    return saved * (rates.input - rates.cacheRead);
  },
  /**
   * The other way to stop re-paying context: turn the 1-hour cache on. Priced
   * as a net — what the covered gaps would stop costing, minus the higher write
   * premium those sessions would start paying — and stated only when the net is
   * positive and material. Deliberately NOT folded into savings, which stays the
   * "reach the target" number: two remedies with two price tags, not one blended
   * figure nobody can reproduce.
   */
  clause: ({ events, rates, monthly }) => {
    if (!rates.extendedWritePremium) return ''; // no model in the mix publishes an extended price
    const { recoverableTokens, writeTokens, sessions } = extendedCacheOpportunity(events);
    if (sessions === 0) return '';
    const saved = recoverableTokens * (rates.input - rates.cacheRead);
    const premium = writeTokens * rates.extendedWritePremium;
    const net = (saved - premium) * monthly;
    if (net < 1) return '';
    return ` ${sessions} of these session(s) run on the 5-minute cache with gaps the 1-hour cache would have covered — enabling it nets about ${usdShort(net)}/mo after its higher write premium.`;
  },
};
export default rule;
