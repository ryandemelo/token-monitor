#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { ADAPTERS } from './adapters/index.js';
import { openDb, insertEvents, loadEvents, DEFAULT_DB } from './store.js';
import { renderReport, renderTeamReport, renderTrend } from './report.js';
import { splitWindow } from './trends.js';
import { assignPersona, generalRecommendations } from './personas.js';
import { buildExport, parseTeamConfig, mergeMetrics, dedupeExports, rollupExports, displayName, identityOf } from './team.js';
import { syncFindings, recordLlmFindings } from './followthrough.js';
import { enrichFindings } from './recommendations.js';
import { reconcile, renderReconcile, PROVIDERS } from './reconcile.js';
import { computeMetrics } from './metrics.js';
import { renderHtml, renderTeamHtml } from './html.js';
import { renderAnalysis, deepAnalysis, buildLlmPrompt, buildLlmTrackPrompt, runLlm, runLlmCapture, parseLlmFindings, renderTrackedLlm, detectAgent } from './analyze.js';
import { signObject, verifyObject, ensureKeypair, fingerprint, loadKeyring, checkKeyring, keyDirFor, DEFAULT_KEY_DIR } from './sign.js';
import { fetchTeamConfig, saveConfig, loadConfig, pushExport, installSchedule, removeSchedule } from './deploy.js';
import { realpathSync } from 'node:fs';
import type { SignedExport, RollupAxis } from './team.js';
import type { Source } from './types.js';

const HELP = `token-monitor — measure how effectively your team spends AI coding-agent tokens

Usage:
  token-monitor collect [--source <name>] [--db <path>]
  token-monitor report  [--days <n>] [--trend] [--project <name>] [--source <name>] [--json] [--db <path>]
  token-monitor analyze [--days <n>] [--llm] [--track] [--agent claude|gemini|codex] [--json] [--db <path>]
  token-monitor html    [--out report.html] [--days <n>] [--db <path>]
  token-monitor merge   <export.json>... [--team teams.yaml] [--by team|discipline]
                        [--verify] [--keys keys.json] [--json] [--html team.html]
  token-monitor init    --from <url-or-path>
  token-monitor push    [--db <path>]
  token-monitor schedule [--hours <n>] [--remove]
  token-monitor reconcile [--provider anthropic|openai] [--days <n>] [--db <path>]
  token-monitor fingerprint [--db <path>]

Commands:
  collect   Scan local agent logs (Claude Code, Gemini CLI, Codex, Cursor,
            Antigravity, Copilot Chat) into SQLite
  report    Activity breakdown, cost, personas, and recommendations
  analyze   Session-level deep dive; --llm asks your local agent CLI for
            prioritized recommendations (sends aggregate metrics only); add
            --track to record those recommendations and measure (via
            follow-through) whether they actually moved their metric
  html      Self-contained HTML dashboard (no server, no external assets)
  merge     Combine member exports (report --json > me.json) into a team report
  init      Join a team: fetch the lead's config, set up keys, first collect,
            and (if configured) install the collection schedule
  push      Sign and deliver an export to the team destination from config
  schedule  Install/remove a recurring collect+push job (launchd/cron)
  reconcile Cross-check local totals against the provider's usage API (org
            lead only — needs ANTHROPIC_ADMIN_KEY or OPENAI_ADMIN_KEY in the
            environment; the key is never stored). Local > API = red flag.
  fingerprint  Print this machine's signing-key fingerprint (for keyring enrollment)

Integrity:
  Exports from \`report --json\` are Ed25519-signed. \`merge --verify\` rejects
  tampered or unsigned exports; add --keys keys.json ({"user": "fingerprint"})
  to also pin who may sign for whom.

Options:
  --source    one of: ${Object.keys(ADAPTERS).join(', ')} (default: all)
  --days      report window in days (default: 30)
  --trend     compare against the previous same-length window (terminal report;
              the HTML dashboard always includes the trend when data exists)
  --project   filter to one project
  --json      machine-readable output (for team aggregation)
  --team      member map: flat (\`alice: frontend\`) or two-level YAML
              (\`platform:\` header, indented members), or JSON
  --by        merge rollup axis: team or discipline (default: discipline)
  --html      also write the merged team dashboard to this path
  --db        SQLite path (default: ${DEFAULT_DB})
`;

function buildSignedExportJson(
  db: ReturnType<typeof openDb>,
  days: number,
  dbPath?: string,
  filters: { project?: string; source?: string } = {},
): string {
  const events = loadEvents(db, { days, ...filters });
  const ex = buildExport(events, days);
  const persona = assignPersona(ex.overall);
  const signed = signObject(
    {
      ...ex,
      persona,
      recommendations: [...persona.recommendations, ...generalRecommendations(ex.overall)],
      // Evidence is aggregate-only by construction: session ids, dates, token
      // counts and $ estimates — never prompts or code.
      recommendationDetails: enrichFindings(events, ex.overall, days),
    },
    keyDirFor(dbPath),
  );
  return JSON.stringify(signed, null, 2);
}

