import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';
import { ACTIVITIES } from './types.js';
import { assignPersona, generalRecommendations } from './personas.js';
import type { SignedExport, TeamConfig, RollupAxis } from './team.js';
import { mergeMetrics, rollupExports, dominantActivity, displayName, staleMembers } from './team.js';
import type { FollowRow } from './followthrough.js';
import { fmtMetric } from './followthrough.js';
import type { EnrichedRec } from './recommendations.js';
import { enrichFindings, fmtSavings, fmtEvidence, fmtCause, potentialBill, fmtPotential, blendedRates, realizedMonthly, fmtUsdShort } from './recommendations.js';
import type { TrendRow, TrendVerdict } from './trends.js';
import { trendRows, verdictOf, fmtTrendValue, projectMovers } from './trends.js';
import type { SourceCoverage } from './coverage.js';
import { computeCoverage, fmtCoverage, readRetentionDays, retentionNote, trendIsComparable } from './coverage.js';
import type { CategorizeResult, CategorizeSummary } from './categorize.js';
import { ROI_MIN_BEFORE_SESSIONS } from './skills.js';
import type { RoutingRow } from './routing.js';
import { MIN_CATEGORY_SESSIONS, MIN_PER_SIDE, NOISE_BAND, ROUTING_CAVEAT } from './routing.js';
import { fmtCategorizeSummary } from './categorize.js';
import type { MergedCategories, OrgCategory } from './team-categories.js';
import type { RelayResult, RelaySummary } from './relay-scan.js';
import { fmtTokens } from './fmt.js';
import type { Rule } from './rules/index.js';
import { RULES, RULE_BY_KEY } from './rules/index.js';
import type { ToolSurface } from './tool-surface.js';
import type { Plan } from './plans.js';
import { findPlan, seatComparison, fmtSeatComparison, SEAT_CAVEAT } from './plans.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

// Re-exported so the many `import { fmtTokens } from './report.js'` call
// sites keep working; the implementation lives in fmt.ts so rules can use it
// without importing the renderer.
export { fmtTokens };

function fmtCost(m: Metrics): string {
  const prefix = m.costEstimated ? '~' : '';
  let s = `${prefix}$${m.costUsd.toFixed(2)}`;
  if (m.costUnpricedTokens > 0) s += ` ${DIM}(+${fmtTokens(m.costUnpricedTokens)} tok unpriced)${RESET}`;
  return s;
}

/**
 * Subagent clause for the signals line, empty when no fan-out was collected —
 * five of six sources never produce sidechain turns, and a permanent "0%" on
 * their reports would be noise pretending to be a measurement.
 */
/**
 * How the cold-restart number was measured. Silent unless some sessions used
 * the extended cache — otherwise every report would carry a "~5 min" aside
 * that has always been true and tells the reader nothing.
 */
export function fmtCacheTtl(m: Metrics): string {
  if (!m.extendedCacheSessions) return '';
  return m.extendedCacheSessions === m.sessions
    ? '  ·  gaps measured against the 1h cache (every session)'
    : `  ·  gaps measured against the 1h cache on ${m.extendedCacheSessions} of ${m.sessions} sessions`;
}

/**
 * The context-surface one-liner: the floor every turn re-reads and the results
 * still riding along in it. Each half is silent when it was not measured —
 * a window with too few sessions to take a median over, or sources that don't
 * persist tool results, must not read as a floor of zero.
 */
export function fmtContextSurface(m: Metrics): string {
  const parts: string[] = [];
  if (m.floorSessions >= 1 && m.sessionFloorTokens > 0) {
    parts.push(`context floor ${fmtTokens(m.sessionFloorTokens)}/session (${(m.floorShare * 100).toFixed(0)}% of main-loop context)`);
  }
  if (m.toolResultTurns > 0) {
    parts.push(`tool-result carry ~${(m.toolResultCarryShare * 100).toFixed(0)}%`);
  }
  return parts.join('  ·  ');
}

/**
 * The outcomes line: what the window's tokens bought. Deliberately three
 * plain facts rather than a verdict — a research week that ships nothing is
 * not waste, and the metric only ever answers "how much of this window's
 * spend reached a ship signal".
 *
 * Silent on a window with no conversations to speak of, and the abandoned
 * clause is silent when nothing has been idle long enough to say.
 */
export function fmtOutcomes(m: Metrics): string {
  if (!m.conversations) return '';
  const parts = [
    `outcomes: ${m.shippedSessions}/${m.conversations} sessions reached a ship signal (${(m.shippedShare * 100).toFixed(0)}%)`,
  ];
  if (m.shippedSessions > 0) {
    parts.push(`~$${m.costPerShippedSession.toFixed(2)} per shipped session`);
  }
  if (m.abandonedStreams > 0) {
    parts.push(`${fmtTokens(m.abandonedTokens)} tok in ${m.abandonedStreams} idle unshipped stream(s)`);
  }
  if (m.openStreams > 0) {
    parts.push(`${m.openStreams} still open`);
  }
  return parts.join('  ·  ');
}

export function fmtSubagents(m: Metrics): string {
  if (!m.subagentSessions) return '';
  const runs = m.subagentSessions === 1 ? '1 run' : `${m.subagentSessions} runs`;
  return `  ·  subagents ${(m.subagentShare * 100).toFixed(0)}% of spend (${runs})`;
}

function bar(share: number, width = 24): string {
  const filled = Math.round(share * width);
  return '█'.repeat(filled) + DIM + '░'.repeat(width - filled) + RESET;
}

