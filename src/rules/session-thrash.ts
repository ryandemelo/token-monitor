import type { Metrics } from '../metrics.js';
import { detectSessionThrash } from '../metrics.js';
import { fmtTokens } from '../fmt.js';
import type { StoredEvent } from '../store.js';
import type { ClauseArgs, Rule } from './types.js';

/**
 * Main-loop sessions in the same project whose [first, last] intervals overlap
 * by more than MIN_OVERLAP_MS: parallel windows, each paying its own context
 * floor. Subagent runs are excluded upstream — they are the sanctioned version
 * of parallelism. Clusters are built greedily in start order; every session
 * past the first adds one median session floor.
 */
const rule: Rule = {
  key: 'session-thrash',
  metric: 'thrashShare',
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
floor to the observed extra cost. That figure is a **ceiling**, like
abandoned-work's: it prices each extra session as if one shared session would
otherwise have covered its work, which is precisely what genuinely separate
workstreams deny. Read it as the most the duplication could cost, not the
least.`,
  fires: (m) =>
    m.thrashedProjects > 0 && m.sessionFloorTokens > 0
      ? 'Parallel main-loop sessions observed in at least one project — the evidence line names where and what the duplicate floors cost.'
      : undefined,
  // score() sees one session at a time and cannot see intervals; concurrency
  // is a group property, so evidence lives in clause() only.
  score: () => ({ score: 0, label: '' }),
  clause: ({ events, m }: ClauseArgs & { m?: Metrics }) => {
    const groups = detectSessionThrash(events, m?.sessionFloorTokens ?? 0);
    if (!groups.length) return '';
    const totalExtra = groups.reduce((sum, g) => sum + g.extraFloorTokens, 0);
    const names = groups
      .slice(0, 3)
      .map((g) => `${g.project} (${g.sessions} concurrent)`)
      .join(', ');
    return ` ${groups.length} project(s) ran overlapping main-loop sessions: ${names}. Roughly ${fmtTokens(totalExtra)} of duplicated floor across them, priced as a ceiling: each extra session is billed as if one shared session would have covered its work, which separate workstreams may not allow. Sometimes that is deliberate — a long build here while editing there; when it is not, finishing one thread before opening the next keeps one shared context instead of N.`;
  },
};

export default rule;
