import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DEFAULT_KEY_DIR } from './sign.js';

/**
 * Team rollout. A lead hosts one config file; each dev (or their MDM /
 * onboarding script / coding agent) runs:
 *
 *   npx github:ryandemelo/token-monitor init --from <url>
 *
 * init stores the config, generates the signing keypair, runs a first
 * collect, optionally installs the collection schedule, and prints the
 * fingerprint for keyring enrollment.
 */

export interface TeamDeployConfig {
  teamName: string;
  push: { type: 'http'; url: string } | { type: 'path'; dir: string };
  /** Install a recurring collect+push job every N hours (launchd/cron). */
  scheduleHours?: number;
  /** Export window passed to report; default 30. */
  windowDays?: number;
}

export function validateTeamConfig(data: unknown): TeamDeployConfig {
  const c = data as TeamDeployConfig;
  if (!c || typeof c !== 'object') throw new Error('team config must be a JSON object');
  if (!c.teamName || typeof c.teamName !== 'string') throw new Error('team config: "teamName" (string) required');
  const p = c.push as { type?: string; url?: string; dir?: string } | undefined;
  if (!p || (p.type !== 'http' && p.type !== 'path')) {
    throw new Error('team config: "push" must be {type:"http", url} or {type:"path", dir}');
  }
  if (p.type === 'http' && !p.url?.startsWith('https://') && !p.url?.startsWith('http://localhost')) {
    throw new Error('team config: push.url must be https (or http://localhost for testing)');
  }
  if (p.type === 'path' && !p.dir) throw new Error('team config: push.dir required');
  if (c.scheduleHours !== undefined && (typeof c.scheduleHours !== 'number' || c.scheduleHours < 1 || c.scheduleHours > 168)) {
    throw new Error('team config: scheduleHours must be 1-168');
  }
  if (c.windowDays !== undefined && (typeof c.windowDays !== 'number' || c.windowDays < 1)) {
    throw new Error('team config: windowDays must be >= 1');
  }
  return c;
}

export async function fetchTeamConfig(source: string): Promise<TeamDeployConfig> {
  let text: string;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetching team config: HTTP ${res.status} from ${source}`);
    text = await res.text();
  } else {
    text = readFileSync(source, 'utf8');
  }
  return validateTeamConfig(JSON.parse(text));
}

export function configPath(dir: string = DEFAULT_KEY_DIR): string {
  return join(dir, 'config.json');
}

export function saveConfig(config: TeamDeployConfig, dir: string = DEFAULT_KEY_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(dir), JSON.stringify(config, null, 2));
}

export function loadConfig(dir: string = DEFAULT_KEY_DIR): TeamDeployConfig {
  const p = configPath(dir);
  if (!existsSync(p)) {
    throw new Error(`no team config at ${p} — run \`token-monitor init --from <url>\` first`);
  }
  return validateTeamConfig(JSON.parse(readFileSync(p, 'utf8')));
}

export function exportFilename(user: string, date = new Date()): string {
  return `${user}-${date.toISOString().slice(0, 10)}.json`;
}

/** Deliver a signed export per config. Returns a human description of where it went. */
export async function pushExport(signedJson: string, config: TeamDeployConfig): Promise<string> {
  if (config.push.type === 'http') {
    const res = await fetch(config.push.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token-monitor-team': config.teamName },
      body: signedJson,
    });
    if (!res.ok) throw new Error(`push failed: HTTP ${res.status} from ${config.push.url}`);
    return `POSTed to ${config.push.url}`;
  }
  mkdirSync(config.push.dir, { recursive: true });
  const file = join(config.push.dir, exportFilename(userInfo().username));
  writeFileSync(file, signedJson);
  return `wrote ${file}`;
}

// ---------- scheduling ----------

const LAUNCHD_LABEL = 'com.token-monitor.collect';
const CRON_MARKER = '# token-monitor';

export function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function buildLaunchdPlist(nodePath: string, cliPath: string, hours: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${esc(`"${nodePath}" "${cliPath}" collect && "${nodePath}" "${cliPath}" push`)}</string>
  </array>
  <key>StartInterval</key><integer>${Math.round(hours * 3600)}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/tmp/token-monitor.err</string>
</dict>
</plist>
`;
}

export function buildCronLine(nodePath: string, cliPath: string, hours: number): string {
  const h = Math.max(1, Math.min(23, Math.round(hours)));
  return `0 */${h} * * * "${nodePath}" "${cliPath}" collect && "${nodePath}" "${cliPath}" push ${CRON_MARKER}`;
}

export function installSchedule(nodePath: string, cliPath: string, hours: number): string {
  if (platform() === 'darwin') {
    const plist = launchdPlistPath();
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, buildLaunchdPlist(nodePath, cliPath, hours));
    try {
      execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    } catch { /* not loaded yet */ }
    try {
      execFileSync('launchctl', ['load', plist], { stdio: 'ignore' });
      return `launchd agent installed (${plist}), every ${hours}h`;
    } catch {
      return `wrote ${plist} — load it with: launchctl load ${plist}`;
    }
  }
  if (platform() === 'linux') {
    let existing = '';
    try {
      existing = execFileSync('crontab', ['-l'], { encoding: 'utf8' });
    } catch { /* empty crontab */ }
    const kept = existing.split('\n').filter((l) => l.trim() && !l.includes(CRON_MARKER));
    kept.push(buildCronLine(nodePath, cliPath, hours));
    execFileSync('crontab', ['-'], { input: kept.join('\n') + '\n' });
    return `cron entry installed, every ${hours}h`;
  }
  throw new Error(`scheduling not supported on ${platform()} yet — run \`collect\` + \`push\` from your own scheduler`);
}

export function removeSchedule(): string {
  if (platform() === 'darwin') {
    const plist = launchdPlistPath();
    if (!existsSync(plist)) return 'no schedule installed';
    try {
      execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    } catch { /* fine */ }
    rmSync(plist);
    return 'launchd agent removed';
  }
  if (platform() === 'linux') {
    let existing = '';
    try {
      existing = execFileSync('crontab', ['-l'], { encoding: 'utf8' });
    } catch {
      return 'no schedule installed';
    }
    const kept = existing.split('\n').filter((l) => l.trim() && !l.includes(CRON_MARKER));
    execFileSync('crontab', ['-'], { input: kept.length ? kept.join('\n') + '\n' : '' });
    return 'cron entry removed';
  }
  return 'no schedule installed';
}