export function table(headers: string[], rows: string[][]): string {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths = headers.map((h, i) =>
    Math.max(strip(h).length, ...rows.map((r) => strip(r[i] ?? '').length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - strip(s).length));
  const line = (cells: string[]) => '  ' + cells.map((c, i) => pad(c, widths[i])).join('  ');
  return [
    line(headers.map((h) => BOLD + h + RESET)),
    line(widths.map((w) => DIM + '─'.repeat(w) + RESET)),
    ...rows.map(line),
  ].join('\n');
}

export function section(title: string): string {
  return `\n${BOLD}${CYAN}${title}${RESET}\n`;
}

const STATUS_LABEL: Record<FollowRow['status'], string> = {
  new: '◷ new',
  tracking: '— tracking',
  improving: '↗ improving',
  regressing: '⚠ regressing',
  resolved: '✅ resolved',
};

export function renderReport(
  events: StoredEvent[],
  opts: {
    days: number; follow?: FollowRow[]; categorize?: CategorizeSummary; relay?: RelaySummary;
    plan?: Plan; annual?: boolean; prSessions?: Set<string>;
  },
): string {
  if (events.length === 0) {
    return 'No events in range. Run `token-monitor collect` first, or widen --days.';
  }
  const m = computeMetrics(events, { prSessions: opts.prSessions });
  const out: string[] = [];

  out.push(section(`Token Monitor — last ${opts.days} days`));
  out.push(
    table(
      ['Sessions', 'Turns', 'Input', 'Output', 'Cache read', 'Cache hit', 'Est. cost'],
      [[
        String(m.sessions),
        String(m.events),
        fmtTokens(m.inputTokens),
        fmtTokens(m.outputTokens),
        fmtTokens(m.cacheReadTokens),
        (m.cacheHitRatio * 100).toFixed(0) + '%',
        fmtCost(m),
      ]],
    ),
  );

  out.push(section('Where the tokens go (activity share of input+output)'));
  const actRows = ACTIVITIES.filter((a) => m.byActivity[a].events > 0).map((a) => [
    a,
    bar(m.byActivity[a].share),
    (m.byActivity[a].share * 100).toFixed(1) + '%',
    fmtTokens(m.byActivity[a].tokens),
    String(m.byActivity[a].events),
  ]);
  out.push(table(['Activity', '', 'Share', 'Tokens', 'Turns'], actRows));
  const coverage = computeCoverage(events, opts.days);
  out.push(`\n  ${DIM}coverage: ${fmtCoverage(coverage)}${RESET}`);
  const note = retentionNote(coverage, opts.days, readRetentionDays());
  if (note) out.push(`  ${YELLOW}⚠${RESET} ${DIM}${note}${RESET}`);

  out.push(
    `  ${DIM}rework ratio ${(m.reworkRatio * 100).toFixed(1)}%  ·  think:code ${m.thinkToCodeRatio.toFixed(2)}  ·  ${m.errorEvents} turns hit tool errors${RESET}`,
  );
  out.push(
    `  ${DIM}signals: context bloat ${m.bloatedSessions}/${m.trendSessions} long sessions  ·  cold restarts ${(m.coldRestartShare * 100).toFixed(0)}% of main-loop fresh input  ·  premium on exploration/chat ${(m.premiumWasteShare * 100).toFixed(0)}%  ·  retry loops ${(m.retryShare * 100).toFixed(1)}%${fmtSubagents(m)}${fmtCacheTtl(m)}${RESET}`,
  );
  const ctx = fmtContextSurface(m);
  if (ctx) out.push(`  ${DIM}${ctx}  ${RESET}${DIM}— run \`context\` for detail${RESET}`);
  const outcomes = fmtOutcomes(m);
  if (outcomes) out.push(`  ${DIM}${outcomes}${RESET}`);
  if (opts.categorize) {
    out.push(
      `  ${YELLOW}🔁 ${fmtCategorizeSummary(opts.categorize)}${RESET} ${DIM}— run \`categorize\` for detail${RESET}`,
    );
  }
  if (opts.relay) {
    out.push(
      `  ${YELLOW}📋 ${fmtRelaySummary(opts.relay)}${RESET} ${DIM}— run \`relay\` for detail${RESET}`,
    );
  }

  out.push(section('By project'));
  const projRows = [...groupBy(events, 'project').entries()]
    .map(([proj, evs]) => ({ proj, m: computeMetrics(evs) }))
    .sort((a, b) => b.m.spendTokens - a.m.spendTokens)
    .slice(0, 15)
    .map(({ proj, m: pm }) => {
      const p = assignPersona(pm);
      return [
        proj.length > 28 ? proj.slice(0, 27) + '…' : proj,
        fmtTokens(pm.spendTokens),
        (pm.costEstimated ? '~' : '') + '$' + pm.costUsd.toFixed(2),
        (pm.cacheHitRatio * 100).toFixed(0) + '%',
        (pm.reworkRatio * 100).toFixed(0) + '%',
        `${p.emoji} ${p.name}`,
      ];
    });
  out.push(table(['Project', 'Tokens', 'Cost', 'Cache', 'Rework', 'Persona'], projRows));

  out.push(section('By model'));
  const modelRows = Object.entries(m.byModel)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([model, v]) => [model, fmtTokens(v.tokens), '$' + v.costUsd.toFixed(2)]);
  out.push(table(['Model', 'Tokens', 'Cost'], modelRows));

  const persona = assignPersona(m);
  out.push(section(`Overall persona: ${persona.emoji} ${persona.name}`));
  out.push(`  ${persona.description}\n`);
  out.push(`${BOLD}${GREEN}Recommendations${RESET}`);
  const enriched = enrichFindings(events, m, opts.days);
  const potential = potentialBill(enriched, m, opts.days);
  if (potential) out.push(`  ${BOLD}${fmtPotential(potential)}${RESET}`);
  for (const r of persona.recommendations) out.push(`  ${YELLOW}→${RESET} ${r}`);
  out.push(...renderEnrichedRecs(enriched));

  if (opts.follow && opts.follow.length > 0) {
    const rates = blendedRates(m);
    out.push(section('Follow-through (recommendation → measured change)'));
    out.push(
      table(
        ['Recommendation', 'Metric', 'Baseline', 'Now', 'Realized', 'Since', 'Status'],
        opts.follow.map((f) => {
          const realized = realizedMonthly(f, m, rates, opts.days);
          return [
            (f.origin === 'llm' ? '🤖 ' : '') + f.key,
            f.metric,
            fmtMetric(f.metric, f.baseline),
            fmtMetric(f.metric, f.current),
            realized ? `${GREEN}+${fmtUsdShort(realized)}/mo${RESET}` : `${DIM}—${RESET}`,
            f.createdAt.slice(0, 10),
            STATUS_LABEL[f.status],
          ];
        }),
      ),
    );
  }

  if (opts.plan) {
    const seat = seatComparison(m.costUsd, opts.days, opts.plan, { estimated: m.costEstimated, annual: opts.annual });
    out.push(section('Seat value'));
    out.push(`  ${BOLD}${fmtSeatComparison(seat)}${RESET}`);
    if (opts.plan.note) out.push(`  ${DIM}${opts.plan.label}: ${opts.plan.note}.${RESET}`);
    out.push(`  ${DIM}${SEAT_CAVEAT}${RESET}`);
  }

  out.push(`\n${DIM}Cost figures marked ~ use placeholder prices — edit src/pricing.ts.${RESET}\n`);
  return out.join('\n');
}

