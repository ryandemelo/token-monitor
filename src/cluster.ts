/**
 * Zero-dep lexical clustering of session intents.
 *
 * Groups sessions by what they were about, from their ≤8-term fingerprints
 * only (never raw text). Mechanism: IDF-weighted TF-IDF vectors, an inverted
 * index to find candidate neighbours cheaply, cosine similarity, and union-find
 * to merge. Two guards keep single-link chaining from fusing unrelated work:
 * a similarity threshold and a hard max-cluster-size cap (a wrong "duplicate
 * work" accusation costs more trust than a missed one). Fully deterministic —
 * no Math.random, no Date, stable tie-breaks — so output is golden-testable.
 *
 * The engine is hidden behind clusterLabels(); swap it (e.g. for Jaccard) in
 * this one file without touching callers.
 */
import { fnv1a } from './intent.js';

export interface ClusterItem {
  id: string;
  project: string;
  /** The session's redacted fingerprint terms. */
  terms: string[];
}

export interface Cluster {
  /** Stable for a given membership set (FNV of sorted member ids). */
  id: string;
  name: string;
  items: ClusterItem[];
  /** Aggregate top terms across members. */
  terms: string[];
}

export interface ClusterOpts {
  /**
   * Cosine threshold to link two sessions. Default 0.4: fingerprints are capped
   * at 8 tokens, so even strong paraphrases (≥4 shared salient terms among a few
   * noise words) land around 0.45-0.60, while coincidental 1-2 term overlaps sit
   * near 0.15-0.30 — 0.4 separates them. Zero-overlap pairs score 0 regardless.
   */
  threshold?: number;
  /** Hard cap on a cluster's size — chaining guard (default 50). */
  maxSize?: number;
}

function dot(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) {
    const w2 = large.get(t);
    if (w2) s += w * w2;
  }
  return s;
}

/**
 * Aggregate top terms for a cluster's NAME. Ranked first by how many members
 * contain the term (so the SHARED topic leads), then by summed TF-IDF, then
 * alpha. This deliberately demotes rare one-off tokens — a codename or secret
 * that survived redaction in a single member won't become the public label of a
 * multi-session cluster (the export surface). Singletons are unavoidably named
 * from their own terms.
 */
function topTerms(items: ClusterItem[], idf: (t: string) => number): string[] {
  const memberDf = new Map<string, number>();
  const weight = new Map<string, number>();
  for (const it of items) {
    const tf = new Map<string, number>();
    for (const t of it.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, f] of tf) {
      memberDf.set(t, (memberDf.get(t) ?? 0) + 1);
      weight.set(t, (weight.get(t) ?? 0) + f * idf(t));
    }
  }
  return [...weight.keys()].sort(
    (a, b) =>
      (memberDf.get(b)! - memberDf.get(a)!) ||
      (weight.get(b)! - weight.get(a)!) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
}

export function clusterLabels(items: ClusterItem[], opts: ClusterOpts = {}): Cluster[] {
  const tau = opts.threshold ?? 0.4;
  const maxSize = opts.maxSize ?? 50;
  const n = items.length;

  // Document frequency -> IDF (smoothed). Rare terms weigh more.
  const df = new Map<string, number>();
  for (const it of items) for (const t of new Set(it.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  // L2-normalized TF-IDF vectors, so dot product == cosine.
  const vecs = items.map((it) => {
    const tf = new Map<string, number>();
    for (const t of it.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    let norm2 = 0;
    for (const [t, f] of tf) {
      const w = f * idf(t);
      v.set(t, w);
      norm2 += w * w;
    }
    const len = Math.sqrt(norm2) || 1;
    for (const [t, w] of v) v.set(t, w / len);
    return v;
  });

  // Inverted index: term -> item indices, to skip non-overlapping pairs.
  const inv = new Map<string, number[]>();
  items.forEach((it, i) => {
    for (const t of new Set(it.terms)) {
      let arr = inv.get(t);
      if (!arr) inv.set(t, (arr = []));
      arr.push(i);
    }
  });

  // Union-find with size-capped merges.
  const parent = Array.from({ length: n }, (_, i) => i);
  const sizeOf = new Map<number, number>();
  const size = (r: number) => sizeOf.get(r) ?? 1;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (size(ra) + size(rb) > maxSize) return; // chaining guard
    const [big, small] = size(ra) >= size(rb) ? [ra, rb] : [rb, ra];
    parent[small] = big;
    sizeOf.set(big, size(big) + size(small));
  };

  // Candidate pairs via shared terms, scored, merged highest-similarity first.
  const pairs: Array<{ i: number; j: number; s: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const cand = new Set<number>();
    for (const t of new Set(items[i].terms)) {
      for (const j of inv.get(t) ?? []) if (j > i) cand.add(j);
    }
    for (const j of cand) {
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!sameIntentGate(items[i], items[j])) continue;
      const s = dot(vecs[i], vecs[j]);
      if (s >= tau) pairs.push({ i, j, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  for (const p of pairs) union(p.i, p.j);

  // Gather clusters.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let arr = groups.get(r);
    if (!arr) groups.set(r, (arr = []));
    arr.push(i);
  }
  const clusters: Cluster[] = [];
  for (const idxs of groups.values()) {
    const members = idxs.map((i) => items[i]);
    const terms = topTerms(members, idf);
    const id = fnv1a(members.map((m) => m.id).sort().join('|'));
    clusters.push({ id, name: terms.slice(0, 3).join(' ') || 'misc', items: members, terms });
  }
  // Biggest clusters first; name then content-hash id as a TOTAL tie-break, so
  // the returned order never depends on input/scan order (equal-size, equal-name
  // clusters are reachable when identical fingerprints split at maxSize).
  clusters.sort(
    (a, b) =>
      b.items.length - a.items.length ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return clusters;
}

/**
 * Coarse gate: two sessions may only link if they share at least one term.
 * Candidate pairs already share a term via the inverted index, so this is a
 * cheap belt-and-suspenders guard and the hook for a future taxonomy gate.
 */
function sameIntentGate(a: ClusterItem, b: ClusterItem): boolean {
  return a.terms.some((t) => b.terms.includes(t));
}
