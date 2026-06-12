#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { ADAPTERS } from './adapters/index.js';
import { openDb, insertEvents, loadEvents, DEFAULT_DB } from './store.js';
import { renderReport, renderTeamReport } from './report.js';
import { assignPersona, generalRecommendations } from './personas.js';
import { buildExport, parseTeamConfig, mergeMetrics } from './team.js';
import { syncFindings } from './followthrough.js';
import { computeMetrics } from './metrics.js';
import { renderHtml } from './html.js';
import { renderAnalysis, deepAnalysis, buildLlmPrompt, runLlm, detectAgent } from './analyze.js';
import { signObject, verifyObject, ensureKeypair, fingerprint, loadKeyring, checkKeyring, keyDirFor, DEFAULT_KEY_DIR } from './sign.js';
import { fetchTeamConfig, saveConfig, loadConfig, pushExport, installSchedule, removeSchedule } from './deploy.js';
import { realpathSync } from 'node:fs';
import type { ExportV1 } from './team.js';
import type { Source } from './types.js';

const HELP = `token-monitor — measure how effectively your team spends AI coding-agent tokens

Usage:
  token-monitor collect [--source <name>] [--db <path>]
  token-monitor report  [--days <n>] [--project <name>] [--source <name>] [--json] [--db <path>]
  token-monitor analyze [--days <n>] [--llm] [--agent claude|gemini|codex] [--json] [--db <path>]
  token-monitor html    [--out report.html] [--days <n>] [--db <path>]
  token-monitor merge   <export.json>... [--team team.yaml] [--verify] [--keys keys.json] [--json]
  token-monitor init    --from <url-or-path>
  token-monitor push    [--db <path>]
  token-monitor schedule [--hours <n>] [--remove]
  token-monitor fingerprint [--db <path>]

Commands:
  collect   Scan local agent logs (Claude Code, Gemini CLI, Codex) into SQLite
  report    Activity breakdown, cost, personas, and recommendations
  analyze   Session-level deep dive; --llm asks your local agent CLI for
            prioritized recommendations (sends aggregate metrics only)
  html      Self-contained HTML dashboard (no server, no external assets)
  merge     Combine member exports (report --json > me.json) into a team report
  init      Join a team: fetch the lead's config, set up keys, first collect,
            and (if configured) install the collection schedule
  push      Sign and deliver an export to the team destination from config
  schedule  Install/remove a recurring collect+push job (launchd/cron)
  fingerprint  Print this machine's signing-key fingerprint (for keyring enrollment)

Integrity:
  Exports from \`report --json\` are Ed25519-signed. \`merge --verify\` rejects
  tampered or unsigned exports; add --keys keys.json ({"user": "fingerprint"})
  to also pin who may sign for whom.

Options:
  --source    one of: ${Object.keys(ADAPTERS).join(', ')} (default: all)
  --days      report window in days (default: 30)
  --project   filter to one project
  --json      machine-readable output (for team aggregation)
  --team      username -> discipline map, flat YAML or JSON
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
    { ...ex, persona, recommendations: [...persona.recommendations, ...generalRecommendations(ex.overall)] },
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
      team: { type: 'string' },
      out: { type: 'string', default: 'report.html' },
      llm: { type: 'boolean', default: false },
      agent: { type: 'string' },
      verify: { type: 'boolean', default: false },
      keys: { type: 'string' },
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
    const keyring = values.keys ? loadKeyring(values.keys) : undefined;
    let verifyFailed = false;
    const exports: ExportV1[] = files.map((f) => {
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
      return data as ExportV1;
    });
    if (verifyFailed) {
      console.error('\nVerification failed — refusing to merge. Fix or exclude the exports above.');
      process.exit(1);
    }
    const team = values.team ? parseTeamConfig(values.team) : {};
    if (values.json) {
      const overall = mergeMetrics(exports.map((e) => e.overall));
      console.log(JSON.stringify({ members: exports.map((e) => e.user), overall, persona: assignPersona(overall) }, null, 2));
    } else {
      console.log(renderTeamReport(exports, team));
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
    const events = loadEvents(db, { days, project: values.project, source: values.source });
    if (values.json) {
      console.log(buildSignedExportJson(db, days, values.db, { project: values.project, source: values.source }));
    } else {
      // Follow-through baselines only on unfiltered runs, so --project/--source
      // slices can't pollute them.
      const follow =
        !values.project && !values.source && events.length > 0
          ? syncFindings(db, computeMetrics(events))
          : undefined;
      console.log(renderReport(events, { days, follow }));
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
    if (values.llm) {
      const agent = values.agent ?? detectAgent();
      if (!agent) {
        console.error('No agent CLI found (looked for: claude, gemini, codex). Install one or pass --agent.');
        process.exit(1);
      }
      process.exit(runLlm(buildLlmPrompt(events, days), agent));
    }
  } else if (cmd === 'html') {
    const days = Number(values.days) || 30;
    const events = loadEvents(db, { days });
    const follow = events.length > 0 ? syncFindings(db, computeMetrics(events)) : undefined;
    writeFileSync(values.out, renderHtml(events, { days, follow }));
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