const TREND_COLOR: Record<TrendVerdict, string> = {
  better: GREEN,
  worse: RED,
  neutral: '',
  flat: DIM,
};

function trendDelta(r: TrendRow): string {
  const d = r.now - r.prev;
  const arrow = verdictOf(r) === 'flat' ? '→' : d > 0 ? '↑' : '↓';
  const color = TREND_COLOR[verdictOf(r)];
  return `${color}${arrow} ${d >= 0 ? '+' : '−'}${fmtTrendValue(r, Math.abs(d))}${color ? RESET : ''}`;
}

export function renderTrend(
  current: StoredEvent[],
  previous: StoredEvent[],
  days: number,
): string {
  const out: string[] = [];
  out.push(section(`Trend — last ${days} days vs the ${days} before`));
  if (previous.length === 0) {
    out.push(`  ${DIM}No events in the previous window — trends appear once two windows of data exist.${RESET}`);
    return out.join('\n');
  }
  const rows = trendRows(computeMetrics(current), computeMetrics(previous));
  // An arrow drawn across a previous window with far less data measures the
  // collection gap, not the behaviour. Report the shortfall instead of a
  // verdict — a false "improving" costs more than a missing arrow.
  const cmp = trendIsComparable(current, previous);
  out.push(
    table(
      ['Metric', 'Previous', 'Now', 'Change'],
      rows.map((r) => [
        r.label,
        fmtTrendValue(r, r.prev),
        fmtTrendValue(r, r.now),
        cmp.comparable ? trendDelta(r) : `${DIM}insufficient data${RESET}`,
      ]),
    ),
  );
  if (!cmp.comparable) {
    out.push(
      `\n  ${YELLOW}⚠${RESET} ${DIM}the previous window has ${cmp.previousDays} day(s) of data against ${cmp.currentDays} now — too little to call a direction, so no arrows are drawn.${RESET}`,
    );
  }
  const movers = projectMovers(current, previous);
  if (movers.length) {
    out.push(`\n  ${BOLD}Top project movers (spend)${RESET}`);
    out.push(
      table(
        ['Project', 'Previous', 'Now', 'Change'],
        movers.map((p) => [
          p.project.length > 28 ? p.project.slice(0, 27) + '…' : p.project,
          fmtTokens(p.prev),
          fmtTokens(p.now),
          `${p.delta >= 0 ? '+' : '−'}${fmtTokens(Math.abs(p.delta))}`,
        ]),
      ),
    );
  }
  return out.join('\n');
}

