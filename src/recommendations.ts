import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy, contextGrowthOf, BLOAT_MIN_TURNS } from './metrics.js';
import type { StoredEvent } from './store.js';
import type { Finding, FollowRow, MetricKey } from './followthrough.js';
import { structuredFindings, premiumShare, fmtMetric } from './followthrough.js';
import { PRICES, PREMIUM_MODEL_RE } from './pricing.js';
import { fmtTokens } from './report.js';
import type { CauseBreakdown } from './causes.js';
import { decomposeCause } from './causes.js';

/**
 * Recommendations 2.0: every structured finding answers "why should I believe
 * this and what is it worth" — the worst sessions that triggered it (ids,
 * dates, token counts; aggregate-only, never content) and the estimated
 * $/month if the metric moved to its target, priced from the user's own
 * model mix and the price table. Finding keys are untouched, so
 * follow-through baselines keep working.
 */

export interface RecEvidence {
  sessionId: string;
  project: string;
  /** Date of the session's first turn (yyyy-mm-dd). */
  date: string;
  /** Human label for the session's offending number, e.g. "1.2M rework tok". */
  label: string;
}

export interface EnrichedRec extends Finding {
  /** Worst sessions by this finding's metric — at most 3. */
  evidence: RecEvidence[];
  /** Estimated savings if the metric moved to its target; absent when not quantifiable. */
  savingsUsdPerMonth?: number;
  /** True when placeholder/estimated prices or a tier assumption fed the number. */
  savingsEstimated: boolean;
  /** The improvement target the savings assume; personal = user's own top quartile. */
  target?: Target;
  /** The dominant cause behind the symptom, when decomposable (#41). */
  cause?: CauseBreakdown;
}

/** Static fallback targets for the savings math, per finding key. */
const TARGETS: Record<string, number> = {
  'low-cache-hit': 0.8, // cache hit ratio to reach
  'high-rework': 0.1, // rework ratio to reach
  'premium-model-overuse': 0.5, // premium share to reach
  'cold-restarts': 0.05, // cold-restart share to reach
};

/**
 * Session-skill metrics get personalized targets: with enough qualifying
 * sessions, the target is the top quartile of the user's OWN sessions —
 * "your best sessions prove this is reachable". Model-routing targets stay
 * static (model choice isn't a per-session skill).
 */
const PERSONAL_TARGET: Record<string, { metric: (m: Metrics) => number; direction: 'up' | 'down' }> = {
  'low-cache-hit': { metric: (m) => m.cacheHitRatio, direction: 'up' },
  'high-rework': { metric: (m) => m.reworkRatio, direction: 'down' },
  'cold-restarts': { metric: (m) => m.coldRestartShare, direction: 'down' },
};

const PERSONAL_MIN_SESSIONS = 8;
const PERSONAL_MIN_SPEND = 10_000; // ignore trivial sessions when benchmarking

