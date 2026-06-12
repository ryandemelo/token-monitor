import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Thin bridge to the token-monitor CLI. Deliberately free of any `vscode`
 * imports so the extension's data path can be end-to-end tested with plain
 * `node --test` against the real CLI.
 */

/** Subset of the CLI's signed export (`report --json`) the extension reads. */
export interface ReportMetrics {
  events: number;
  sessions: number;
  spendTokens: number;
  costUsd: number;
  costEstimated: boolean;
  costUnpricedTokens: number;
  cacheHitRatio: number;
  reworkRatio: number;
}

export interface Report {
  days: number;
  overall: ReportMetrics;
  byProject: Record<string, ReportMetrics>;
}

const CLI_TIMEOUT_MS = 120_000;

/** Run the configured CLI with args. `command` is the user-configured prefix, e.g. "npx -y @ryandemelo/token-monitor". */
export function runCli(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const [bin, ...prefix] = command.split(/\s+/).filter(Boolean);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...prefix, ...args],
      {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: env ?? process.env,
        // npx/node resolution on Windows needs the shell; args are not
        // user-controlled beyond the machine-scoped command setting.
        shell: process.platform === 'win32',
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`token-monitor CLI failed: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

export function collect(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return runCli(command, ['collect'], env);
}

export async function fetchReport(command: string, days: number, env?: NodeJS.ProcessEnv): Promise<Report> {
  const out = await runCli(command, ['report', '--json', '--days', String(days)], env);
  const data = JSON.parse(out);
  if (data?.version !== 1 || !data.overall) throw new Error('unexpected report --json output');
  return data as Report;
}

/** Render the self-contained dashboard and return its HTML. */
export async function renderDashboard(command: string, days: number, env?: NodeJS.ProcessEnv): Promise<string> {
  const out = join(tmpdir(), `token-monitor-dashboard-${process.pid}-${Date.now()}.html`);
  try {
    await runCli(command, ['html', '--out', out, '--days', String(days)], env);
    return await readFile(out, 'utf8');
  } finally {
    rm(out, { force: true }).catch(() => {});
  }
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function formatCost(m: ReportMetrics): string {
  const approx = m.costEstimated ? '~' : '';
  const unpriced = m.costUnpricedTokens > 0 ? '+' : '';
  return `${approx}$${m.costUsd.toFixed(m.costUsd >= 100 ? 0 : 2)}${unpriced}`;
}

/** Status-bar line for a project (or overall when the project has no data). */
export function statusText(report: Report, project: string | undefined): string {
  const m = (project && report.byProject[project]) || report.overall;
  return `${formatTokens(m.spendTokens)} · ${formatCost(m)}`;
}