export function renderCategorize(r: CategorizeResult, days: number): string {
  if (r.totalSessions === 0) {
    return 'No sessions in range. Run `token-monitor collect` first, or widen --days.';
  }
  const out: string[] = [];
  out.push(section(`Task categories — last ${days} days`));
  out.push(
    `  ${DIM}${r.totalSessions} sessions · ${r.textSessions} categorized from prompt text · ${r.categories.length} categories${RESET}`,
  );

  out.push(section('By category'));
  out.push(
    table(
      ['Category', 'Sessions', 'Projects', 'Tokens', 'Cost'],
      r.categories.slice(0, 20).map((c) => [
        (c.duplicate ? '⚠ ' : '') + c.name + (c.hasText ? '' : ` ${DIM}(no text)${RESET}`),
        String(c.sessions),
        String(c.projects.length),
        fmtTokens(c.tokens),
        (c.estimated ? '~' : '') + '$' + c.cost.toFixed(2),
      ]),
    ),
  );

  out.push(section('Duplicate work (same task across ≥2 projects)'));
  if (r.duplicates.length) {
    for (const c of r.duplicates.slice(0, 10)) {
      out.push(
        `  ${YELLOW}⚠${RESET} ${BOLD}${c.name}${RESET} — ${c.sessions} sessions across ${c.projects.length} projects ` +
          `${DIM}(${c.projects.join(', ')})${RESET}  ${GREEN}${c.estimated ? '~' : ''}$${c.cost.toFixed(2)}${RESET}`,
      );
    }
    out.push(
      `\n  ${DIM}Recurring across projects → codify it as a shared skill/prompt instead of re-deriving it.${RESET}`,
    );
  } else {
    out.push(`  ${DIM}No task repeated across multiple projects in this window.${RESET}`);
  }

  if (r.skillCandidates.length) {
    out.push(section('Org-skill candidates (recurring tasks worth codifying)'));
    out.push(
      table(
        ['Task', 'Sessions', 'Projects', 'Cost'],
        r.skillCandidates.slice(0, 10).map((c) => [
          c.name,
          String(c.sessions),
          String(c.projects.length),
          (c.estimated ? '~' : '') + '$' + c.cost.toFixed(2),
        ]),
      ),
    );
  }

  out.push(...renderRouting(r.routing ?? []));
  out.push(...renderSkillAdoption(r));

  out.push(
    `\n  ${DIM}Labels are derived on-device from redacted prompts; raw prompt text is never stored.${RESET}\n`,
  );
  return out.join('\n');
}

const ROUTING_VERDICT: Record<RoutingRow['verdict'], string> = {
  'no-measurable-gap': '≈ no measurable gap',
  'premium-better': '↑ premium did better',
  'cheap-worse-unclear': '— unclear',
};

/**
 * Per-category routing evidence: where a recurring task ran on both tiers and
 * the cheaper one showed no measurably worse outcome. Empty for most people,
 * on purpose — the gates are strict because the row is an argument about
 * someone's judgement.
 */
export function renderRouting(rows: RoutingRow[]): string[] {
  const out: string[] = [];
  if (rows.length === 0) return out;
  out.push(section('Routing by task (categories that ran on both tiers)'));
  out.push(
    table(
      ['Category', 'Sessions', 'Premium', 'Cheap', 'Δ rework', 'Δ errors', 'Premium $', 'Verdict', 'If routed down'],
      rows.slice(0, 10).map((r) => [
        (r.projectScoped ? '◦ ' : '') + (r.category.length > 22 ? r.category.slice(0, 21) + '…' : r.category),
        String(r.sessions),
        String(r.premiumSessions),
        String(r.cheapSessions),
        (r.reworkDelta >= 0 ? '+' : '−') + Math.abs(r.reworkDelta * 100).toFixed(0) + 'pp',
        (r.errorDelta >= 0 ? '+' : '−') + Math.abs(r.errorDelta * 100).toFixed(0) + 'pp',
        '$' + r.premiumCostUsd.toFixed(2),
        ROUTING_VERDICT[r.verdict],
        r.savingsUsdPerMonth ? `${GREEN}~$${r.savingsUsdPerMonth.toFixed(0)}/mo${RESET}` : `${DIM}—${RESET}`,
      ]),
    ),
  );
  out.push(
    `\n  ${DIM}Δ is the cheap side minus the premium side, in percentage points: positive means the cheaper tier did worse. Gates: ≥${MIN_CATEGORY_SESSIONS} sessions in the category and ≥${MIN_PER_SIDE} on each tier, and differences within ±${(NOISE_BAND * 100).toFixed(0)}pp count as no gap.${RESET}`,
  );
  if (rows.some((r) => r.projectScoped)) {
    out.push(
      `  ${DIM}◦ marks a comparison confined to the one project where both tiers were actually used — comparing across projects would compare the projects, not the tiers.${RESET}`,
    );
  }
  out.push(`  ${DIM}${ROUTING_CAVEAT}${RESET}`);
  out.push(
    `  ${DIM}The "if routed down" figure overlaps the premium-misroute and premium-model-overuse findings; it is shown here as per-category evidence and is deliberately NOT added to the report's headline potential.${RESET}`,
  );
  return out;
}

const ROI_STATUS: Record<string, string> = {
  realized: '✅ realized',
  tracking: '— tracking',
  'no-change': '— no change yet',
  'insufficient-history': '— needs more history',
};

/**
 * Skill adoption and ROI. Answers the question `categorize` has been asking
 * users to act on for three releases — "codify it as a shared skill" — and
 * whether doing so actually killed the duplicate work.
 *
 * Skill names appear here and nowhere else: local terminal only.
 */
