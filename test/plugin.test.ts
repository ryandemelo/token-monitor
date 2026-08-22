import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The Claude Code plugin is markdown and JSON wrapped around the CLI, so the
 * things that can break it are: a manifest that stops parsing, a version that
 * drifts from the package, a command that tells an agent to run a subcommand
 * that no longer exists, and a session hook that says something when it was
 * never turned on.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'src', 'cli.js');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const readJson = (...p: string[]) => JSON.parse(read(...p));

test('plugin manifests parse and stay pinned to the package version', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin', 'plugin.json');
  const marketplace = readJson('.claude-plugin', 'marketplace.json');

  assert.equal(plugin.name, 'token-monitor');
  assert.equal(plugin.version, pkg.version, 'plugin.json version must track package.json');
  assert.ok(plugin.description.length > 20);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, './');
});

test('every plugin command references CLI subcommands that actually exist', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
  const known = new Set(
    [...help.matchAll(/^\s{2}token-monitor (\w+)/gm)].map((m) => m[1]),
  );
  assert.ok(known.size > 5, 'could not parse the CLI help output');

  const dir = join(ROOT, 'commands');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const body = readFileSync(join(dir, file), 'utf8');
    assert.match(body, /^---\ndescription: /, `${file} needs frontmatter with a description`);
    // Only actual invocations (backticked, npx-prefixed or not) — prose like
    // "run token-monitor over your logs" is not a command reference.
    for (const [, cmd] of body.matchAll(/`(?:npx -y @ryandemelo\/)?token-monitor ([a-z-]+)/g)) {
      assert.ok(known.has(cmd), `${file} tells the agent to run unknown command "${cmd}"`);
    }
  }
});

test('the skill declares itself and states the local-only rule for names', () => {
  const skill = read('skills', 'token-monitor', 'SKILL.md');
  assert.match(skill, /^---\nname: token-monitor\n/);
  assert.match(skill, /description: >/);
  // The one rule an agent must not lose: names shown locally stay local.
  assert.match(skill, /never leave/i);
});

test('the session hook is silent until it is turned on, and never runs collect', () => {
  const script = join(ROOT, 'hooks', 'session-hint.sh');
  // Comments explain what the hook refuses to do; the code must not do it.
  const code = readFileSync(script, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.ok(!code.includes('collect'), 'the hook must never scan logs at session start');
  assert.ok(!code.includes('npx'), 'the hook must never reach the network');

  // A HOME with no database and no opt-in: exit 0, say nothing.
  const home = mkdtempSync(join(tmpdir(), 'tm-hook-'));
  const off = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), '');

  // Opted in, but still nothing collected: still silent, still exit 0.
  const on = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TOKEN_MONITOR_SESSION_HINT: '1' },
  });
  assert.equal(on.status, 0);
  assert.equal(on.stdout.trim(), '');

  assert.match(readJson('hooks', 'hooks.json').hooks.SessionStart[0].hooks[0].command, /session-hint\.sh/);
});
