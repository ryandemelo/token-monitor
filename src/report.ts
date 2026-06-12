import type { Metrics } from './metrics.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { StoredEvent } from './store.js';
import { ACTIVITIES } from './types.js';
import { assignPersona, generalRecommendations } from './personas.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

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

function table(headers: string[], rows: string[][]): string {
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

function section(title: string): string {
  return `\n${BOLD}${CYAN}${title}${RESET}\n`;
}

export function renderReport(events: StoredEvent[], opts: { days: number }): string {
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
  const recs = [...persona.recommendations, ...generalRecommendations(m)];
  out.push(`${BOLD}${GREEN}Recommendations${RESET}`);
  for (const r of recs) out.push(`  ${YELLOW}→${RESET} ${r}`);

  out.push(`\n${DIM}Cost figures marked ~ use placeholder prices — edit src/pricing.ts.${RESET}\n`);
  return out.join('\n');
}
