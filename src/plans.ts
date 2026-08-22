/**
 * Subscription plans, vendored the same way `PRICES` is: a small editable
 * table with a checked date, and `estimated` on anything the public page
 * does not state outright.
 *
 * Why this exists. Every dollar figure this tool prints is API-equivalent —
 * what the same tokens would have cost at API rates — but most individuals
 * and SME teams run coding agents on a **seat**. "You spent $15k this
 * fortnight" is unanswerable advice for someone paying a flat $200 a month:
 * the only decision a seat holder actually has is which tier to be on.
 *
 * What this deliberately is NOT: a quota or limit tracker. Plan limits are
 * expressed as multipliers over shifting baselines with their own windows,
 * and there is no supported programmatic usage API to read them from. Prices
 * only. A confident-looking wrong quota number would be worse than nothing.
 */

export interface Plan {
  id: string;
  label: string;
  /** USD per month, billed monthly. Per seat where the plan is per seat. */
  monthlyUsd: number;
  /** USD per month when billed annually, where the vendor publishes one. */
  annualUsd?: number;
  perSeat?: boolean;
  /** True when the public price page does not state this number outright. */
  estimated?: boolean;
  note?: string;
}

/**
 * Checked against https://claude.com/pricing on 2026-08-22. Edit to match
 * your own contract — that is the intended use, not an oversight.
 */
export const PLANS: Plan[] = [
  { id: 'pro', label: 'Pro', monthlyUsd: 20, annualUsd: 17 },
  { id: 'max-5x', label: 'Max 5x', monthlyUsd: 100 },
  {
    id: 'max-20x',
    label: 'Max 20x',
    monthlyUsd: 200,
    estimated: true,
    note: 'the pricing page lists Max as "from $100/month" without naming the 20x figure — edit if your invoice says otherwise',
  },
  { id: 'team-standard', label: 'Team standard seat', monthlyUsd: 25, annualUsd: 20, perSeat: true },
  { id: 'team-premium', label: 'Team premium seat', monthlyUsd: 125, annualUsd: 100, perSeat: true },
];

export const PLAN_IDS = PLANS.map((p) => p.id);

export function findPlan(id: string): Plan | undefined {
  const wanted = id.trim().toLowerCase();
  return PLANS.find((p) => p.id === wanted);
}

export interface SeatComparison {
  plan: Plan;
  /** API-equivalent spend for this window, scaled to a month. */
  apiEquivalentMonthlyUsd: number;
  seatMonthlyUsd: number;
  /** API-equivalent ÷ seat price. 2.1 means the seat buys 2.1× its price. */
  ratio: number;
  /** True when either side of the ratio rests on an estimate. */
  estimated: boolean;
  /** Under this many days the monthly projection is too thin to state. */
  thin: boolean;
}

/** Windows shorter than this project too noisily to quote a monthly figure. */
export const MIN_PROJECTION_DAYS = 7;

export function seatComparison(
  costUsd: number,
  days: number,
  plan: Plan,
  opts: { estimated?: boolean; annual?: boolean } = {},
): SeatComparison {
  const monthly = days > 0 ? costUsd * (30 / days) : 0;
  const seat = (opts.annual && plan.annualUsd) || plan.monthlyUsd;
  return {
    plan,
    apiEquivalentMonthlyUsd: monthly,
    seatMonthlyUsd: seat,
    ratio: seat > 0 ? monthly / seat : 0,
    estimated: Boolean(opts.estimated || plan.estimated),
    thin: days < MIN_PROJECTION_DAYS,
  };
}

/**
 * The sentence. Deliberately directional rather than prescriptive: the ratio
 * says how much value the seat is returning at API-equivalent prices, and a
 * ratio below 1 is a prompt to look at a lower tier, never an instruction —
 * plenty of people rightly pay for headroom they rarely use.
 */
export function fmtSeatComparison(c: SeatComparison): string {
  const t = c.estimated ? '~' : '';
  const usd = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(2));
  const head = `API-equivalent ${t}$${usd(c.apiEquivalentMonthlyUsd)}/mo against a $${usd(c.seatMonthlyUsd)}/mo ${c.plan.label}`;
  if (c.thin) {
    return `${head} — projected from under ${MIN_PROJECTION_DAYS} days of data, so read the ratio as a hint, not a number.`;
  }
  const ratio = `≈${c.ratio.toFixed(1)}× the seat price`;
  if (c.ratio >= 1.5) return `${head} — ${ratio}. The seat is returning well over what it costs.`;
  if (c.ratio >= 0.8) return `${head} — ${ratio}. About break-even against API rates.`;
  return `${head} — ${ratio}. A lower tier may fit, if the headroom is not what you are paying for.`;
}

/** The standing caveat. Printed wherever a seat comparison appears. */
export const SEAT_CAVEAT =
  'API-equivalent pricing of subscription traffic is an analogy for value-for-money, not a bill, and this is not a quota tracker — plan limits are not readable from anything local.';
