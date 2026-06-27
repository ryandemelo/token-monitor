import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterLabels } from '../src/cluster.js';
import type { ClusterItem } from '../src/cluster.js';

const item = (id: string, project: string, terms: string[]): ClusterItem => ({ id, project, terms });

test('similar fingerprints cluster; unrelated ones stay separate', () => {
  const items = [
    item('s1', 'proj-a', ['auth', 'jwt', 'login', 'api']),
    item('s2', 'proj-b', ['auth', 'jwt', 'token', 'api']), // paraphrase of s1
    item('s3', 'proj-c', ['css', 'layout', 'flexbox', 'style']),
  ];
  const clusters = clusterLabels(items, { threshold: 0.3 });
  assert.equal(clusters.length, 2);
  const merged = clusters.find((c) => c.items.length === 2)!;
  assert.deepEqual(merged.items.map((i) => i.id).sort(), ['s1', 's2']);
});

test('deterministic: same input yields identical ids, names, and order', () => {
  const items = [
    item('a', 'p', ['build', 'webpack', 'bundle']),
    item('b', 'q', ['build', 'webpack', 'config']),
    item('c', 'r', ['test', 'jest', 'mock']),
  ];
  const r1 = clusterLabels(items, { threshold: 0.3 });
  const r2 = clusterLabels(items, { threshold: 0.3 });
  assert.deepEqual(r1.map((c) => c.id), r2.map((c) => c.id));
  assert.deepEqual(r1.map((c) => c.name), r2.map((c) => c.name));
});

test('max-size guard caps single-link chaining', () => {
  const items = Array.from({ length: 6 }, (_, i) => item('s' + i, 'p' + i, ['deploy', 'k8s', 'helm']));
  const clusters = clusterLabels(items, { threshold: 0.3, maxSize: 2 });
  for (const c of clusters) assert.ok(c.items.length <= 2, 'cluster exceeded maxSize guard');
});

test('threshold gates linkage: weak overlap links loose, splits strict', () => {
  const items = [
    item('s1', 'a', ['auth', 'api', 'rate', 'limit']),
    item('s2', 'b', ['auth', 'docs', 'readme', 'changelog']), // shares only "auth"
  ];
  assert.equal(clusterLabels(items, { threshold: 0.9 }).length, 2, 'too dissimilar to link at 0.9');
  assert.ok(
    clusterLabels(items, { threshold: 0.1 }).some((c) => c.items.length === 2),
    'should link at 0.1',
  );
});

test('returned cluster order is total: independent of input order', () => {
  // 6 identical fingerprints at maxSize 2 split into 3 same-name same-size
  // clusters; the array order must not flip when the input is reversed.
  const fwd = Array.from({ length: 6 }, (_, i) => item('s' + i, 'p' + i, ['deploy', 'k8s', 'helm']));
  const rev = [...fwd].reverse();
  const a = clusterLabels(fwd, { threshold: 0.3, maxSize: 2 }).map((c) => c.id);
  const b = clusterLabels(rev, { threshold: 0.3, maxSize: 2 }).map((c) => c.id);
  assert.deepEqual(a, b);
});

test('multi-member cluster name prefers shared terms over a rare one-off token', () => {
  // A rare survived token (e.g. a codename) in one member must NOT become the
  // cluster name — shared terms lead.
  const items = [
    item('s1', 'a', ['auth', 'login', 'voldemort']),
    item('s2', 'b', ['auth', 'login', 'session']),
  ];
  const [c] = clusterLabels(items, { threshold: 0.3 });
  assert.equal(c.items.length, 2);
  assert.ok(!c.name.split(' ').slice(0, 2).includes('voldemort'), `rare token led the name: "${c.name}"`);
  assert.ok(c.name.startsWith('auth') || c.name.startsWith('login'));
});

test('cluster name is the aggregate top term', () => {
  const items = [
    item('s1', 'a', ['auth', 'auth', 'jwt']),
    item('s2', 'b', ['auth', 'login']),
  ];
  const [c] = clusterLabels(items, { threshold: 0.1 });
  assert.equal(c.items.length, 2);
  assert.ok(c.name.startsWith('auth'), `expected auth-led name, got "${c.name}"`);
});
