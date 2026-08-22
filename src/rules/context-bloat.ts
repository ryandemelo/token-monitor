import type { Rule } from './types.js';
import type { StoredEvent } from '../store.js';
import { contextGrowthOf, BLOAT_MIN_TURNS } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

/** Fresh tokens the late half of a bloated session paid beyond the early-half rate. */
function bloatAvoidableTokens(events: StoredEvent[]): number {
  if (events.length < BLOAT_MIN_TURNS) return 0;
  const half = Math.floor(events.length / 2);
  const fresh = (e: StoredEvent) => e.input_tokens + e.cache_creation_tokens;
  const earlyFresh = events.slice(0, half).reduce((s, e) => s + fresh(e), 0);
  const lateFresh = events.slice(events.length - half).reduce((s, e) => s + fresh(e), 0);
  return Math.max(0, lateFresh - earlyFresh);
}

const rule: Rule = {
  key: 'context-bloat',
  metric: 'contextBloatShare',
  direction: 'down',
  family: 'caching',
  title: 'Sessions that balloon their own context',
  docs: `Long sessions whose late-half context per turn is at least twice their
early half, with cache reads failing to keep pace — so the growth is re-paid as
fresh input rather than read cheaply. The remedy is a task boundary: compact, or
start a new session.

Measured over main-loop sessions only. A subagent run is spawned fresh, does one
job and exits, and nobody can compact it; counting runs would bury a real hygiene
problem in a denominator of things nobody can act on.

Fires when at least 30% of long sessions bloat and there are at least 3 of them.
Savings price the late-half excess fresh tokens at the fresh-minus-cache-read
delta — conservatively, since avoided context would have been cache reads at
best.`,
  fires: (m) =>
    m.contextBloatShare >= 0.3 && m.trendSessions >= 3
      ? `${m.bloatedSessions} of ${m.trendSessions} long sessions grow their context ≥2× without cache reads keeping pace — start a fresh session or compact at task boundaries before the context balloons.`
      : undefined,
  score: (s) => {
    const growth = contextGrowthOf(s.events);
    return {
      score: growth && growth.ratio >= 2 ? bloatAvoidableTokens(s.events) : 0,
      label: `ctx ×${growth ? growth.ratio.toFixed(1) : '?'} · ${fmtTokens(bloatAvoidableTokens(s.events))} avoidable`,
    };
  },
  savings: ({ rates, sessions }) => {
    const avoidable = sessions.reduce((s, info) => {
      const g = info.isSidechain ? undefined : contextGrowthOf(info.events);
      return g && g.ratio >= 2 ? s + bloatAvoidableTokens(info.events) : s;
    }, 0);
    return avoidable * (rates.input - rates.cacheRead);
  },
};
export default rule;