export function renderSkillAdoption(r: CategorizeResult): string[] {
  const out: string[] = [];
  const skills = r.skills;
  if (!skills || skills.unmeasured) return out;

  out.push(section('Skill adoption'));
  const active = skills.usage.filter((u) => !u.dormant);
  const dormant = skills.usage.filter((u) => u.dormant);
  if (active.length === 0 && dormant.length === 0) {
    out.push(`  ${DIM}No skill invocations recorded. Only Claude Code attributes turns to skills today.${RESET}`);
    return out;
  }
  if (active.length > 0) {
    out.push(
      table(
        ['Skill', 'Sessions', 'Turns', 'First seen', 'Last used'],
        active.slice(0, 15).map((u) => [
          u.skill, String(u.sessions), String(u.turns), u.firstSeen.slice(0, 10), u.lastSeen.slice(0, 10),
        ]),
      ),
    );
    out.push(
      `  ${DIM}Turns, not invocations: a skill attributes every turn it stays active for, so sessions are the adoption number.${RESET}`,
    );
  }
  if (dormant.length > 0) {
    out.push(
      `\n  ${YELLOW}⚠${RESET} ${dormant.length} skill(s) used historically but not once in this window: ${dormant.slice(0, 8).map((u) => u.skill).join(', ')}`,
    );
    out.push(
      `  ${DIM}Transcripts only reach back as far as your agent's retention, so "never used" here means "not seen in what survives".${RESET}`,
    );
  }

  if (skills.roi.length > 0) {
    out.push(section('Did codifying it work? (category recurrence before → after the skill)'));
    out.push(
      table(
        ['Skill', 'Category', 'Link', 'Before/30d', 'After/30d', 'Realized', 'Status'],
        skills.roi.slice(0, 10).map((r2) => [
          r2.skill,
          r2.category.length > 24 ? r2.category.slice(0, 23) + '…' : r2.category,
          r2.link,
          r2.beforePer30 ? r2.beforePer30.toFixed(1) : `${DIM}—${RESET}`,
          r2.afterPer30 ? r2.afterPer30.toFixed(1) : `${DIM}—${RESET}`,
          r2.realizedUsdPerMonth ? `${GREEN}~$${r2.realizedUsdPerMonth.toFixed(0)}/mo${RESET}` : `${DIM}—${RESET}`,
          ROI_STATUS[r2.status] ?? r2.status,
        ]),
      ),
    );
    out.push(
      `\n  ${DIM}Name-matched pairs (link "terms") are CANDIDATES — they show the before/after numbers and never a dollar figure, because nothing in the data says a skill was written for a category. Assert the link in ~/.token-monitor/skill-map.json to unlock the estimate.${RESET}`,
    );
    out.push(
      `  ${DIM}A "map" figure still needs recurrence to have FALLEN with the skill in use, and at least ${ROI_MIN_BEFORE_SESSIONS} sessions before it appeared. A category can also fade because a project ended — this is correlation, and the number is recurrence delta × the category's average session cost.${RESET}`,
    );
  }
  return out;
}

/** Finding lines with savings + worst-session evidence — shared with `analyze`. */
/**
 * The relay report. Leads with the honest denominator: re-paid input is
 * cheap, so the headline is how much text was carried by hand, with the
 * dollar figure kept beside it rather than in front of it. The remedy is the
 * point — a file, a subagent, or a skill instead of a clipboard.
 */
/** Shared wording for the one-line relay callout in report/html. */
export function fmtRelaySummary(r: RelaySummary): string {
  const p = r.pairs === 1 ? '1 prompt' : `${r.pairs} prompts`;
  return `${p} repeated an earlier session's output (${fmtTokens(r.relayedWords)} words carried by hand)`;
}

export function renderRelay(r: RelayResult): string {
  const out: string[] = [];
  out.push(section(`Relay waste — last ${r.days} days`));
  if (r.pairs.length === 0) {
    out.push(
      `  ${DIM}No prompts in this window substantially repeat an earlier session's output.${RESET}`,
    );
    out.push(
      `  ${DIM}${r.fingerprinted} session(s) fingerprinted. Detection needs both sides: a source session whose output was collected, and a later prompt that repeats it.${RESET}\n`,
    );
    return out.join('\n');
  }

  const cost = (r.estimated ? '~' : '') + '$' + r.relayedCostUsd.toFixed(2);
  out.push(
    `  ${BOLD}${fmtTokens(r.relayedWords)} words of prompt text were carried over from an earlier session${RESET} ` +
      `${DIM}(${(r.relayedShare * 100).toFixed(1)}% of everything typed or pasted, ${cost} re-paid as fresh input)${RESET}`,
  );
  out.push(
    `  ${DIM}The re-paid input itself is cheap. The cost that matters is the work it re-triggers — and text a person moves by hand is work the toolchain could have handed over directly.${RESET}\n`,
  );

  out.push(
    table(
      ['From', 'To', 'Overlap', 'Words', 'Gap', 'Route'],
      r.pairs.slice(0, 12).map((p) => [
        p.fromSessionId.slice(0, 8),
        p.toSessionId.slice(0, 8),
        (p.overlap * 100).toFixed(0) + '%',
        fmtTokens(p.relayedWords),
        p.gapDays + 'd',
        p.fromSource === p.toSource ? p.fromSource : `${p.fromSource} → ${p.toSource}`,
      ]),
    ),
  );
  out.push(
    `\n  ${YELLOW}→${RESET} Write the output to a file and point the next session at it, or let a subagent carry it — either way the text stops being re-typed.`,
  );
  out.push(
    `  ${DIM}Overlap is measured on hashed 8-word shingles; prompt and response text is never stored, printed, or sent.${RESET}\n`,
  );
  return out.join('\n');
}

/**
 * Context economics: what the standing surface costs before a turn does
 * anything. Three sections, in the order the money is usually found — the
 * floor every turn re-reads, the results still riding along, and the servers
 * whose definitions are part of that floor.
 *
 * Server and tool names appear HERE ONLY. They can name a client or an
 * internal system, so they never enter an export or an --llm payload.
 */
