import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeMetrics } from '../src/metrics.js';
import { mergeMetrics, parseTeamConfig, rollupExports, dominantActivity, identityOf, displayName, dedupeExports } from '../src/team.js';
import type { ExportV1, SignedExport } from '../src/team.js';
import { signObject, fingerprint } from '../src/sign.js';
import { makeStored } from './helpers.js';

function metricsOf(...specs: Array<Parameters<typeof makeStored>[0]>) {
  return computeMetrics(specs.map((s) => makeStored(s)));
}

test('mergeMetrics sums absolutes and recomputes ratios', () => {
  const a = metricsOf({ session_id: 'a', activity: 'coding', input_tokens: 100, output_tokens: 100, cache_read_tokens: 800 });
  const b = metricsOf({ session_id: 'b', activity: 'exploration', input_tokens: 100, output_tokens: 100 });
  const m = mergeMetrics([a, b]);

  assert.equal(m.events, 2);
  assert.equal(m.sessions, 2);
  assert.equal(m.spendTokens, 400);
  assert.ok(Math.abs(m.byActivity.coding.share - 0.5) < 1e-9);
  // 800 / (800 + 200 input + 0 creation)
  assert.ok(Math.abs(m.cacheHitRatio - 0.8) < 1e-9);
  // costs add: opus pricing on both
  assert.ok(Math.abs(m.costUsd - (a.costUsd + b.costUsd)) < 1e-9);
});

test('merging an export with itself doubles absolutes, keeps ratios', () => {
  const a = metricsOf(
    { ts: '2026-06-01T00:00:01Z', activity: 'coding', is_error: 1, input_tokens: 1000, output_tokens: 0 },
    { ts: '2026-06-01T00:00:02Z', activity: 'coding', input_tokens: 500, output_tokens: 0 },
  );
  const m = mergeMetrics([a, a]);
  assert.equal(m.spendTokens, 2 * a.spendTokens);
  assert.ok(Math.abs(m.reworkRatio - a.reworkRatio) < 1e-9);
});

test('parseTeamConfig reads flat YAML and JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-'));
  const yamlPath = join(dir, 'team.yaml');
  writeFileSync(yamlPath, '# disciplines\nalice: frontend\nbob: backend\n"carol.x": data science\n');
  assert.deepEqual(parseTeamConfig(yamlPath), {
    alice: { discipline: 'frontend' },
    bob: { discipline: 'backend' },
    'carol.x': { discipline: 'data science' },
  });

  const jsonPath = join(dir, 'team.json');
  writeFileSync(jsonPath, '{"dave": "qa"}');
  assert.deepEqual(parseTeamConfig(jsonPath), { dave: { discipline: 'qa' } });
});

test('parseTeamConfig reads two-level teams.yaml and nested JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-'));
  const yamlPath = join(dir, 'teams.yaml');
  writeFileSync(
    yamlPath,
    [
      '# org map',
      'platform:',
      '  alice: frontend',
      '  bob: backend   # comment',
      'data:',
      '  carol: ml',
      'dave: qa  # flat entry mixed in',
      '',
    ].join('\n'),
  );
  assert.deepEqual(parseTeamConfig(yamlPath), {
    alice: { team: 'platform', discipline: 'frontend' },
    bob: { team: 'platform', discipline: 'backend' },
    carol: { team: 'data', discipline: 'ml' },
    dave: { discipline: 'qa' },
  });

  const jsonPath = join(dir, 'teams.json');
  writeFileSync(jsonPath, '{"platform": {"alice": "frontend"}, "dave": "qa"}');
  assert.deepEqual(parseTeamConfig(jsonPath), {
    alice: { team: 'platform', discipline: 'frontend' },
    dave: { discipline: 'qa' },
  });
});

function mkExport(user: string, m: ReturnType<typeof metricsOf>, generatedAt = 'now'): ExportV1 {
  return { version: 1, user, host: 'h', generatedAt, days: 30, overall: m, byProject: {} };
}

test('rollupExports groups by discipline and by team', () => {
  const exports = [
    mkExport('alice', metricsOf({ activity: 'coding', input_tokens: 5000, output_tokens: 0 })),
    mkExport('bob', metricsOf({ activity: 'testing', input_tokens: 1000, output_tokens: 0 })),
    mkExport('carol', metricsOf({ activity: 'exploration', input_tokens: 100, output_tokens: 0 })),
  ];
  const config = {
    alice: { team: 'platform', discipline: 'frontend' },
    bob: { team: 'platform', discipline: 'frontend' },
  };

  const byDiscipline = rollupExports(exports, config, 'discipline');
  assert.equal(byDiscipline.length, 2);
  assert.equal(byDiscipline[0].group, 'frontend'); // sorted by spend
  assert.deepEqual(byDiscipline[0].users, ['alice', 'bob']);
  assert.equal(byDiscipline[0].metrics.spendTokens, 6000);
  assert.equal(byDiscipline[1].group, 'unassigned');
  assert.equal(dominantActivity(byDiscipline[0].metrics), 'coding');

  const byTeam = rollupExports(exports, config, 'team');
  assert.equal(byTeam[0].group, 'platform');
  assert.equal(byTeam[0].metrics.spendTokens, 6000);
  assert.equal(byTeam[1].group, 'unassigned');
});

test('identity comes from the signing fingerprint; keyring resolves display names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-keys-'));
  const m = metricsOf({ activity: 'coding' });
  const signed = signObject(mkExport('ryan', m), dir);
  const fp = fingerprint(signed.sig.publicKey);

  assert.equal(identityOf(signed), fp);
  assert.equal(identityOf(mkExport('ryan', m)), 'ryan@h'); // unsigned fallback

  // keyring is the lead's source of truth: reverse fingerprint match wins
  assert.equal(displayName(signed, { 'ryan-platform': fp }), 'ryan-platform');
  assert.equal(displayName(signed, { other: 'deadbeef00000000' }), 'ryan');
  assert.equal(displayName(signed), 'ryan');
});

test('dedupeExports keeps only the newest export per identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-dedup-'));
  const m = metricsOf({ activity: 'coding' });
  const old: SignedExport = signObject(mkExport('ryan', m, '2026-06-01T00:00:00Z'), dir);
  const fresh: SignedExport = signObject(mkExport('ryan', m, '2026-06-02T00:00:00Z'), dir);
  const otherDir = mkdtempSync(join(tmpdir(), 'tm-dedup2-'));
  const otherMachine: SignedExport = signObject(mkExport('ryan', m, '2026-05-01T00:00:00Z'), otherDir);

  const { kept, dropped } = dedupeExports([old, fresh, otherMachine]);
  // same key twice -> newest wins; a different machine's key is a distinct identity
  assert.equal(kept.length, 2);
  assert.ok(kept.includes(fresh) && kept.includes(otherMachine));
  assert.deepEqual(dropped, [old]);

  // unsigned exports fall back to user@host identity
  const u1 = mkExport('alice', m, '2026-06-01T00:00:00Z');
  const u2 = mkExport('alice', m, '2026-06-03T00:00:00Z');
  const r = dedupeExports([u2, u1]);
  assert.deepEqual(r.kept, [u2]);
  assert.deepEqual(r.dropped, [u1]);
});