function runCollect(db: ReturnType<typeof openDb>, sources: Source[]): void {
  for (const source of sources) {
    const { events, result } = ADAPTERS[source]();
    result.eventsInserted = insertEvents(db, events);
    const note = result.note ? `  (${result.note})` : '';
    console.log(
      `${source.padEnd(12)} ${String(result.filesScanned).padStart(5)} files  ` +
        `${String(result.eventsFound).padStart(7)} turns  ` +
        `${String(result.eventsInserted).padStart(7)} new${note}`,
    );
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      days: { type: 'string', default: '30' },
      project: { type: 'string' },
      json: { type: 'boolean', default: false },
      trend: { type: 'boolean', default: false },
      team: { type: 'string' },
      out: { type: 'string', default: 'report.html' },
      llm: { type: 'boolean', default: false },
      track: { type: 'boolean', default: false },
      agent: { type: 'string' },
      verify: { type: 'boolean', default: false },
      keys: { type: 'string' },
      by: { type: 'string' },
      html: { type: 'string' },
      provider: { type: 'string' },
      from: { type: 'string' },
      hours: { type: 'string' },
      remove: { type: 'boolean', default: false },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'merge') {
    const files = positionals.slice(1);
    if (files.length === 0) {
      console.error('merge requires at least one export file (token-monitor report --json > me.json)');
      process.exit(1);
    }
    const by = (values.by ?? 'discipline') as RollupAxis;
    if (by !== 'team' && by !== 'discipline') {
      console.error(`--by must be "team" or "discipline", got "${values.by}"`);
      process.exit(1);
    }
    const keyring = values.keys ? loadKeyring(values.keys) : undefined;
    let verifyFailed = false;
    const all: SignedExport[] = files.map((f) => {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      if (data.version !== 1 || !data.overall) {
        throw new Error(`${f} is not a token-monitor v1 export`);
      }
      if (values.verify || keyring) {
        let vr = verifyObject(data);
        if (vr.ok && keyring) vr = checkKeyring(keyring, data.user, vr.fingerprint!);
        const mark = vr.ok ? '✓' : '✗';
        console.error(`${mark} ${f} (${data.user})${vr.ok ? ` — signed by ${vr.fingerprint}` : ` — ${vr.reason}`}`);
        if (!vr.ok) verifyFailed = true;
      }
      return data as SignedExport;
    });
    if (verifyFailed) {
      console.error('\nVerification failed — refusing to merge. Fix or exclude the exports above.');
      process.exit(1);
    }
    // Identity is the signing fingerprint (user@host for unsigned exports) —
    // the same signer pushing twice contributes only its newest export.
    const { kept: exports, dropped } = dedupeExports(all);
    for (const d of dropped) {
      console.error(`⊘ skipped stale export from ${displayName(d, keyring)} (${identityOf(d)}, generated ${d.generatedAt}) — newer one present`);
    }
    const team = values.team ? parseTeamConfig(values.team) : {};
    if (values.json) {
      const overall = mergeMetrics(exports.map((e) => e.overall));
      console.log(JSON.stringify({
        members: [...new Set(exports.map((e) => displayName(e, keyring)))],
        by,
        rollups: rollupExports(exports, team, by, keyring),
        overall,
        persona: assignPersona(overall),
      }, null, 2));
    } else {
      console.log(renderTeamReport(exports, team, { by, keyring }));
    }
    if (values.html) {
      writeFileSync(values.html, renderTeamHtml(exports, team, { by, keyring }));
      console.error(`Wrote ${values.html} (${exports.length} export(s)).`);
    }
    return;
  }

  if (cmd === 'fingerprint') {
    const { publicPem } = ensureKeypair(keyDirFor(values.db));
    console.log(fingerprint(publicPem));
    return;
  }

  const db = openDb(values.db);

  if (cmd === 'collect') {
    const sources = values.source
      ? [values.source as Source]
      : (Object.keys(ADAPTERS) as Source[]);
    if (values.source && !ADAPTERS[values.source as Source]) {
      console.error(`Unknown source "${values.source}". Valid: ${Object.keys(ADAPTERS).join(', ')}`);
      process.exit(1);
    }
    runCollect(db, sources);
    console.log(`\nStored in ${values.db ?? DEFAULT_DB}. Run \`token-monitor report\` next.`);
  } else if (cmd === 'init') {
    if (!values.from) {
      console.error('init requires --from <url-or-path> pointing at the team config JSON');
      process.exit(1);
    }
    const dir = keyDirFor(values.db) ?? DEFAULT_KEY_DIR;
    const config = await fetchTeamConfig(values.from);
    saveConfig(config, dir);
    const { publicPem } = ensureKeypair(keyDirFor(values.db));
    console.log(`Joined team "${config.teamName}". First collection:\n`);
    runCollect(db, Object.keys(ADAPTERS) as Source[]);
    let scheduleNote = 'none configured — run `token-monitor push` manually';
    if (config.scheduleHours) {
      scheduleNote = installSchedule(process.execPath, realpathSync(process.argv[1]), config.scheduleHours);
    }
    console.log(`
Schedule: ${scheduleNote}
Signing fingerprint (send to your team lead for keys.json):

  ${fingerprint(publicPem)}
`);
  } else if (cmd === 'push') {
    const config = loadConfig(keyDirFor(values.db) ?? DEFAULT_KEY_DIR);
    const days = Number(values.days) || config.windowDays || 30;
    const where = await pushExport(buildSignedExportJson(db, days, values.db), config);
    console.log(`Export (last ${days} days, signed) — ${where}`);
  } else if (cmd === 'schedule') {
    if (values.remove) {
      console.log(removeSchedule());
    } else {
      let hours = Number(values.hours) || 0;
      if (!hours) {
        try {
          hours = loadConfig(keyDirFor(values.db) ?? DEFAULT_KEY_DIR).scheduleHours ?? 24;
        } catch {
          hours = 24;
        }
      }
      console.log(installSchedule(process.execPath, realpathSync(process.argv[1]), hours));
    }
  } else if (cmd === 'report') {
    const days = Number(values.days) || 30;
    const filters = { project: values.project, source: values.source };
    if (values.json) {
      console.log(buildSignedExportJson(db, days, values.db, filters));
    } else {
      // With --trend, load both windows in one query and partition, so the
      // current slice and the comparison share the same boundary.
      const { current: events, previous } = values.trend
        ? splitWindow(loadEvents(db, { days: days * 2, ...filters }), days)
        : { current: loadEvents(db, { days, ...filters }), previous: [] };
      // Follow-through baselines only on unfiltered runs, so --project/--source
      // slices can't pollute them.
      const follow =
        !values.project && !values.source && events.length > 0
          ? syncFindings(db, computeMetrics(events))
          : undefined;
      let out = renderReport(events, { days, follow });
      if (values.trend && events.length > 0) out += '\n' + renderTrend(events, previous, days);
      console.log(out);
    }
  } else if (cmd === 'analyze') {
    const days = Number(values.days) || 30;
    const events = loadEvents(db, { days, project: values.project, source: values.source });
    if (events.length === 0) {
      console.log('No events in range. Run `token-monitor collect` first, or widen --days.');
      process.exit(0);
    }
    if (values.json) {
      console.log(JSON.stringify(deepAnalysis(events), null, 2));
    } else {
      console.log(renderAnalysis(events, days));
    }
    if (values.track) {
      if (values.project || values.source) {
        console.error('--track needs an unfiltered window so follow-through baselines stay clean; drop --project/--source.');
        process.exit(1);
      }
      const agent = values.agent ?? detectAgent();
      if (!agent) {
        console.error('No agent CLI found (looked for: claude, gemini, codex). Install one or pass --agent.');
        process.exit(1);
      }
      const { status, stdout } = runLlmCapture(buildLlmTrackPrompt(events, days), agent);
      // A nonzero exit means the run failed (rate limit, crash, partial output);
      // don't bank possibly-truncated advice as a permanent, never-clearing baseline.
      if (status !== 0) {
        console.error(`Agent exited with status ${status}; not recording (its output may be incomplete).`);
        process.exit(status);
      }
      const parsed = parseLlmFindings(stdout);
      if (parsed.interventions.length === 0) {
        console.error('No trackable interventions parsed from the agent response (expected strict JSON targeting a known metric).');
        process.exit(1);
      }
      const rows = recordLlmFindings(db, parsed.interventions, computeMetrics(events));
      console.log(renderTrackedLlm(rows, parsed));
      process.exit(0);
    }
    if (values.llm) {
      const agent = values.agent ?? detectAgent();
      if (!agent) {
        console.error('No agent CLI found (looked for: claude, gemini, codex). Install one or pass --agent.');
        process.exit(1);
      }
      process.exit(runLlm(buildLlmPrompt(events, days), agent));
    }
  } else if (cmd === 'reconcile') {
    const provider = values.provider ?? 'anthropic';
    if (!PROVIDERS[provider]) {
      console.error(`Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
      process.exit(1);
    }
    // Daily buckets cap the usage APIs at 31 days per request.
    let days = Number(values.days) || 30;
    if (days > 31) {
      console.error(`--days capped at 31 (the usage APIs report at most 31 daily buckets); using 31.`);
      days = 31;
    }
    const events = loadEvents(db, { days });
    const { rows, breach } = await reconcile(provider, events, days);
    console.log(renderReconcile(provider, rows, days));
    if (breach) process.exit(1);
  } else if (cmd === 'html') {
    const days = Number(values.days) || 30;
    const { current: events, previous } = splitWindow(loadEvents(db, { days: days * 2 }), days);
    const follow = events.length > 0 ? syncFindings(db, computeMetrics(events)) : undefined;
    writeFileSync(values.out, renderHtml(events, { days, follow, previousEvents: previous }));
    console.log(`Wrote ${values.out} (${events.length} turns, last ${days} days). Open it in a browser.`);
  } else {
    console.error(`Unknown command "${cmd}"\n`);
    console.log(HELP);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