export interface Target {
  value: number;
  /** True when derived from the user's own top-quartile sessions. */
  personal: boolean;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function targetFor(key: string, sessions: SessionInfo[]): Target | undefined {
  const spec = PERSONAL_TARGET[key];
  if (spec) {
    const values = sessions
      .filter((s) => s.m.spendTokens >= PERSONAL_MIN_SPEND)
      .map((s) => spec.metric(s.m))
      .sort((a, b) => a - b);
    if (values.length >= PERSONAL_MIN_SESSIONS) {
      // best quartile in the metric's good direction
      return { value: quantile(values, spec.direction === 'up' ? 0.75 : 0.25), personal: true };
    }
  }
  return key in TARGETS ? { value: TARGETS[key], personal: false } : undefined;
}

interface SessionInfo {
  sessionId: string;
  project: string;
  date: string;
  m: Metrics;
  events: StoredEvent[];
}

/** $/token rates blended over the user's actual model mix in the window. */
export interface BlendedRates {
  input: number;
  cacheRead: number;
  /** Average realized $/spend-token across all priced usage. */
  spend: number;
  /** Realized $/spend-token on premium models only. */
  premium: number;
  /** Cheapest priced non-premium model the user already runs; tier-assumed when absent. */
  cheap: number;
  estimated: boolean;
}

export function blendedRates(m: Metrics): BlendedRates {
  let wInput = 0, wCacheRead = 0, wTokens = 0;
  let premiumCost = 0, premiumTokens = 0;
  let cheap = Infinity;
  let estimated = false;
  for (const [model, v] of Object.entries(m.byModel)) {
    if (!v.tokens) continue;
    const row = PRICES.find((p) => p.match.test(model));
    if (!row) {
      estimated = true; // unpriced usage in the mix
      continue;
    }
    if (row.estimated) estimated = true;
    wInput += v.tokens * row.input;
    wCacheRead += v.tokens * row.cacheRead;
    wTokens += v.tokens;
    const rate = v.costUsd / v.tokens;
    if (PREMIUM_MODEL_RE.test(model)) {
      premiumCost += v.costUsd;
      premiumTokens += v.tokens;
    } else if (v.costUsd > 0) {
      cheap = Math.min(cheap, rate);
    }
  }
  const premium = premiumTokens ? premiumCost / premiumTokens : 0;
  if (!Number.isFinite(cheap)) {
    // No cheaper model in the mix to price against — assume the next tier
    // down at ~1/5 the premium rate (e.g. Opus -> Haiku input pricing).
    cheap = premium / 5;
    estimated = true;
  }
  return {
    input: wTokens ? wInput / wTokens / 1e6 : 0,
    cacheRead: wTokens ? wCacheRead / wTokens / 1e6 : 0,
    spend: m.spendTokens ? m.costUsd / m.spendTokens : 0,
    premium,
    cheap,
    estimated: estimated || m.costEstimated,
  };
}

/** Fresh tokens the late half of a bloated session paid beyond the early-half rate. */
function bloatAvoidableTokens(events: StoredEvent[]): number {
  if (events.length < BLOAT_MIN_TURNS) return 0;
  const half = Math.floor(events.length / 2);
  const fresh = (e: StoredEvent) => e.input_tokens + e.cache_creation_tokens;
  const earlyFresh = events.slice(0, half).reduce((s, e) => s + fresh(e), 0);
  const lateFresh = events.slice(events.length - half).reduce((s, e) => s + fresh(e), 0);
  return Math.max(0, lateFresh - earlyFresh);
}

function premiumTokensOf(m: Metrics): number {
  return Object.entries(m.byModel)
    .filter(([name]) => PREMIUM_MODEL_RE.test(name))
    .reduce((s, [, v]) => s + v.tokens, 0);
}

/** Per finding key: how bad is this session (higher = worse) and its evidence label. */
const SCORERS: Record<string, (s: SessionInfo) => { score: number; label: string }> = {
  'low-cache-hit': (s) => ({
    score: s.m.inputTokens,
    label: `cache ${(s.m.cacheHitRatio * 100).toFixed(0)}% · ${fmtTokens(s.m.inputTokens)} fresh input`,
  }),
  'high-rework': (s) => ({
    score: s.m.reworkTokens,
    label: `${fmtTokens(s.m.reworkTokens)} rework tok`,
  }),
  'low-think-code': (s) => ({
    score: s.m.thinkToCodeRatio < 0.15 ? s.m.byActivity.coding.tokens : 0,
    label: `think:code ${s.m.thinkToCodeRatio.toFixed(2)} · ${fmtTokens(s.m.byActivity.coding.tokens)} coding tok`,
  }),
  'premium-model-overuse': (s) => ({
    score: premiumTokensOf(s.m),
    label: `${fmtTokens(premiumTokensOf(s.m))} premium tok`,
  }),
  'context-bloat': (s) => {
    const growth = contextGrowthOf(s.events);
    return {
      score: growth && growth.ratio >= 2 ? bloatAvoidableTokens(s.events) : 0,
      label: `ctx ×${growth ? growth.ratio.toFixed(1) : '?'} · ${fmtTokens(bloatAvoidableTokens(s.events))} avoidable`,
    };
  },
  'cold-restarts': (s) => ({
    score: s.m.coldRestartTokens,
    label: `${fmtTokens(s.m.coldRestartTokens)} re-paid after gaps`,
  }),
  'premium-misroute': (s) => ({
    score: s.m.premiumWasteTokens,
    label: `${fmtTokens(s.m.premiumWasteTokens)} premium on exploration/chat`,
  }),
  'tool-retry-loops': (s) => ({
    score: s.m.retryTokens,
    label: `${fmtTokens(s.m.retryTokens)} retry tok`,
  }),
};

/** Estimated $ saved over the report window if the finding's metric hit its target. */
function savingsUsd(
  key: string,
  m: Metrics,
  rates: BlendedRates,
  sessions: SessionInfo[],
  target?: Target,
): number | undefined {
  const inputSide = m.cacheReadTokens + m.inputTokens + m.cacheCreationTokens;
  switch (key) {
    case 'low-cache-hit': {
      // Tokens that would shift from fresh input to cache reads.
      const moved = Math.max(0, (target?.value ?? 0) - m.cacheHitRatio) * inputSide;
      return moved * (rates.input - rates.cacheRead);
    }
    case 'high-rework':
      return Math.max(0, m.reworkRatio - (target?.value ?? 0)) * m.spendTokens * rates.spend;
    case 'premium-model-overuse': {
      const moved = Math.max(0, premiumShare(m) - (target?.value ?? 0)) * m.spendTokens;
      return moved * Math.max(0, rates.premium - rates.cheap);
    }
    case 'premium-misroute':
      return m.premiumWasteTokens * Math.max(0, rates.premium - rates.cheap);
    case 'cold-restarts': {
      const saved = Math.max(0, m.coldRestartShare - (target?.value ?? 0)) * (m.inputTokens + m.cacheCreationTokens);
      return saved * (rates.input - rates.cacheRead);
    }
    case 'context-bloat': {
      const avoidable = sessions.reduce((s, info) => {
        const g = contextGrowthOf(info.events);
        return g && g.ratio >= 2 ? s + bloatAvoidableTokens(info.events) : s;
      }, 0);
      // Conservative: avoided fresh context would have been cache reads at best.
      return avoidable * (rates.input - rates.cacheRead);
    }
    case 'tool-retry-loops':
      return m.retryTokens * rates.spend;
    default:
      return undefined; // e.g. low-think-code: an invest-more rec, not a savings one
  }
}

export function enrichFindings(events: StoredEvent[], m: Metrics, days: number): EnrichedRec[] {
  const findings = structuredFindings(m);
  if (findings.length === 0) return [];
  const sessions: SessionInfo[] = [...groupBy(events, 'session_id')].map(([sessionId, evs]) => ({
    sessionId,
    project: evs[0].project,
    date: evs[0].ts.slice(0, 10),
    m: computeMetrics(evs),
    events: evs,
  }));
  const rates = blendedRates(m);
  const monthly = days > 0 ? 30 / days : 1;

  return findings
    .map((f) => {
      const scorer = SCORERS[f.key];
      const evidence = scorer
        ? sessions
            .map((s) => ({ s, ...scorer(s) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(({ s, label }) => ({ sessionId: s.sessionId, project: s.project, date: s.date, label }))
        : [];
      const target = targetFor(f.key, sessions);
      const usd = savingsUsd(f.key, m, rates, sessions, target);
      const message = target?.personal
        ? `${f.message} Your own top-quartile sessions already run at ${fmtMetric(f.metric, target.value)} — the target below assumes only that.`
        : f.message;
      return {
        ...f,
        message,
        evidence,
        target,
        cause: decomposeCause(f.key, events),
        savingsUsdPerMonth: usd !== undefined && usd > 0 ? usd * monthly : undefined,
        savingsEstimated: rates.estimated,
      };
    })
    // biggest lever first; unquantified recs keep their firing order at the end
    .sort((a, b) => (b.savingsUsdPerMonth ?? -1) - (a.savingsUsdPerMonth ?? -1));
}

/**
 * Per-rec savings overlap (misroute tokens are a subset of overuse tokens;
 * cold-restart tokens overlap the cache-hit gap). Group levers into families,
 * take the max within each, sum across — an honest combined number.
 */
const FAMILIES: Array<{ family: string; keys: string[] }> = [
  { family: 'caching', keys: ['low-cache-hit', 'cold-restarts', 'context-bloat'] },
  { family: 'routing', keys: ['premium-model-overuse', 'premium-misroute'] },
  { family: 'rework', keys: ['high-rework', 'tool-retry-loops'] },
];

export interface PotentialBill {
  currentUsdPerMonth: number;
  potentialUsdPerMonth: number;
  families: Array<{ family: string; usdPerMonth: number }>;
  estimated: boolean;
}

export function potentialBill(recs: EnrichedRec[], m: Metrics, days: number): PotentialBill | undefined {
  const families = FAMILIES.map(({ family, keys }) => ({
    family,
    usdPerMonth: Math.max(
      0,
      ...recs.filter((r) => keys.includes(r.key)).map((r) => r.savingsUsdPerMonth ?? 0),
    ),
  })).filter((f) => f.usdPerMonth > 0);
  if (families.length === 0) return undefined;
  const currentUsdPerMonth = m.costUsd * (days > 0 ? 30 / days : 1);
  const saved = families.reduce((s, f) => s + f.usdPerMonth, 0);
  return {
    currentUsdPerMonth,
    potentialUsdPerMonth: Math.max(0, currentUsdPerMonth - saved),
    families: families.sort((a, b) => b.usdPerMonth - a.usdPerMonth),
    estimated: recs.some((r) => r.savingsEstimated) || m.costEstimated,
  };
}

export function fmtUsdShort(n: number): string {
  if (n >= 1_000) return '$' + (n / 1000).toFixed(1) + 'k';
  if (n >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

/** One-line headline: "~$18.7k/mo → ~$7.0k/mo (routing −$9.2k · caching −$581)". */
export function fmtPotential(p: PotentialBill): string {
  const t = p.estimated ? '~' : '';
  const parts = p.families.map((f) => `${f.family} −${fmtUsdShort(f.usdPerMonth)}`).join(' · ');
  return `Potential: ${t}${fmtUsdShort(p.currentUsdPerMonth)}/mo → ${t}${fmtUsdShort(p.potentialUsdPerMonth)}/mo (${parts})`;
}

/**
 * Realized $/month for a tracked recommendation: the baseline→current metric
 * move priced at the CURRENT mix and volume — an approximation (the baseline
 * window had different volume), but it answers "was the advice worth taking".
 */
export function realizedMonthly(
  row: FollowRow,
  m: Metrics,
  rates: BlendedRates,
  days: number,
): number | undefined {
  const improvement = row.direction === 'up' ? row.current - row.baseline : row.baseline - row.current;
  if (improvement <= 0.02) return undefined; // below follow-through's own noise threshold
  const perPoint = unitValuePerPoint(row.metric, m, rates);
  if (perPoint === undefined) return undefined;
  const usd = improvement * perPoint * (days > 0 ? 30 / days : 1);
  return usd > 0 ? usd : undefined;
}

/** $ value of a full 1.0 move in the metric, at the current window's volumes. */
function unitValuePerPoint(metric: MetricKey, m: Metrics, rates: BlendedRates): number | undefined {
  const inputSide = m.cacheReadTokens + m.inputTokens + m.cacheCreationTokens;
  switch (metric) {
    case 'cacheHitRatio':
      return inputSide * (rates.input - rates.cacheRead);
    case 'reworkRatio':
    case 'retryShare':
      return m.spendTokens * rates.spend;
    case 'premiumShare':
    case 'premiumWasteShare':
      return m.spendTokens * Math.max(0, rates.premium - rates.cheap);
    case 'coldRestartShare':
      return (m.inputTokens + m.cacheCreationTokens) * (rates.input - rates.cacheRead);
    default:
      return undefined; // thinkToCodeRatio, contextBloatShare: not $-translatable
  }
}

/** "≈ ~$84/mo" — shared by the terminal report, analyze, and the dashboard. */
export function fmtSavings(r: EnrichedRec): string | undefined {
  if (r.savingsUsdPerMonth === undefined) return undefined;
  const n = r.savingsUsdPerMonth;
  return `≈ ${r.savingsEstimated ? '~' : ''}$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}/mo`;
}

export function fmtEvidence(r: EnrichedRec): string | undefined {
  if (r.evidence.length === 0) return undefined;
  return 'worst: ' + r.evidence
    .map((e) => `${e.sessionId.slice(0, 8)} (${e.project}, ${e.date}, ${e.label})`)
    .join(' · ');
}

/** "cause: cold restarts after idle gaps (52%)" — the dominant driver, when known. */
export function fmtCause(r: EnrichedRec): string | undefined {
  if (!r.cause) return undefined;
  const d = r.cause.dominant;
  return `cause: ${d.label} (${(d.share * 100).toFixed(0)}%)`;
}
