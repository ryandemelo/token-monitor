import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import {
  validateTeamConfig,
  fetchTeamConfig,
  saveConfig,
  loadConfig,
  pushExport,
  exportFilename,
  buildLaunchdPlist,
  buildCronLine,
} from '../src/deploy.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'tm-deploy-'));

test('validateTeamConfig accepts valid configs and rejects broken ones', () => {
  const ok = validateTeamConfig({ teamName: 't', push: { type: 'path', dir: '/x' }, scheduleHours: 12 });
  assert.equal(ok.teamName, 't');
  assert.throws(() => validateTeamConfig({}), /teamName/);
  assert.throws(() => validateTeamConfig({ teamName: 't' }), /push/);
  assert.throws(() => validateTeamConfig({ teamName: 't', push: { type: 'http', url: 'http://evil.com/x' } }), /https/);
  assert.throws(() => validateTeamConfig({ teamName: 't', push: { type: 'path', dir: '/x' }, scheduleHours: 0 }), /scheduleHours/);
});

test('fetchTeamConfig reads local paths; save/load roundtrip', async () => {
  const dir = tmp();
  const cfgFile = join(dir, 'team.json');
  writeFileSync(cfgFile, JSON.stringify({ teamName: 'acme', push: { type: 'path', dir: join(dir, 'drop') } }));
  const cfg = await fetchTeamConfig(cfgFile);
  assert.equal(cfg.teamName, 'acme');

  saveConfig(cfg, dir);
  assert.deepEqual(loadConfig(dir), cfg);
  assert.throws(() => loadConfig(tmp()), /run `token-monitor init/);
});

test('pushExport path destination writes a per-user dated file', async () => {
  const dir = tmp();
  const cfg = validateTeamConfig({ teamName: 'acme', push: { type: 'path', dir: join(dir, 'drop') } });
  const where = await pushExport('{"hello":1}', cfg);
  assert.match(where, /wrote /);
  const files = readdirSync(join(dir, 'drop'));
  assert.equal(files.length, 1);
  assert.equal(files[0], exportFilename(userInfo().username));
  assert.equal(readFileSync(join(dir, 'drop', files[0]), 'utf8'), '{"hello":1}');
});

test('launchd plist embeds node, cli and interval; xml-escapes', () => {
  const plist = buildLaunchdPlist('/usr/local/bin/node', '/a&b/cli.js', 6);
  assert.ok(plist.includes('<integer>21600</integer>'));
  assert.ok(plist.includes('com.token-monitor.collect'));
  assert.ok(plist.includes('&amp;'));
  assert.ok(!plist.includes('/a&b/')); // raw ampersand must not survive
  assert.ok(plist.includes('collect') && plist.includes('push'));
});

test('cron line clamps interval and carries the removal marker', () => {
  const line = buildCronLine('/usr/bin/node', '/cli.js', 6);
  assert.match(line, /^0 \*\/6 \* \* \* /);
  assert.ok(line.endsWith('# token-monitor'));
  assert.match(buildCronLine('/n', '/c', 100), /\*\/23/); // clamped to cron-expressible
});
