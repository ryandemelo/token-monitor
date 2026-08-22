import type { Rule } from './types.js';
import { groupBy } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

/** Same median estimator metrics.ts uses for session floors. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Minimum overlap (ms) for two sessions to count as concurrent, not a restart. */
const MIN_OVERLAP_MS = 5 * 60_000;

interface ThrashGroup {
  project: string;
  /** Sessions in the overlapping cluster. */
  sessions: number;
  /** Extra floor tokens: one median session floor per session beyond the first. */
  extraFloorTokens: number;
}

/**
 * Main-loop sessions in the same project whose [first, last] intervals overlap
 * by more than MIN_OVERLAP_MS: parallel windows, each paying its own context
 * floor. Subagent runs are excluded upstream — they are the sanctioned version
 * of parallelism. Clusters are built greedily in start order; every session
 * past the first adds one median session floor.
 */
export function thrashedProjects(events: import('../store.js').StoredEvent[], sessionFloorTokens: number): ThrashGroup[] {
  if (sessionFloorTokens <= 0) return [];
  const main = events.filter((e) => e.is_sidechain !== 1);
  const byProject = groupBy(main, 'project');
  const out: ThrashGroup[] = [];
  for (const [project, evs] of byProject) {
    const bySession = new Map<string, { start: number; end: number }>();
    for (const e of evs) {
      const t = Date.parse(e.ts);
      const cur = bySession.get(e.session_id);
      if (!cur) bySession.set(e.session_id, { start: t, end: t });
      else {
        if (t < cur.start) cur.start = t;
        if (t > cur.end) cur.end = t;
      }
    }
    const ivs = [...bySession.values()].sort((a, b) => a.start - b.start);
    let clusterEnd = -Infinity;
    let clusterSize = 0;
    let extra = 0;
    let open = false;
    const flush = () => {
      if (open && clusterSize > 1) {
        out.push({ project, sessions: clusterSize, extraFloorTokens: extra * sessionFloorTokens });
      }
      open = false;
      clusterSize = 0;
      extra = 0;
    };
    for (const iv of ivs) {
      // Overlap requires the later session to START before the cluster's
      // current end minus the grace window.
      if (open && iv.start < clusterEnd - MIN_OVERLAP_MS) {
        clusterSize += 1;
        extra += 1;
        clusterEnd = Math.max(clusterEnd, iv.end);
      } else {
        flush();
        open = true;
        clusterSize = 1;
        clusterEnd = iv.end;
      }
    }
    flush();
  }
  return out.sort((a, b) => b.extraFloorTokens - a.extraFloorTokens);
}

const rule: Rule = {
  key: 'session-thrash',
  metric: 'floorShare',
  direction: 'down',
  family: 'caching',
  title: 'Parallel sessions paying separate context floors',
  docs: `Main-loop sessions in one project overlapping in time: work split across
parallel windows, each paying its own context floor and none sharing what the
others learned.

This finding is descriptive and stays measured about it. Deliberate parallelism
is a real workflow — a long build running in one window while editing in another
— and delegating to subagents (which the report deliberately does not judge) is
the sanctioned version of exactly this pattern. Subagent runs are excluded from
the evidence entirely.

Fires when a project has an overlapping cluster of two or more main-loop
sessions; every session beyond the first in a cluster adds one median session
floor to the observed extra cost.`,
  fires: (m) =>
    m.floorShare > 0 && m.sessionFloorTokens > 0
      ? 'Parallel main-loop sessions observed in at least one project — the evidence line names where and what the duplicate floors cost.'
      : undefined,
  // score() sees one session at a time and cannot see intervals; concurrency
  // is a group property, so evidence lives in clause() only.
  score: () => ({ score: 0, label: '' }),
  clause: ({ events }) => {
    // Session floor: same estimator as metrics.ts (median of per-session
    // minimum standing context, main-loop only, >=5 sessions to trust it).
    const ctxOf = (e: import('../store.js').StoredEvent) => e.input_tokens + e.cache_read_tokens + e.cache_creation_tokens;
    const main = events.filter((e) => e.is_sidechain !== 1);
    const floors: number[] = [];
    for (const [, evs] of groupBy(main, 'session_id')) {
      const contexts = evs.map(ctxOf).filter((c) => c > 0);
      if (contexts.length > 0) floors.push(Math.min(...contexts));
    }
    const sessionFloorTokens =
      floors.length >= 5 ? median([...floors].sort((a, b) => a - b)) : 0;
    const groups = thrashedProjects(events, sessionFloorTokens);
    if (!groups.length) return '';
    const totalExtra = groups.reduce((sum, g) => sum + g.extraFloorTokens, 0);
    const names = groups
      .slice(0, 3)
      .map((g) => `${g.project} (${g.sessions} concurrent)`)
      .join(', ');
    return ` ${groups.length} project(s) ran overlapping main-loop sessions: ${names}. Roughly ${fmtTokens(totalExtra)} of duplicated floor across them. Sometimes that is deliberate — a long build here while editing there; when it is not, finishing one thread before opening the next keeps one shared context instead of N.`;
  },
};

export default rule;
