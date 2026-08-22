import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';
import type { Finding, FollowRow, MetricKey } from './followthrough.js';
import { structuredFindings, fmtMetric } from './followthrough.js';
import { PRICES, PREMIUM_MODEL_RE } from './pricing.js';
import type { BlendedRates, RuleFamily, SessionInfo, Target } from './rules/types.js';
import { RULE_BY_KEY, RULES } from './rules/index.js';
import type { CauseBreakdown } from './causes.js';
import { decomposeCause } from './causes.js';

// The shapes rules are written against live with the rule contract; these
// re-exports keep the existing `from './recommendations.js'` call sites working.
export type { BlendedRates, SessionInfo, Target } from './rules/types.js';

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

/**
 * Sessions a personalized target is allowed to be computed from.
 *
 * "Your own best sessions prove this is reachable" is a claim about the user's
 * conversations, and a subagent run reports 0 on the main-loop-scoped hygiene
 * ratios by construction (its denominator is empty), so leaving runs in would
 * drag every personal target to 0 and tell the user their top quartile already
 * runs perfectly.
 */
const PERSONAL_MIN_SESSIONS = 8;
const PERSONAL_MIN_SPEND = 10_000; // ignore trivial sessions when benchmarking

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The improvement target a rule's savings are priced against: the user's own
 * top-quartile sessions when the rule declares a personalized target and there
 * is enough data, otherwise the rule's static target.
 */
export function targetFor(key: string, sessions: SessionInfo[]): Target | undefined {
  const rule = RULE_BY_KEY.get(key);
  if (!rule) return undefined;
  const spec = rule.personalTarget;
  if (spec) {
    const values = sessions
      .filter((s) => !s.isSidechain && s.m.spendTokens >= PERSONAL_MIN_SPEND)
      .map((s) => spec.metric(s.m))
      .sort((a, b) => a - b);
    if (values.length >= PERSONAL_MIN_SESSIONS) {
      // best quartile in the metric's good direction
      return { value: quantile(values, spec.direction === 'up' ? 0.75 : 0.25), personal: true };
    }
  }
  return rule.target !== undefined ? { value: rule.target, personal: false } : undefined;
}

export function blendedRates(m: Metrics): BlendedRates {
  let wInput = 0, wCacheRead = 0, wTokens = 0;
  let wWritePremium = 0, write1hTokens = 0;
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
    if (row.cacheWrite1h !== undefined) {
      wWritePremium += v.tokens * (row.cacheWrite1h - row.cacheWrite);
      write1hTokens += v.tokens;
    }
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
    extendedWritePremium: write1hTokens ? wWritePremium / write1hTokens / 1e6 : 0,
    estimated: estimated || m.costEstimated,
  };
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
    isSidechain: evs[0].is_sidechain === 1,
  }));
  const rates = blendedRates(m);
  const monthly = days > 0 ? 30 / days : 1;

  return findings
    .map((f) => {
      const rule = RULE_BY_KEY.get(f.key);
      // Evidence names sessions the user can go and change, so it ranks
      // conversations only. Subagent runs outnumber them ~14:1 and each turn
      // carries more absolute context, so leaving them in fills every "worst
      // 3 sessions" line with anonymous runs nobody can act on — their spend
      // is accounted for in the metric itself and in analyze's fan-out table.
      const evidence = rule?.score
        ? sessions
            .filter((s) => !s.isSidechain)
            .map((s) => ({ s, ...rule.score!(s) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(({ s, label }) => ({ sessionId: s.sessionId, project: s.project, date: s.date, label }))
        : [];
      const target = targetFor(f.key, sessions);
      const extended = rule?.clause?.({ events, rates, monthly }) ?? '';
      const usd = rule?.savings?.({ m, rates, sessions, target });
      const message =
        (target?.personal
          ? `${f.message} Your own top-quartile sessions already run at ${fmtMetric(f.metric, target.value)} — the target below assumes only that.`
          : f.message) + extended;
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
 * cold-restart tokens overlap the cache-hit gap). Rules declare a `family`;
 * within one we take the max and sum across families — an honest combined
 * number. A rule with no family never contributes to the headline.
 */
function ruleFamilies(): Array<{ family: RuleFamily; keys: string[] }> {
  const out = new Map<RuleFamily, string[]>();
  for (const r of RULES) {
    if (!r.family) continue;
    const keys = out.get(r.family) ?? [];
    keys.push(r.key);
    out.set(r.family, keys);
  }
  return [...out].map(([family, keys]) => ({ family, keys }));
}

export interface PotentialBill {
  currentUsdPerMonth: number;
  potentialUsdPerMonth: number;
  families: Array<{ family: string; usdPerMonth: number }>;
  estimated: boolean;
}

export function potentialBill(recs: EnrichedRec[], m: Metrics, days: number): PotentialBill | undefined {
  const families = ruleFamilies().map(({ family, keys }) => ({
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
    case 'cascadeShare':
      return m.spendTokens * rates.spend;
    case 'premiumShare':
    case 'premiumWasteShare':
      return m.spendTokens * Math.max(0, rates.premium - rates.cheap);
    case 'coldRestartShare':
      // Same population as the ratio — see the cold-restarts rule's savings().
      return (m.coldRestartBaseTokens ?? m.inputTokens + m.cacheCreationTokens) * (rates.input - rates.cacheRead);
    case 'toolResultCarryShare':
      // Carried context is re-read from cache; same rate its rule prices with.
      return inputSide * rates.cacheRead;
    case 'floorShare':
      return (m.floorBaseTokens ?? 0) * rates.cacheRead;
    case 'abandonedShare':
      return m.spendTokens * rates.spend;
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
