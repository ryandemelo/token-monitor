import type { StoredEvent } from './store.js';
import { computeMetrics, groupByRootSession, premiumShare } from './metrics.js';
import { PREMIUM_MODEL_RE } from './pricing.js';
import type { BlendedRates } from './rules/types.js';

/**
 * Per-category model routing (#71).
 *
 * The existing routing findings are activity-level: premium tokens on
 * exploration or conversation turns. The sharper, more persuasive version is
 * task-level — "in THIS recurring category, your cheap-tier sessions show no
 * worse outcomes than your premium ones" — because personalized evidence beats
 * generic advice, the same reasoning behind personalized targets.
 *
 * This feature makes an accusation about someone's judgement, so every knob
 * below is set toward silence.
 *
 * ## The calibration caveat, stated because it matters
 *
 * The noise band could NOT be calibrated against real data. The only corpus
 * available for dogfooding runs 122.6M premium tokens against 0.04M
 * non-premium — 106 premium-only sessions, 2 cheap-only, 2 mixed — so there is
 * no two-tier population to measure a "not worse" threshold on. NOISE_BAND is
 * therefore an explicit assumption, not a measurement: five percentage points
 * on each outcome, chosen to be wider than the per-session spread observed on
 * that corpus (rework sd ≈ 0.041, error sd ≈ 0.042) so ordinary variation
 * cannot read as "no gap". Change it in one place when a mixed-tier corpus
 * exists to measure it against.
 */

/** A category needs this many sessions before any comparison is attempted. */
export const MIN_CATEGORY_SESSIONS = 6;
/** ...and this many on EACH side. One session is an anecdote. */
export const MIN_PER_SIDE = 2;
/** A session counts as premium when most of its spend was on a premium model. */
export const PREMIUM_SESSION_SHARE = 0.5;
/** Absolute outcome difference below which the two sides are called comparable. */
export const NOISE_BAND = 0.05;

export interface RoutingRow {
  category: string;
  sessions: number;
  premiumSessions: number;
  cheapSessions: number;
  premiumTokens: number;
  premiumCostUsd: number;
  /** cheap-side minus premium-side; positive means the cheap tier did worse. */
  reworkDelta: number;
  errorDelta: number;
  verdict: 'no-measurable-gap' | 'premium-better' | 'cheap-worse-unclear';
  /** Only present on a no-measurable-gap row; always `~`-marked in display. */
  savingsUsdPerMonth?: number;
  /**
   * True when the comparison was confined to the single project both sides
   * shared — the Simpson's guard. A category spanning projects where the two
   * tiers were used in DIFFERENT projects is not a comparison at all.
   */
  projectScoped: boolean;
}

interface SessionFacts {
  premium: boolean;
  project: string;
  rework: number;
  errorRate: number;
  premiumTokens: number;
  premiumCostUsd: number;
}

/** Per-root-session facts the comparison needs. Root sessions: fan-out counts with its driver. */
export function sessionFacts(events: StoredEvent[]): Map<string, SessionFacts> {
  const out = new Map<string, SessionFacts>();
  for (const [id, evs] of groupByRootSession(events)) {
    const m = computeMetrics(evs);
    let premiumTokens = 0, premiumCostUsd = 0;
    for (const [model, v] of Object.entries(m.byModel)) {
      if (!PREMIUM_MODEL_RE.test(model)) continue;
      premiumTokens += v.tokens;
      premiumCostUsd += v.costUsd;
    }
    out.set(id, {
      premium: premiumShare(m) >= PREMIUM_SESSION_SHARE,
      project: evs[0]?.project ?? 'unknown',
      rework: m.reworkRatio,
      errorRate: m.events ? m.errorEvents / m.events : 0,
      premiumTokens,
      premiumCostUsd,
    });
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Compare tiers within each category. `members` maps a category name to its
 * session ids; anything that fails a gate is dropped silently rather than
 * reported with a caveat, because a table full of "not enough data" rows
 * teaches people to skim past the rows that do mean something.
 */
export function computeRouting(
  members: Map<string, string[]>,
  facts: Map<string, SessionFacts>,
  rates: BlendedRates,
  days: number,
): RoutingRow[] {
  const monthly = days > 0 ? 30 / days : 1;
  const rows: RoutingRow[] = [];

  for (const [category, ids] of members) {
    const all = ids.map((id) => facts.get(id)).filter((f): f is SessionFacts => Boolean(f));
    if (all.length < MIN_CATEGORY_SESSIONS) continue;

    // Simpson's guard: if both tiers appear inside one project, compare there.
    // Otherwise the "comparison" may just be two different projects.
    let population = all;
    let projectScoped = false;
    const byProject = new Map<string, SessionFacts[]>();
    for (const f of all) byProject.set(f.project, [...(byProject.get(f.project) ?? []), f]);
    if (byProject.size > 1) {
      const usable = [...byProject.values()].find(
        (list) =>
          list.filter((f) => f.premium).length >= MIN_PER_SIDE &&
          list.filter((f) => !f.premium).length >= MIN_PER_SIDE,
      );
      if (!usable) continue; // tiers never met inside one project: not comparable
      population = usable;
      projectScoped = true;
    }

    const premium = population.filter((f) => f.premium);
    const cheap = population.filter((f) => !f.premium);
    if (premium.length < MIN_PER_SIDE || cheap.length < MIN_PER_SIDE) continue;

    const reworkDelta = mean(cheap.map((f) => f.rework)) - mean(premium.map((f) => f.rework));
    const errorDelta = mean(cheap.map((f) => f.errorRate)) - mean(premium.map((f) => f.errorRate));
    const premiumTokens = premium.reduce((s, f) => s + f.premiumTokens, 0);
    const premiumCostUsd = premium.reduce((s, f) => s + f.premiumCostUsd, 0);

    let verdict: RoutingRow['verdict'] = 'cheap-worse-unclear';
    let savingsUsdPerMonth: number | undefined;
    if (reworkDelta > NOISE_BAND || errorDelta > NOISE_BAND) {
      // The cheap tier did measurably worse here. Say nothing about savings.
      verdict = 'premium-better';
    } else if (Math.abs(reworkDelta) <= NOISE_BAND && Math.abs(errorDelta) <= NOISE_BAND) {
      verdict = 'no-measurable-gap';
      savingsUsdPerMonth = premiumTokens * Math.max(0, rates.premium - rates.cheap) * monthly;
    }

    rows.push({
      category, sessions: population.length,
      premiumSessions: premium.length, cheapSessions: cheap.length,
      premiumTokens, premiumCostUsd, reworkDelta, errorDelta, verdict,
      savingsUsdPerMonth, projectScoped,
    });
  }

  return rows.sort((a, b) => (b.savingsUsdPerMonth ?? -1) - (a.savingsUsdPerMonth ?? -1));
}

/**
 * The standing caveat, printed with the table. Within-category comparison
 * reduces selection bias — people route harder work to the premium tier — but
 * it does not remove it, which is why the verdict is always phrased as an
 * absence of measurable difference rather than a claim about the model.
 */
export const ROUTING_CAVEAT =
  'Within-category comparison reduces the "harder tasks go to the premium tier" bias but does not remove it. A row says there is no measurable outcome gap in THIS category on YOUR data — never that the premium model adds nothing.';
