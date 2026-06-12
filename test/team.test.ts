import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeMetrics } from '../src/metrics.js';
import { mergeMetrics, parseTeamConfig, rollupByDiscipline, dominantActivity } from '../src/team.js';
import type { ExportV1 } from '../src/team.js';
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
    alice: 'frontend',
    bob: 'backend',
    'carol.x': 'data science',
  });

  const jsonPath = join(dir, 'team.json');
  writeFileSync(jsonPath, '{"dave": "qa"}');
  assert.deepEqual(parseTeamConfig(jsonPath), { dave: 'qa' });
});

test('rollupByDiscipline groups exports and merges metrics', () => {
  const mk = (user: string, m: ReturnType<typeof metricsOf>): ExportV1 => ({
    version: 1, user, host: 'h', generatedAt: 'now', days: 30, overall: m, byProject: {},
  });
  const rollups = rollupByDiscipline(
    [
      mk('alice', metricsOf({ activity: 'coding', input_tokens: 5000, output_tokens: 0 })),
      mk('bob', metricsOf({ activity: 'testing', input_tokens: 1000, output_tokens: 0 })),
      mk('carol', metricsOf({ activity: 'exploration', input_tokens: 100, output_tokens: 0 })),
    ],
    { alice: 'frontend', bob: 'frontend' },
  );
  assert.equal(rollups.length, 2);
  assert.equal(rollups[0].discipline, 'frontend'); // sorted by spend
  assert.deepEqual(rollups[0].users, ['alice', 'bob']);
  assert.equal(rollups[0].metrics.spendTokens, 6000);
  assert.equal(rollups[1].discipline, 'unassigned');
  assert.equal(dominantActivity(rollups[0].metrics), 'coding');
});
