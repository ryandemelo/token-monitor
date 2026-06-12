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
import type { ExportV1 } from './team.js';
import type { Source } from './types.js';

const HELP = `token-monitor — measure how effectively your team spends AI coding-agent tokens

Usage:
  token-monitor collect [--source <name>] [--db <path>]
  token-monitor report  [--days <n>] [--project <name>] [--source <name>] [--json] [--db <path>]
  token-monitor html    [--out report.html] [--days <n>] [--db <path>]
  token-monitor merge   <export.json>... [--team team.yaml] [--json]

Commands:
  collect   Scan local agent logs (Claude Code, Gemini CLI, Codex) into SQLite
  report    Activity breakdown, cost, personas, and recommendations
  html      Self-contained HTML dashboard (no server, no external assets)
  merge     Combine member exports (report --json > me.json) into a team report

Options:
  --source    one of: ${Object.keys(ADAPTERS).join(', ')} (default: all)
  --days      report window in days (default: 30)
  --project   filter to one project
  --json      machine-readable output (for team aggregation)
  --team      username -> discipline map, flat YAML or JSON
  --db        SQLite path (default: ${DEFAULT_DB})
`;

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      days: { type: 'string', default: '30' },
      project: { type: 'string' },
      json: { type: 'boolean', default: false },
      team: { type: 'string' },
      out: { type: 'string', default: 'report.html' },
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
    const exports: ExportV1[] = files.map((f) => {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      if (data.version !== 1 || !data.overall) {
        throw new Error(`${f} is not a token-monitor v1 export`);
      }
      return data as ExportV1;
    });
    const team = values.team ? parseTeamConfig(values.team) : {};
    if (values.json) {
      const overall = mergeMetrics(exports.map((e) => e.overall));
      console.log(JSON.stringify({ members: exports.map((e) => e.user), overall, persona: assignPersona(overall) }, null, 2));
    } else {
      console.log(renderTeamReport(exports, team));
    }
    return;
  }

  const db = openDb(values.db);

  if (cmd === 'collect') {
    const sources = values.source
      ? [values.source as Source]
      : (Object.keys(ADAPTERS) as Source[]);
    for (const source of sources) {
      const adapter = ADAPTERS[source];
      if (!adapter) {
        console.error(`Unknown source "${source}". Valid: ${Object.keys(ADAPTERS).join(', ')}`);
        process.exit(1);
      }
      const { events, result } = adapter();
      result.eventsInserted = insertEvents(db, events);
      const note = result.note ? `  (${result.note})` : '';
      console.log(
        `${source.padEnd(12)} ${String(result.filesScanned).padStart(5)} files  ` +
          `${String(result.eventsFound).padStart(7)} turns  ` +
          `${String(result.eventsInserted).padStart(7)} new${note}`,
      );
    }
    console.log(`\nStored in ${values.db ?? DEFAULT_DB}. Run \`token-monitor report\` next.`);
  } else if (cmd === 'report') {
    const days = Number(values.days) || 30;
    const events = loadEvents(db, { days, project: values.project, source: values.source });
    if (values.json) {
      const ex = buildExport(events, days);
      const persona = assignPersona(ex.overall);
      console.log(
        JSON.stringify(
          { ...ex, persona, recommendations: [...persona.recommendations, ...generalRecommendations(ex.overall)] },
          null,
          2,
        ),
      );
    } else {
      // Follow-through baselines only on unfiltered runs, so --project/--source
      // slices can't pollute them.
      const follow =
        !values.project && !values.source && events.length > 0
          ? syncFindings(db, computeMetrics(events))
          : undefined;
      console.log(renderReport(events, { days, follow }));
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

main();
