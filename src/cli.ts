#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ADAPTERS } from './adapters/index.js';
import { openDb, insertEvents, loadEvents, DEFAULT_DB } from './store.js';
import { renderReport } from './report.js';
import { computeMetrics } from './metrics.js';
import { assignPersona, generalRecommendations } from './personas.js';
import type { Source } from './types.js';

const HELP = `token-monitor — measure how effectively your team spends AI coding-agent tokens

Usage:
  token-monitor collect [--source <name>] [--db <path>]
  token-monitor report  [--days <n>] [--project <name>] [--source <name>] [--json] [--db <path>]

Commands:
  collect   Scan local agent logs (Claude Code, Gemini CLI, Codex) into SQLite
  report    Activity breakdown, cost, personas, and recommendations

Options:
  --source    one of: ${Object.keys(ADAPTERS).join(', ')} (default: all)
  --days      report window in days (default: 30)
  --project   filter to one project
  --json      machine-readable output (for team aggregation)
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
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
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
      const m = computeMetrics(events);
      const persona = assignPersona(m);
      console.log(
        JSON.stringify(
          { generatedAt: new Date().toISOString(), days, metrics: m, persona, recommendations: [...persona.recommendations, ...generalRecommendations(m)] },
          null,
          2,
        ),
      );
    } else {
      console.log(renderReport(events, { days }));
    }
  } else {
    console.error(`Unknown command "${cmd}"\n`);
    console.log(HELP);
    process.exit(1);
  }
}

main();
