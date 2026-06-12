import * as vscode from 'vscode';
import { basename } from 'node:path';
import { collect, fetchReport, renderDashboard, statusText, formatTokens, formatCost, type Report } from './bridge';

let statusBar: vscode.StatusBarItem;
let timer: ReturnType<typeof setInterval> | undefined;
let lastReport: Report | undefined;

function config() {
  const c = vscode.workspace.getConfiguration('tokenMonitor');
  return {
    command: c.get<string>('command', 'npx -y @ryandemelo/token-monitor'),
    days: c.get<number>('days', 30),
    autoCollect: c.get<boolean>('autoCollect', true),
    refreshMinutes: Math.max(1, c.get<number>('refreshMinutes', 15)),
  };
}

function currentProject(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? basename(folder.uri.fsPath) : undefined;
}

async function refresh(runCollect: boolean): Promise<void> {
  const { command, days, autoCollect } = config();
  statusBar.text = '$(sync~spin) tokens';
  try {
    if (runCollect && autoCollect) await collect(command);
    lastReport = await fetchReport(command, days);
    const project = currentProject();
    statusBar.text = `$(graph) ${statusText(lastReport, project)}`;
    statusBar.tooltip = buildTooltip(lastReport, project, days);
    statusBar.backgroundColor = undefined;
  } catch (err) {
    statusBar.text = '$(warning) tokens';
    statusBar.tooltip = `token-monitor: ${err instanceof Error ? err.message : String(err)}\n\nCheck the "tokenMonitor.command" setting.`;
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

function buildTooltip(report: Report, project: string | undefined, days: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Token Monitor** — last ${days} days\n\n`);
  const rows: Array<[string, typeof report.overall]> = [];
  if (project && report.byProject[project]) rows.push([project, report.byProject[project]]);
  rows.push(['overall', report.overall]);
  for (const [name, m] of rows) {
    md.appendMarkdown(
      `**${name}**: ${formatTokens(m.spendTokens)} tokens · ${formatCost(m)} · ` +
        `cache ${(m.cacheHitRatio * 100).toFixed(0)}% · rework ${(m.reworkRatio * 100).toFixed(0)}%\n\n`,
    );
  }
  md.appendMarkdown('_Click to open the dashboard._');
  return md;
}

async function openDashboard(context: vscode.ExtensionContext): Promise<void> {
  const { command, days, autoCollect } = config();
  const panel = vscode.window.createWebviewPanel(
    'tokenMonitorDashboard',
    'Token Monitor',
    vscode.ViewColumn.One,
    { enableScripts: true },
  );
  panel.webview.html = '<html><body style="font-family: sans-serif; padding: 2em">Rendering dashboard…</body></html>';
  context.subscriptions.push(panel);
  try {
    if (autoCollect) await collect(command);
    panel.webview.html = await renderDashboard(command, days);
  } catch (err) {
    panel.webview.html = `<html><body style="font-family: sans-serif; padding: 2em"><h3>token-monitor failed</h3><pre>${
      String(err instanceof Error ? err.message : err).replace(/</g, '&lt;')
    }</pre><p>Check the <code>tokenMonitor.command</code> setting.</p></body></html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'Token Monitor';
  statusBar.command = 'tokenMonitor.openDashboard';
  statusBar.text = '$(graph) tokens';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenMonitor.openDashboard', () => openDashboard(context)),
    vscode.commands.registerCommand('tokenMonitor.refresh', () => refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tokenMonitor')) restartTimer();
    }),
  );

  restartTimer();
  void refresh(true);
}

function restartTimer(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void refresh(true), config().refreshMinutes * 60_000);
}

export function deactivate(): void {
  if (timer) clearInterval(timer);
}
