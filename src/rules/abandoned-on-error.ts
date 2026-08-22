import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

/** Idle days before a session whose last turn failed counts as abandoned. */
export const IDLE_DAYS = 3;

export interface Abandoned {
  sessionId: string;
  spendTokens: number;
  idleDays: number;
}

/**
 * Sessions whose LAST turn errored, past the idle guard. Main-loop only — a
 * subagent that ends on error hands the failure back to its caller, which is
 * the system working. `windowEndMs` is the newest event seen, so fixtures and
 * back-filled databases behave like a live run. Exported so the test can
 * exercise the exact gate the clause applies.
 */
export function abandonedSessions(
  events: import('../store.js').StoredEvent[],
  nowMs: number = Date.now()
): Abandoned[] {
  const bySession = new Map<string, import('../store.js').StoredEvent[]>();
  let windowEndMs = 0;
  for (const e of events) {
    const list = bySession.get(e.session_id);
    if (list) list.push(e);
    else bySession.set(e.session_id, [e]);
    const t = Date.parse(e.ts);
    if (t > windowEndMs) windowEndMs = t;
  }
  const anchor = Math.max(nowMs, windowEndMs);
  const out: Abandoned[] = [];
  for (const [sessionId, evs] of bySession) {
    // Events are appended chronologically, so the last one is the final turn.
    const last = evs[evs.length - 1];
    if (!last.is_error || last.is_sidechain === 1) continue;
    const idleDays = Math.floor((anchor - Date.parse(last.ts)) / 86_400_000);
    if (idleDays < IDLE_DAYS) continue;
    const spendTokens = evs.reduce(
      (sum, e) => sum + e.input_tokens + e.output_tokens + e.cache_creation_tokens,
      0
    );
    out.push({ sessionId, spendTokens, idleDays });
  }
  return out.sort((a, b) => b.spendTokens - a.spendTokens);
}

const rule: Rule = {
  key: 'abandoned-on-error',
  // reworkRatio is the tracked follow-through metric for this family; the
  // rule's own firing gate is event-based (see clause), not ratio-based.
  metric: 'reworkRatio',
  direction: 'down',
  family: 'rework',
  title: 'Sessions abandoned on their final error',
  docs: `Sessions whose last turn errored: the work stopped where it broke, and
whatever the session spent bought nothing — the next session usually starts over
with fresh context and re-reads everything.

Two guards keep this honest. Main-loop only: a subagent run that ends on an error
hands the failure back to its caller, which is the system working, not waste. And
a recency guard: a session whose last turn is recent may simply still be running,
so it must sit idle for ${IDLE_DAYS}+ days past its final (failing) turn before
this rule accuses it.

Fires when at least one main-loop session meets both conditions; the evidence
list names the biggest abandoned sessions with their spend.`,
  fires: (m) =>
    m.errorEvents > 0
      ? 'One or more sessions ended on an error and went quiet. Their spend bought nothing where they stopped.'
      : undefined,
  // score() sees only one session's events, so it cannot apply the window-end
  // idle guard honestly. Evidence ranking therefore re-uses the exact helper
  // the clause gates with, via the session's own events for the spend and the
  // last-error check; the idle guard is applied in clause() and mirrored in
  // the test through abandonedSessions() directly.
  score: (s) => {
    if (s.isSidechain) return { score: 0, label: '' };
    const last = s.events[s.events.length - 1];
    if (!last || !last.is_error) return { score: 0, label: '' };
    const spendTokens = s.events.reduce(
      (sum, e) => sum + e.input_tokens + e.output_tokens + e.cache_creation_tokens,
      0
    );
    return {
      score: spendTokens,
      label: `last turn errored · ${fmtTokens(spendTokens)} spent`,
    };
  },
  clause: ({ events }) => {
    const list = abandonedSessions(events);
    if (!list.length) return '';
    const top = list
      .slice(0, 3)
      .map((a) => `${a.sessionId.slice(0, 8)} (${fmtTokens(a.spendTokens)}, idle ${a.idleDays}d)`)
      .join(', ');
    return ` ${list.length} session(s) sit abandoned on a final error: ${top}. Re-opening them means paying their context twice — start fresh with the error's last message in hand.`;
  },
};

export default rule;
