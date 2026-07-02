import type { StoredEvent } from './store.js';
import { computeMetrics, groupBy } from './metrics.js';
import type { Metrics } from './metrics.js';
import { ACTIVITIES } from './types.js';
import { assignPersona, generalRecommendations } from './personas.js';
import type { FollowRow } from './followthrough.js';
import { fmtMetric } from './followthrough.js';
import { fmtTokens } from './report.js';
import type { SignedExport, TeamConfig, RollupAxis } from './team.js';
import { mergeMetrics, rollupExports, displayName } from './team.js';
import { enrichFindings, fmtSavings, fmtEvidence, fmtCause, potentialBill, fmtPotential, blendedRates, realizedMonthly, fmtUsdShort } from './recommendations.js';
import { trendRows, verdictOf, fmtTrendValue, projectMovers } from './trends.js';
import type { CategorizeResult, CategoryRow, CategorizeSummary } from './categorize.js';
import { fmtCategorizeSummary } from './categorize.js';
import type { MergedCategories, OrgCategory } from './team-categories.js';

const ACTIVITY_COLORS: Record<string, string> = {
  thinking: '#8b7ff5',
  exploration: '#4fb3d9',
  coding: '#5dc98a',
  testing: '#e8c468',
  shipping: '#e88f68',
  conversation: '#9aa3b2',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

function cost(m: Metrics): string {
  return (m.costEstimated ? '~' : '') + '$' + m.costUsd.toFixed(2);
}

function stackedBar(m: Metrics): string {
  const segs = ACTIVITIES.filter((a) => m.byActivity[a].tokens > 0)
    .map(
      (a) =>
        `<div class="seg" style="width:${(m.byActivity[a].share * 100).toFixed(2)}%;background:${ACTIVITY_COLORS[a]}" title="${a} ${pct(m.byActivity[a].share)}"></div>`,
    )
    .join('');
  return `<div class="stack">${segs}</div>`;
}

export function renderHtml(
  events: StoredEvent[],
  opts: { days: number; follow?: FollowRow[]; previousEvents?: StoredEvent[]; categorize?: CategorizeSummary },
): string {
  const m = computeMetrics(events);
  const persona = assignPersona(m);
  const enriched = enrichFindings(events, m, opts.days);
  const recItems = [
    ...persona.recommendations.map((r) => `<li>${esc(r)}</li>`),
    ...enriched.map((r) => {
      const savings = fmtSavings(r);
      const cause = fmtCause(r);
      const ev = fmtEvidence(r);
      return `<li>${esc(r.message)}${savings ? ` <span class="save">${esc(savings)}</span>` : ''}${cause ? `<div class="ev muted">${esc(cause)}</div>` : ''}${ev ? `<div class="ev muted">${esc(ev)}</div>` : ''}</li>`;
    }),
  ].join('');
  const projects = [...groupBy(events, 'project').entries()]
    .map(([proj, evs]) => ({ proj, m: computeMetrics(evs) }))
    .sort((a, b) => b.m.spendTokens - a.m.spendTokens)
    .slice(0, 30);

  const cards = [
    ['Sessions', String(m.sessions)],
    ['Turns', String(m.events)],
    ['Spend tokens', fmtTokens(m.spendTokens)],
    ['Cache hit', pct(m.cacheHitRatio)],
    ['Rework', pct(m.reworkRatio)],
    ['Est. cost', cost(m)],
  ]
    .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  const legend = ACTIVITIES.filter((a) => m.byActivity[a].tokens > 0)
    .map(
      (a) =>
        `<span class="lg"><i style="background:${ACTIVITY_COLORS[a]}"></i>${a} ${pct(m.byActivity[a].share)} · ${fmtTokens(m.byActivity[a].tokens)}</span>`,
    )
    .join('');

  const projRows = projects
    .map(({ proj, m: pm }) => {
      const p = assignPersona(pm);
      return `<tr><td>${esc(proj)}</td><td>${stackedBar(pm)}</td><td class="num">${fmtTokens(pm.spendTokens)}</td><td class="num">${cost(pm)}</td><td class="num">${pct(pm.cacheHitRatio)}</td><td class="num">${pct(pm.reworkRatio)}</td><td>${p.emoji} ${p.name}</td></tr>`;
    })
    .join('');

  const modelRows = Object.entries(m.byModel)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(
      ([model, v]) =>
        `<tr><td>${esc(model)}</td><td class="num">${fmtTokens(v.tokens)}</td><td class="num">$${v.costUsd.toFixed(2)}</td></tr>`,
    )
    .join('');

  let trendSection = '';
  if (opts.previousEvents && opts.previousEvents.length) {
    const rows = trendRows(m, computeMetrics(opts.previousEvents));
    const cls = { better: 'st-improving', worse: 'st-regressing', neutral: '', flat: 'muted' } as const;
    const trendRowsHtml = rows
      .map((r) => {
        const d = r.now - r.prev;
        const v = verdictOf(r);
        const arrow = v === 'flat' ? '→' : d > 0 ? '↑' : '↓';
        return `<tr><td>${esc(r.label)}</td><td class="num">${fmtTrendValue(r, r.prev)}</td><td class="num">${fmtTrendValue(r, r.now)}</td><td class="num ${cls[v]}">${arrow} ${d >= 0 ? '+' : '−'}${fmtTrendValue(r, Math.abs(d))}</td></tr>`;
      })
      .join('');
    const movers = projectMovers(events, opts.previousEvents)
      .map(
        (p) =>
          `<tr><td>${esc(p.project)}</td><td class="num">${fmtTokens(p.prev)}</td><td class="num">${fmtTokens(p.now)}</td><td class="num">${p.delta >= 0 ? '+' : '−'}${fmtTokens(Math.abs(p.delta))}</td></tr>`,
      )
      .join('');
    trendSection = `<h2>Trend — vs the previous ${opts.days} days</h2>
<table><tr><th>Metric</th><th>Previous</th><th>Now</th><th>Change</th></tr>${trendRowsHtml}</table>
<h2>Top project movers</h2>
<table><tr><th>Project</th><th>Previous</th><th>Now</th><th>Change</th></tr>${movers}</table>`;
  }

  const rates = blendedRates(m);
  const followSection =
    opts.follow && opts.follow.length
      ? `<h2>Follow-through</h2><table><tr><th>Recommendation</th><th>Metric</th><th>Baseline</th><th>Now</th><th>Realized</th><th>Since</th><th>Status</th></tr>${opts.follow
          .map((f) => {
            const realized = realizedMonthly(f, m, rates, opts.days);
            return `<tr><td>${f.origin === 'llm' ? '🤖 ' : ''}${esc(f.key)}</td><td>${f.metric}</td><td class="num">${fmtMetric(f.metric, f.baseline)}</td><td class="num">${fmtMetric(f.metric, f.current)}</td><td class="num">${realized ? `<span class="save">+${fmtUsdShort(realized)}/mo</span>` : '<span class="muted">—</span>'}</td><td>${f.createdAt.slice(0, 10)}</td><td class="st-${f.status}">${f.status}</td></tr>`;
          })
          .join('')}</table>`
      : '';

  return pageShell(
    `token-monitor — last ${opts.days} days`,
    `<h1>token-monitor <span class="muted">— last ${opts.days} days · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</span></h1>
<div class="cards">${cards}</div>

<h2>Where the tokens go</h2>
${stackedBar(m)}
<div class="legend">${legend}</div>
<p class="muted">rework ${pct(m.reworkRatio)} · think:code ${m.thinkToCodeRatio.toFixed(2)} · ${m.errorEvents} turns hit tool errors</p>
<p class="muted">signals: context bloat ${m.bloatedSessions}/${m.trendSessions} long sessions · cold restarts ${pct(m.coldRestartShare)} of fresh input · premium on exploration/chat ${pct(m.premiumWasteShare)} · retry loops ${pct(m.retryShare)}</p>
${opts.categorize ? `<p class="dup">🔁 ${esc(fmtCategorizeSummary(opts.categorize))} <span class="muted">— run <code>categorize</code> for detail</span></p>` : ''}

<h2>Projects</h2>
<table><tr><th>Project</th><th>Activity mix</th><th>Tokens</th><th>Cost</th><th>Cache</th><th>Rework</th><th>Persona</th></tr>${projRows}</table>

<h2>Models</h2>
<table><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr>${modelRows}</table>
${trendSection}
<div class="persona">
  <h3>${persona.emoji} ${esc(persona.name)}</h3>
  <div class="muted">${esc(persona.description)}</div>
  ${(() => { const p = potentialBill(enriched, m, opts.days); return p ? `<div class="potential">${esc(fmtPotential(p))}</div>` : ''; })()}
  <ul class="recs">${recItems}</ul>
</div>
${followSection}`,
  );
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; background:#14171d; color:#e6e9ef; max-width: 1080px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 2rem; color:#9fb6d4; }
  .muted { color:#8a93a3; }
  .cards { display:grid; grid-template-columns: repeat(auto-fit,minmax(130px,1fr)); gap:.6rem; margin:1rem 0; }
  .card { background:#1c212b; border-radius:10px; padding:.7rem .9rem; }
  .card .k { font-size:.75rem; color:#8a93a3; text-transform:uppercase; letter-spacing:.05em; }
  .card .v { font-size:1.3rem; font-weight:600; margin-top:.15rem; }
  .stack { display:flex; height:14px; border-radius:7px; overflow:hidden; background:#252b37; min-width:140px; }
  .seg { height:100%; }
  .legend { display:flex; flex-wrap:wrap; gap:.9rem; margin:.6rem 0 0; }
  .lg { font-size:.85rem; color:#c2c9d6; } .lg i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:.35rem; }
  table { border-collapse:collapse; width:100%; margin-top:.6rem; }
  th { text-align:left; font-size:.75rem; color:#8a93a3; text-transform:uppercase; letter-spacing:.05em; padding:.35rem .6rem; border-bottom:1px solid #2a3140; }
  td { padding:.45rem .6rem; border-bottom:1px solid #1e242f; }
  td.num { text-align:right; font-variant-numeric: tabular-nums; }
  .persona { background:#1c212b; border-radius:10px; padding:1rem 1.2rem; margin-top:1rem; }
  .persona h3 { margin:.1rem 0 .4rem; }
  ul.recs { margin:.4rem 0 0; padding-left:1.2rem; } ul.recs li { margin:.3rem 0; }
  .save { color:#5dc98a; font-weight:600; white-space:nowrap; }
  .ev { font-size:.8rem; margin-top:.15rem; }
  .potential { margin:.5rem 0 .2rem; font-weight:600; color:#9fd45d; }
  .dup { margin:.3rem 0; color:#e8c468; }
  .dup code, td code { background:#252b37; border-radius:4px; padding:.05rem .3rem; }
  .st-resolved { color:#5dc98a; } .st-regressing { color:#e88f68; } .st-improving { color:#9fd45d; }
  footer { margin:2.5rem 0 1rem; font-size:.8rem; color:#717a8a; }
</style></head><body>
${body}
<footer>Generated locally by <a href="https://github.com/ryandemelo/token-monitor">token-monitor</a>. Costs marked ~ use placeholder prices. No data leaves your machine.</footer>
</body></html>`;
}

/** Org-category cost with the shared ~ estimation marker. */
const orgCost = (c: OrgCategory): string => (c.estimated ? '~' : '') + '$' + c.cost.toFixed(2);

/**
 * Cross-user duplicate work + org-skill sections for the team dashboard —
 * HTML parity with renderTeamReport's terminal sections. Everything member-
 * supplied flows through esc(): terms/names originate from redacted prompt
 * keywords, but a hand-built export is still attacker-controlled input.
 */
function teamCategorySections(mc: MergedCategories | undefined, memberCount: number): string {
  if (!mc || mc.withCategories === 0) {
    return `\n<h2>Cross-user duplicate work</h2>
<p class="muted">No task categories in these exports — members on ≥0.11 include them via <code>report --json</code> / <code>push</code>.</p>`;
  }
  const dupRows = mc.crossUserDuplicates
    .slice(0, 10)
    .map((c) => `<tr><td title="${esc(c.terms.join(' '))}">${esc(c.name)}</td><td>${esc(c.users.join(', '))}</td><td class="num">${c.sessions}</td><td class="num">${c.projects.length}</td><td class="num">${orgCost(c)}</td></tr>`)
    .join('');
  const skillRows = mc.orgSkillCandidates
    .slice(0, 10)
    .map((c) => `<tr><td title="${esc(c.terms.join(' '))}">${esc(c.name)}</td><td class="num">${c.userCount}</td><td class="num">${c.sessions}</td><td class="num">${orgCost(c)}</td><td class="num">${c.score}</td></tr>`)
    .join('');
  return `
<h2>Cross-user duplicate work</h2>
${
  mc.crossUserDuplicates.length > 0
    ? `<p class="dup">⚠ Same task done independently by ≥2 people — codify one org skill/prompt instead.</p>
<table><tr><th>Task</th><th>Users</th><th>Sessions</th><th>Projects</th><th>Cost</th></tr>${dupRows}</table>${
        mc.anyUnsigned
          ? `\n<p class="muted">Unsigned exports are identified as user@host — one person on two machines can read as two people.</p>`
          : ''
      }`
    : `<p class="muted">No cross-user duplicate work detected in member categories.</p>`
}
<h2>Org-skill candidates</h2>
${
  mc.orgSkillCandidates.length > 0
    ? `<table><tr><th>Task</th><th>Users</th><th>Sessions</th><th>Cost</th><th>Score</th></tr>${skillRows}</table>`
    : `<p class="muted">No recurring tasks worth codifying yet.</p>`
}
<p class="muted">Task categories from ${mc.withCategories} of ${memberCount} export(s). Labels are redacted keyword terms derived on-device; raw prompt text never leaves a member's machine.</p>`;
}

/** Org dashboard for merged member exports — the HTML face of `merge`. */
export function renderTeamHtml(
  exports: SignedExport[],
  config: TeamConfig,
  opts: { by?: RollupAxis; keyring?: Record<string, string>; categories?: MergedCategories } = {},
): string {
  const by = opts.by ?? 'discipline';
  const overall = mergeMetrics(exports.map((e) => e.overall));
  const rollups = rollupExports(exports, config, by, opts.keyring);
  const persona = assignPersona(overall);
  const recs = [...persona.recommendations, ...generalRecommendations(overall)];
  const members = new Set(exports.map((e) => displayName(e, opts.keyring)));

  const crossDup = opts.categories?.crossUserDuplicates ?? [];
  const cards = [
    ['Members', String(members.size)],
    ['Sessions', String(overall.sessions)],
    ['Spend tokens', fmtTokens(overall.spendTokens)],
    ['Cache hit', pct(overall.cacheHitRatio)],
    ['Rework', pct(overall.reworkRatio)],
    ['Est. cost', cost(overall)],
    ...(crossDup.length > 0
      ? [['Cross-user dup', (crossDup.some((c) => c.estimated) ? '~' : '') + '$' + crossDup.reduce((s, c) => s + c.cost, 0).toFixed(2)]]
      : []),
  ]
    .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  const axisLabel = by === 'team' ? 'Team' : 'Discipline';
  const rollupRows = rollups
    .map(({ group, users, metrics: m }) => {
      const p = assignPersona(m);
      return `<tr><td>${esc(group)}</td><td>${esc(users.join(', '))}</td><td>${stackedBar(m)}</td><td class="num">${fmtTokens(m.spendTokens)}</td><td class="num">${cost(m)}</td><td class="num">${pct(m.cacheHitRatio)}</td><td class="num">${pct(m.reworkRatio)}</td><td class="num">${m.thinkToCodeRatio.toFixed(2)}</td><td>${p.emoji} ${esc(p.name)}</td></tr>`;
    })
    .join('');

  return pageShell(
    `token-monitor team — ${members.size} member(s)`,
    `<h1>token-monitor team <span class="muted">— ${exports.length} export(s), ${members.size} member(s)</span></h1>
<div class="cards">${cards}</div>

<h2>By ${by}</h2>
<table><tr><th>${axisLabel}</th><th>Members</th><th>Activity mix</th><th>Tokens</th><th>Cost</th><th>Cache</th><th>Rework</th><th>Think:code</th><th>Persona</th></tr>${rollupRows}</table>
${teamCategorySections(opts.categories, exports.length)}
<div class="persona">
  <h3>${persona.emoji} ${esc(persona.name)}</h3>
  <div class="muted">${esc(persona.description)}</div>
  <ul class="recs">${recs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
</div>`,
  );
}

/** Dashboard face of `categorize` — task clusters, duplicate work, skill candidates. */
export function renderCategorizeHtml(r: CategorizeResult, days: number): string {
  const title = `token-monitor — task categories (last ${days} days)`;
  if (r.totalSessions === 0) {
    return pageShell(
      title,
      `<h1>Task categories</h1>
<p class="muted">No sessions in range. Run <code>token-monitor collect</code> first, or widen the window.</p>`,
    );
  }
  const catCost = (c: CategoryRow): string => (c.estimated ? '~' : '') + '$' + c.cost.toFixed(2);

  const cards = [
    ['Sessions', String(r.totalSessions)],
    ['From prompt text', String(r.textSessions)],
    ['Categories', String(r.categories.length)],
    ['Duplicate tasks', String(r.duplicates.length)],
  ]
    .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  const catRows = r.categories
    .slice(0, 40)
    .map(
      (c) =>
        `<tr><td>${c.duplicate ? '⚠ ' : ''}${esc(c.name)}${c.hasText ? '' : ' <span class="muted">(no text)</span>'}</td><td class="num">${c.sessions}</td><td class="num">${c.projects.length}</td><td class="num">${fmtTokens(c.tokens)}</td><td class="num">${catCost(c)}</td></tr>`,
    )
    .join('');

  const dupSection = r.duplicates.length
    ? `<h2>Duplicate work <span class="muted">— same task across ≥2 projects</span></h2>
<table><tr><th>Task</th><th>Sessions</th><th>Projects</th><th>Where</th><th>Cost</th></tr>${r.duplicates
        .slice(0, 20)
        .map(
          (c) =>
            `<tr><td>⚠ ${esc(c.name)}</td><td class="num">${c.sessions}</td><td class="num">${c.projects.length}</td><td>${esc(c.projects.join(', '))}</td><td class="num">${catCost(c)}</td></tr>`,
        )
        .join('')}</table>
<p class="muted">Recurring across projects → codify it as a shared skill/prompt instead of re-deriving it.</p>`
    : `<h2>Duplicate work</h2>
<p class="muted">No task repeated across multiple projects in this window.</p>`;

  const skillSection = r.skillCandidates.length
    ? `<h2>Org-skill candidates <span class="muted">— recurring tasks worth codifying</span></h2>
<table><tr><th>Task</th><th>Sessions</th><th>Projects</th><th>Cost</th></tr>${r.skillCandidates
        .slice(0, 20)
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td class="num">${c.sessions}</td><td class="num">${c.projects.length}</td><td class="num">${catCost(c)}</td></tr>`,
        )
        .join('')}</table>`
    : '';

  return pageShell(
    title,
    `<h1>Task categories <span class="muted">— last ${days} days · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</span></h1>
<div class="cards">${cards}</div>

<h2>By category</h2>
<table><tr><th>Category</th><th>Sessions</th><th>Projects</th><th>Tokens</th><th>Cost</th></tr>${catRows}</table>
${dupSection}
${skillSection}
<p class="muted">Labels are derived on-device from redacted prompts; raw prompt text is never stored.</p>`,
  );
}
