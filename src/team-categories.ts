/**
 * Cross-user task clustering for `merge` — the org-level face of categorize.
 *
 * Each member export carries its categorize clusters as aggregate-only
 * ExportCategory rows (≤8 redacted keyword terms, counts, $). Here those rows
 * are re-clustered ACROSS members with the same zero-dep engine sessions use
 * (cluster.ts): a cluster containing categories from ≥2 distinct identities
 * is the same task being done independently by different people — the
 * redundant-work signal `categorize` can only hint at on one machine.
 *
 * Identity is identityOf() (signing-key fingerprint; `user@host` unsigned) so
 * one person's stale double-push can't read as two people — dedupeExports
 * runs before this. Unsigned exports are flagged instead of trusted: two
 * unsigned hosts MAY be one human, and a lead must see that caveat before
 * acting on a "duplicate work" accusation.
 */
import { clusterLabels } from './cluster.js';
import type { ClusterItem } from './cluster.js';
import { displayName, identityOf } from './team.js';
import type { ExportCategory, SignedExport } from './team.js';

export interface OrgCategory {
  id: string;
  name: string;
  terms: string[];
  /** Sorted member display names; unsigned contributors marked `(unsigned)`. */
  users: string[];
  /** Distinct identityOf() values — the cross-user threshold. */
  userCount: number;
  sessions: number;
  projects: string[];
  tokens: number;
  cost: number;
  estimated: boolean;
  /** Same task appears for ≥2 distinct identities. */
  crossUser: boolean;
  /**
   * Org-skill rank: sessions × userCount. Pairwise similarity is deliberately
   * NOT in the score — clusterLabels doesn't expose cosines, and the
   * threshold already gates match quality; threading them out would change a
   * shared API for jittery rank value.
   */
  score: number;
}

export interface MergedCategories {
  categories: OrgCategory[];
  crossUserDuplicates: OrgCategory[];
  orgSkillCandidates: OrgCategory[];
  /** Exports that actually carried categories — the coverage line. */
  withCategories: number;
  /** Aggregate of members' own carried duplicate flags (within-member tier). */
  withinMemberDupCost: number;
  withinMemberDupMembers: number;
  anyUnsigned: boolean;
}

interface MemberCategory {
  identity: string;
  name: string;
  unsigned: boolean;
  cat: ExportCategory;
}

/** Defense-in-depth: hand-built exports must never crash a merge. */
function usable(cat: ExportCategory | undefined): cat is ExportCategory {
  return (
    !!cat &&
    typeof cat.id === 'string' &&
    Array.isArray(cat.terms) &&
    cat.terms.length > 0 &&
    cat.terms.every((t) => typeof t === 'string' && t.length > 0)
  );
}

export function mergeCategories(
  exports: SignedExport[],
  opts: { threshold?: number; minCluster?: number; keyring?: Record<string, string> } = {},
): MergedCategories {
  const minCluster = Math.max(2, opts.minCluster ?? 2);

  const members: MemberCategory[] = [];
  let withCategories = 0;
  let withinMemberDupCost = 0;
  let withinMemberDupMembers = 0;
  let anyUnsigned = false;
  for (const ex of exports) {
    const cats = (ex.categories ?? []).filter(usable);
    if (cats.length === 0) continue; // pre-0.11 exports: metrics only
    withCategories++;
    const unsigned = !ex.sig?.publicKey;
    if (unsigned) anyUnsigned = true;
    const dupCost = cats.filter((c) => c.duplicate).reduce((s, c) => s + c.cost, 0);
    if (dupCost > 0) {
      withinMemberDupCost += dupCost;
      withinMemberDupMembers++;
    }
    for (const cat of cats) {
      members.push({ identity: identityOf(ex), name: displayName(ex, opts.keyring), unsigned, cat });
    }
  }

  // Identity rides the inert `project` slot so clusterLabels needs zero
  // changes; items sorted so output never depends on file argument order.
  members.sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.cat.id < b.cat.id ? -1 : 1,
  );
  const byItemId = new Map<string, MemberCategory>();
  const items: ClusterItem[] = members.map((m) => {
    const id = `${m.identity}:${m.cat.id}`;
    byItemId.set(id, m);
    return { id, project: m.identity, terms: m.cat.terms };
  });
  // Same default threshold and rationale as sessions — export terms live in
  // the same ≤8-token regime the 0.4 default was tuned for.
  const clusters = clusterLabels(items, { threshold: opts.threshold ?? 0.4 });

  const categories: OrgCategory[] = clusters.map((c) => {
    const mem = c.items.map((it) => byItemId.get(it.id)!).filter(Boolean);
    const identities = new Set(mem.map((m) => m.identity));
    const users = [...new Set(mem.map((m) => (m.unsigned ? `${m.name} (unsigned)` : m.name)))].sort();
    const sessions = mem.reduce((s, m) => s + m.cat.sessions, 0);
    const userCount = identities.size;
    return {
      id: c.id,
      name: c.name,
      terms: c.terms.slice(0, 8),
      users,
      userCount,
      sessions,
      projects: [...new Set(mem.flatMap((m) => m.cat.projects ?? []))].sort(),
      tokens: mem.reduce((s, m) => s + m.cat.tokens, 0),
      cost: mem.reduce((s, m) => s + m.cat.cost, 0),
      estimated: mem.some((m) => m.cat.estimated),
      crossUser: userCount >= 2,
      score: sessions * userCount,
    };
  });
  // Total order (score, cost, name, id) so equal-score clusters can't swap
  // between runs — merge output is golden-testable.
  categories.sort(
    (a, b) =>
      b.score - a.score ||
      b.cost - a.cost ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return {
    categories,
    crossUserDuplicates: categories.filter((c) => c.crossUser),
    orgSkillCandidates: categories.filter((c) => c.crossUser || c.sessions >= minCluster),
    withCategories,
    withinMemberDupCost,
    withinMemberDupMembers,
    anyUnsigned,
  };
}