export function renderContext(m: Metrics, surface: ToolSurface, days: number): string {
  const out: string[] = [];
  out.push(section(`Context economics — last ${days} days`));

  if (m.floorSessions >= 1 && m.sessionFloorTokens > 0) {
    out.push(
      `  ${BOLD}Session floor ${fmtTokens(m.sessionFloorTokens)} tokens${RESET} ` +
        `${DIM}(median of the smallest context each of ${m.floorSessions} main-loop session(s) ran with) — ${(m.floorShare * 100).toFixed(0)}% of main-loop context spend${RESET}`,
    );
    out.push(
      `  ${DIM}System prompt, tool definitions of every connected MCP server, skills, and always-loaded memory files. Written once per session, re-read every turn after.${RESET}`,
    );
  } else {
    out.push(`  ${DIM}Session floor: too few main-loop sessions in this window to take a median over.${RESET}`);
  }

  out.push(section('Tool-result carry (what returned payloads cost while they ride along)'));
  if (!surface.measured) {
    out.push(
      `  ${DIM}No source in this window records tool results, so carry is unmeasured — not zero. Claude Code is the only source that persists them today.${RESET}`,
    );
  } else {
    const est = m.costEstimated ? '~' : '~'; // always estimated: chars/4 + no-compaction assumption
    out.push(
      `  ${BOLD}${est}${fmtTokens(surface.totalCarryTokens)} carried tokens${RESET} ` +
        `${DIM}from ${est}${fmtTokens(surface.totalReturnedTokens)} returned — ${(m.toolResultCarryShare * 100).toFixed(0)}% of all input-side tokens, ${est}$${surface.totalCarryUsd.toFixed(2)} at cache-read rates${RESET}`,
    );
    out.push('');
    out.push(
      table(
        ['Tool', 'Calls', 'Returned', 'Avg carried', 'Carried tok', 'Cost'],
        surface.tools.slice(0, 12).map((t) => [
          t.tool.length > 34 ? t.tool.slice(0, 33) + '…' : t.tool,
          String(t.calls),
          '~' + fmtTokens(t.returnedTokens),
          t.avgCarriedTurns.toFixed(1) + ' turns',
          '~' + fmtTokens(t.carryTokens),
          '~$' + t.carryUsd.toFixed(2),
        ]),
      ),
    );
    out.push(
      `\n  ${YELLOW}→${RESET} Bound the big ones: a line limit, a narrower search, a paged call — or hand the payload to a subagent whose context ends with it.`,
    );
  }

  out.push(section('MCP servers'));
  if (surface.servers.length === 0) {
    out.push(`  ${DIM}No MCP tool calls in this window.${RESET}`);
  } else {
    out.push(
      table(
        ['Server', 'Tools', 'Turns', 'Spend', 'Cost', 'Errors', 'Returned', 'Last used'],
        surface.servers.map((s) => [
          s.server.length > 24 ? s.server.slice(0, 23) + '…' : s.server,
          String(s.tools),
          String(s.turns),
          fmtTokens(s.spendTokens),
          '$' + s.costUsd.toFixed(2),
          s.errorTurns ? `${(s.errorRate * 100).toFixed(0)}%` : `${DIM}—${RESET}`,
          s.returnedTokens ? '~' + fmtTokens(s.returnedTokens) : `${DIM}—${RESET}`,
          s.lastUsed,
        ]),
      ),
    );
  }

  if (surface.unusedServers.length > 0) {
    out.push('');
    out.push(
      `  ${YELLOW}⚠${RESET} ${BOLD}${surface.unusedServers.length} connected server(s) were never invoked in this window${RESET}: ${surface.unusedServers.join(', ')}`,
    );
    out.push(
      `  ${DIM}Their tool definitions are still part of every request's floor. Usage is not value — a server called twice may have saved an afternoon — but a server called zero times is paying rent.${RESET}`,
    );
  } else if (surface.configNote) {
    out.push(`\n  ${DIM}${surface.configNote}.${RESET}`);
  } else if (surface.declaredServers.length) {
    out.push(`\n  ${DIM}All ${surface.declaredServers.length} connected server(s) were invoked at least once.${RESET}`);
  }
  if (surface.undeclaredServers.length > 0) {
    out.push(
      `  ${DIM}${surface.undeclaredServers.length} invoked server(s) appear in no config this command can read (a project .mcp.json, or a plugin), so the connected list — and anything said about unused servers — is a lower bound.${RESET}`,
    );
  }

  out.push(
    `\n  ${DIM}Result sizes are estimated from characters (~4 chars/token). A result is counted as carried until its session ends or its context collapses (compaction and /clear are not logged, but the drop they cause is measurable) — an upper bound, additionally clamped to what each session actually paid. Server and tool names stay on this machine: they are never exported, signed, or sent to an LLM.${RESET}\n`,
  );
  return out.join('\n');
}

/**
 * The rule catalogue — every waste heuristic the tool knows, whether it fires
 * on the current window, and where its file lives. It doubles as the
 * contributor's index: the list IS the extension point.
 */
