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
  opts: { days: number; follow?: FollowRow[] },
): string {
  const m = computeMetrics(events);
  const persona = assignPersona(m);
  const recs = [...persona.recommendations, ...generalRecommendations(m)];
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

  const followSection =
    opts.follow && opts.follow.length
      ? `<h2>Follow-through</h2><table><tr><th>Recommendation</th><th>Metric</th><th>Baseline</th><th>Now</th><th>Since</th><th>Status</th></tr>${opts.follow
          .map(
            (f) =>
              `<tr><td>${esc(f.key)}</td><td>${f.metric}</td><td class="num">${fmtMetric(f.metric, f.baseline)}</td><td class="num">${fmtMetric(f.metric, f.current)}</td><td>${f.createdAt.slice(0, 10)}</td><td class="st-${f.status}">${f.status}</td></tr>`,
          )
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

<h2>Projects</h2>
<table><tr><th>Project</th><th>Activity mix</th><th>Tokens</th><th>Cost</th><th>Cache</th><th>Rework</th><th>Persona</th></tr>${projRows}</table>

<h2>Models</h2>
<table><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr>${modelRows}</table>

<div class="persona">
  <h3>${persona.emoji} ${esc(persona.name)}</h3>
  <div class="muted">${esc(persona.description)}</div>
  <ul class="recs">${recs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
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
  .st-resolved { color:#5dc98a; } .st-regressing { color:#e88f68; } .st-improving { color:#9fd45d; }
  footer { margin:2.5rem 0 1rem; font-size:.8rem; color:#717a8a; }
</style></head><body>
${body}
<footer>Generated locally by <a href="https://github.com/ryandemelo/token-monitor">token-monitor</a>. Costs marked ~ use placeholder prices. No data leaves your machine.</footer>
</body></html>`;
}

/** Org dashboard for merged member exports — the HTML face of `merge`. */
export function renderTeamHtml(
  exports: SignedExport[],
  config: TeamConfig,
  opts: { by?: RollupAxis; keyring?: Record<string, string> } = {},
): string {
  const by = opts.by ?? 'discipline';
  const overall = mergeMetrics(exports.map((e) => e.overall));
  const rollups = rollupExports(exports, config, by, opts.keyring);
  const persona = assignPersona(overall);
  const recs = [...persona.recommendations, ...generalRecommendations(overall)];
  const members = new Set(exports.map((e) => displayName(e, opts.keyring)));

  const cards = [
    ['Members', String(members.size)],
    ['Sessions', String(overall.sessions)],
    ['Spend tokens', fmtTokens(overall.spendTokens)],
    ['Cache hit', pct(overall.cacheHitRatio)],
    ['Rework', pct(overall.reworkRatio)],
    ['Est. cost', cost(overall)],
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

<div class="persona">
  <h3>${persona.emoji} ${esc(persona.name)}</h3>
  <div class="muted">${esc(persona.description)}</div>
  <ul class="recs">${recs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
</div>`,
  );
}
