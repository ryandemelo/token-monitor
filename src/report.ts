import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';
import { ACTIVITIES } from './types.js';
import { assignPersona, generalRecommendations } from './personas.js';
import type { SignedExport, TeamConfig, RollupAxis } from './team.js';
import { mergeMetrics, rollupExports, dominantActivity, displayName } from './team.js';
import type { FollowRow } from './followthrough.js';
import { fmtMetric } from './followthrough.js';
import type { EnrichedRec } from './recommendations.js';
import { enrichFindings, fmtSavings, fmtEvidence } from './recommendations.js';
import type { TrendRow, TrendVerdict } from './trends.js';
import { trendRows, verdictOf, fmtTrendValue, projectMovers } from './trends.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtCost(m: Metrics): string {
  const prefix = m.costEstimated ? '~' : '';
  let s = `${prefix}$${m.costUsd.toFixed(2)}`;
  if (m.costUnpricedTokens > 0) s += ` ${DIM}(+${fmtTokens(m.costUnpricedTokens)} tok unpriced)${RESET}`;
  return s;
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
  opts: { days: number; follow?: FollowRow[] },
): string {
  if (events.length === 0) {
    return 'No events in range. Run `token-monitor collect` first, or widen --days.';
  }
  const m = computeMetrics(events);
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
  out.push(
    `\n  ${DIM}rework ratio ${(m.reworkRatio * 100).toFixed(1)}%  ·  think:code ${m.thinkToCodeRatio.toFixed(2)}  ·  ${m.errorEvents} turns hit tool errors${RESET}`,
  );
  out.push(
    `  ${DIM}signals: context bloat ${m.bloatedSessions}/${m.trendSessions} long sessions  ·  cold restarts ${(m.coldRestartShare * 100).toFixed(0)}% of fresh input  ·  premium on exploration/chat ${(m.premiumWasteShare * 100).toFixed(0)}%  ·  retry loops ${(m.retryShare * 100).toFixed(1)}%${RESET}`,
  );

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
  for (const r of persona.recommendations) out.push(`  ${YELLOW}→${RESET} ${r}`);
  out.push(...renderEnrichedRecs(enrichFindings(events, m, opts.days)));

  if (opts.follow && opts.follow.length > 0) {
    out.push(section('Follow-through (recommendation → measured change)'));
    out.push(
      table(
        ['Recommendation', 'Metric', 'Baseline', 'Now', 'Since', 'Status'],
        opts.follow.map((f) => [
          f.key,
          f.metric,
          fmtMetric(f.metric, f.baseline),
          fmtMetric(f.metric, f.current),
          f.createdAt.slice(0, 10),
          STATUS_LABEL[f.status],
        ]),
      ),
    );
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
  out.push(
    table(
      ['Metric', 'Previous', 'Now', 'Change'],
      rows.map((r) => [r.label, fmtTrendValue(r, r.prev), fmtTrendValue(r, r.now), trendDelta(r)]),
    ),
  );
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

/** Finding lines with savings + worst-session evidence — shared with `analyze`. */
export function renderEnrichedRecs(recs: EnrichedRec[]): string[] {
  const out: string[] = [];
  for (const r of recs) {
    const savings = fmtSavings(r);
    out.push(`  ${YELLOW}→${RESET} ${r.message}${savings ? `  ${GREEN}${savings}${RESET}` : ''}`);
    const ev = fmtEvidence(r);
    if (ev) out.push(`    ${DIM}${ev}${RESET}`);
  }
  return out;
}

export function renderTeamReport(
  exports: SignedExport[],
  config: TeamConfig,
  opts: { by?: RollupAxis; keyring?: Record<string, string> } = {},
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