export function renderRules(m?: Metrics): string {
  const out: string[] = [];
  out.push(section(`Waste rules (${RULES.length})`));
  const firing = new Set(m ? RULES.filter((r) => r.fires(m)).map((r) => r.key) : []);
  out.push(
    table(
      ['', 'Rule', 'Metric', 'Goal', 'Family', 'Savings'],
      RULES.map((r) => [
        m ? (firing.has(r.key) ? `${YELLOW}⚠${RESET}` : `${DIM}·${RESET}`) : ' ',
        r.key,
        r.metric,
        r.direction === 'up' ? '↑ raise' : '↓ lower',
        r.family ?? `${DIM}—${RESET}`,
        r.savings ? 'priced' : `${DIM}advice only${RESET}`,
      ]),
    ),
  );
  if (m) {
    const n = firing.size;
    out.push(`\n  ${DIM}${n === 0 ? 'none firing' : `${n} firing`} on the current window (⚠). Run \`token-monitor rules <key>\` for what one measures.${RESET}`);
  } else {
    out.push(`\n  ${DIM}Run \`token-monitor rules <key>\` for what one measures, or with a collected database to see which fire.${RESET}`);
  }
  out.push(
    `  ${DIM}Each rule is one file in src/rules/ — see CONTRIBUTING.md to add one.${RESET}\n`,
  );
  return out.join('\n');
}

/** One rule's documentation, for `token-monitor rules <key>`. */
export function renderRule(rule: Rule, m?: Metrics): string {
  const out: string[] = [];
  out.push(section(`${rule.key} — ${rule.title}`));
  out.push(
    `  ${DIM}metric${RESET} ${rule.metric}  ${DIM}·${RESET} ${rule.direction === 'up' ? 'higher is better' : 'lower is better'}` +
      `  ${DIM}·${RESET} family ${rule.family ?? 'none'}  ${DIM}·${RESET} ${rule.savings ? 'savings priced' : 'advice only'}`,
  );
  if (m) {
    const message = rule.fires(m);
    out.push(
      message
        ? `  ${YELLOW}⚠ fires on the current window:${RESET} ${message}`
        : `  ${GREEN}✓${RESET} ${DIM}does not fire on the current window${RESET}`,
    );
  }
  out.push('');
  for (const line of rule.docs.split('\n')) out.push(`  ${line}`);
  out.push(`\n  ${DIM}src/rules/${rule.key}.ts${RESET}\n`);
  return out.join('\n');
}

export function lookupRule(key: string): Rule | undefined {
  return RULE_BY_KEY.get(key);
}

export function renderEnrichedRecs(recs: EnrichedRec[]): string[] {
  const out: string[] = [];
  for (const r of recs) {
    const savings = fmtSavings(r);
    out.push(`  ${YELLOW}→${RESET} ${r.message}${savings ? `  ${GREEN}${savings}${RESET}` : ''}`);
    const cause = fmtCause(r);
    if (cause) out.push(`    ${DIM}${cause}${RESET}`);
    const ev = fmtEvidence(r);
    if (ev) out.push(`    ${DIM}${ev}${RESET}`);
  }
  return out;
}

const catCost = (c: OrgCategory): string => (c.estimated ? '~' : '') + '$' + c.cost.toFixed(2);

/**
 * Cross-user duplicate work + org-skill candidates for the team report.
 * Three duplicate tiers stay visually distinct — member-local cross-project
 * (carried flag), cross-user (the headline), and skill candidates — because
 * they are different accusations with different remedies.
 */
function renderTeamCategoryLines(mc: MergedCategories, memberCount: number): string[] {
  const out: string[] = [];
  if (mc.withCategories === 0) {
    out.push(
      `  ${DIM}No task categories in these exports — members on ≥0.11 include them via report --json / push.${RESET}`,
    );
    return out;
  }

  out.push(section('Cross-user duplicate work (same task, ≥2 people)'));
  if (mc.crossUserDuplicates.length > 0) {
    const dupCost = mc.crossUserDuplicates.reduce((s, c) => s + c.cost, 0);
    const est = mc.crossUserDuplicates.some((c) => c.estimated) ? '~' : '';
    const tasks = mc.crossUserDuplicates.length === 1 ? '1 task' : `${mc.crossUserDuplicates.length} tasks`;
    out.push(`  ${BOLD}${est}$${dupCost.toFixed(2)} spent on tasks done independently by ≥2 people (${tasks})${RESET}\n`);
    for (const c of mc.crossUserDuplicates.slice(0, 10)) {
      out.push(
        `  ${YELLOW}⚠${RESET} ${BOLD}${c.name}${RESET} — ${c.sessions} session(s) by ${c.users.join(', ')}` +
          ` across ${c.projects.length} project(s)  ${GREEN}${catCost(c)}${RESET}`,
      );
    }
    out.push(`\n  ${DIM}Same task, different people → codify one org skill/prompt instead of re-deriving it per person.${RESET}`);
    if (mc.anyUnsigned) {
      out.push(`  ${DIM}Unsigned exports are identified as user@host — one person on two machines can read as two people.${RESET}`);
    }
  } else {
    out.push(`  ${DIM}No cross-user duplicate work detected in member categories.${RESET}`);
  }

  if (mc.orgSkillCandidates.length > 0) {
    out.push(section('Org-skill candidates (team-wide)'));
    out.push(
      table(
        ['Task', 'Users', 'Sessions', 'Cost', 'Score'],
        mc.orgSkillCandidates.slice(0, 10).map((c) => [
          c.name, String(c.userCount), String(c.sessions), catCost(c), String(c.score),
        ]),
      ),
    );
  }

  if (mc.withinMemberDupCost > 0) {
    out.push(
      `  ${DIM}within-member duplicate work: $${mc.withinMemberDupCost.toFixed(2)} across ${mc.withinMemberDupMembers} member(s) — each should run categorize locally.${RESET}`,
    );
  }
  out.push(`  ${DIM}task categories from ${mc.withCategories} of ${memberCount} export(s)${RESET}`);
  out.push(
    `  ${DIM}Category labels are redacted keyword terms derived on-device; raw prompt text never leaves a member's machine.${RESET}`,
  );
  return out;
}

export function renderTeamReport(
  exports: SignedExport[],
  config: TeamConfig,
  opts: { by?: RollupAxis; keyring?: Record<string, string>; categories?: MergedCategories } = {},
): string {
  const by = opts.by ?? 'discipline';
  const axisLabel = by === 'team' ? 'Team' : 'Discipline';
  const out: string[] = [];
  const overall = mergeMetrics(exports.map((e) => e.overall));

  out.push(section(`Team Token Monitor — ${exports.length} member export(s)`));
  out.push(
    table(
      ['Members', 'Sessions', 'Tokens', 'Cache hit', 'Rework', 'Est. cost'],
      [[
        String(new Set(exports.map((e) => displayName(e, opts.keyring))).size),
        String(overall.sessions),
        fmtTokens(overall.spendTokens),
        (overall.cacheHitRatio * 100).toFixed(0) + '%',
        (overall.reworkRatio * 100).toFixed(0) + '%',
        fmtCost(overall),
      ]],
    ),
  );

  out.push(section(`By ${by}`));
  const rollups = rollupExports(exports, config, by, opts.keyring);
  out.push(
    table(
      [axisLabel, 'Members', 'Tokens', 'Cost', 'Cache', 'Rework', 'Think:code', 'Top activity', 'Persona'],
      rollups.map(({ group, users, metrics: m }) => {
        const p = assignPersona(m);
        return [
          group,
          users.join(', '),
          fmtTokens(m.spendTokens),
          (m.costEstimated ? '~' : '') + '$' + m.costUsd.toFixed(2),
          (m.cacheHitRatio * 100).toFixed(0) + '%',
          (m.reworkRatio * 100).toFixed(0) + '%',
          m.thinkToCodeRatio.toFixed(2),
          dominantActivity(m),
          `${p.emoji} ${p.name}`,
        ];
      }),
    ),
  );

  out.push(section(`Activity mix by ${by}`));
  for (const { group, metrics: m } of rollups) {
    out.push(`  ${BOLD}${group}${RESET}`);
    for (const a of ACTIVITIES) {
      if (m.byActivity[a].tokens === 0) continue;
      out.push(`    ${a.padEnd(13)} ${bar(m.byActivity[a].share)} ${(m.byActivity[a].share * 100).toFixed(1)}%`);
    }
  }

  // Seat value, only for the members who declared a plan. A team on mixed
  // tiers still gets rows for the ones who did; members without a plan show
  // "—" rather than being quietly assumed onto the lead's own tier.
  const declared = exports.filter((e) => e.plan && findPlan(e.plan));
  if (declared.length > 0) {
    out.push(section('Seat value (members who declared a plan)'));
    let seatTotal = 0;
    let apiTotal = 0;
    let anyEstimated = false;
    const rows = declared.map((e) => {
      const plan = findPlan(e.plan!)!;
      const c = seatComparison(e.overall.costUsd, e.days, plan, { estimated: e.overall.costEstimated });
      seatTotal += c.seatMonthlyUsd;
      apiTotal += c.apiEquivalentMonthlyUsd;
      anyEstimated ||= c.estimated;
      return [
        displayName(e, opts.keyring),
        plan.label,
        `$${c.seatMonthlyUsd.toFixed(0)}/mo`,
        `${c.estimated ? '~' : ''}$${c.apiEquivalentMonthlyUsd.toFixed(0)}/mo`,
        c.thin ? `${DIM}thin window${RESET}` : `${c.ratio.toFixed(1)}×`,
      ];
    });
    const undeclared = exports.length - declared.length;
    if (undeclared > 0) {
      rows.push([`${DIM}${undeclared} member(s) with no declared plan${RESET}`, `${DIM}—${RESET}`, `${DIM}—${RESET}`, `${DIM}—${RESET}`, `${DIM}—${RESET}`]);
    }
    out.push(table(['Member', 'Plan', 'Seat', 'API-equivalent', 'Ratio'], rows));
    const t = anyEstimated ? '~' : '';
    out.push(
      `\n  ${BOLD}${t}$${apiTotal.toFixed(0)}/mo of API-equivalent work on $${seatTotal.toFixed(0)}/mo of seats${RESET}` +
        ` ${DIM}(${seatTotal > 0 ? (apiTotal / seatTotal).toFixed(1) : '0'}× across the declared seats)${RESET}`,
    );
    out.push(`  ${DIM}${SEAT_CAVEAT}${RESET}`);
  }

  const stale = staleMembers(exports, opts.keyring);
  if (stale.length) {
    out.push(section('Stale data'));
    for (const s of stale) {
      out.push(`  ${YELLOW}⚠${RESET} ${s.name} — newest ${s.source} data is ${s.staleDays}d old`);
    }
    out.push(
      `  ${DIM}A quiet week and a broken collect look the same from here; ask before reading these members' numbers as low usage.${RESET}`,
    );
  }

  if (opts.categories) out.push(...renderTeamCategoryLines(opts.categories, exports.length));

  const persona = assignPersona(overall);
  out.push(section(`Team persona: ${persona.emoji} ${persona.name}`));
  out.push(`  ${persona.description}\n`);
  out.push(`${BOLD}${GREEN}Recommendations${RESET}`);
  for (const r of [...persona.recommendations, ...generalRecommendations(overall)]) {
    out.push(`  ${YELLOW}→${RESET} ${r}`);
  }
  out.push('');
  return out.join('\n');
}
