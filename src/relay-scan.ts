/**
 * The driver that turns transcripts into relay findings (#65).
 *
 * Split from relay.ts on purpose: that file is pure — shingles, a Bloom
 * filter, and a comparison — and is tested without touching a database or a
 * disk. This one owns the side effects: re-collecting text through the
 * adapters, writing fingerprints, and joining detections back to stored spend.
 *
 * The text path is the same one categorize established: adapters expose
 * `intentText` / `responseText` transiently, this module reduces them to
 * hashes, and the text is dropped. Nothing here prints, stores, or returns
 * text — the return type carries session ids, counts and dollars only.
 */
import type { DatabaseSync } from 'node:sqlite';
import { loadEvents, recordRelayFingerprints, loadRelayFingerprints } from './store.js';
import type { StoredEvent } from './store.js';
import { groupByRootSession } from './metrics.js';
import { costOf } from './pricing.js';
import { ADAPTERS } from './adapters/index.js';
import type { Source, UsageEvent } from './types.js';
import { redact } from './intent.js';
import { Bloom, shingles, detectRelays, words } from './relay.js';
import type { CandidateMessage, RelayFingerprint, RelayPair } from './relay.js';

export interface RelayResult {
  days: number;
  /** Sessions that contributed an output fingerprint this scan. */
  fingerprinted: number;
  pairs: RelayPair[];
  /** Words of prompt text that reappeared from an earlier session's output. */
  relayedWords: number;
  /** Those words as a share of all prompt words seen — the honest denominator. */
  relayedShare: number;
  /** Estimated cost of re-paying that text as fresh input. */
  relayedCostUsd: number;
  estimated: boolean;
}

/**
 * Re-collect text and rebuild fingerprints. Redaction runs BEFORE anything is
 * hashed, so a pasted secret never reaches the filter — the same ordering
 * categorize uses, and the reason a leaked key can't be confirmed by probing
 * the stored bits.
 */
function collectText(source?: string): {
  fingerprints: RelayFingerprint[];
  messages: CandidateMessage[];
  promptWords: number;
} {
  const sources = (source ? [source] : Object.keys(ADAPTERS)) as Source[];
  const outputs = new Map<string, { source: string; project: string; text: string[]; first: string; last: string }>();
  const messages: CandidateMessage[] = [];
  let promptWords = 0;
  // Consecutive turns repeat the same carried prompt; only the first is a
  // distinct thing the person typed or pasted.
  const seenPrompt = new Map<string, Set<string>>();

  for (const src of sources) {
    const adapter = ADAPTERS[src];
    if (!adapter) continue;
    let events: UsageEvent[];
    try {
      events = adapter().events;
    } catch {
      continue; // one malformed local log must never abort the scan
    }
    for (const ev of events) {
      if (ev.responseText) {
        let o = outputs.get(ev.sessionId);
        if (!o) {
          outputs.set(ev.sessionId, (o = { source: ev.source, project: ev.project, text: [], first: ev.timestamp, last: ev.timestamp }));
        }
        o.text.push(redact(ev.responseText));
        if (ev.timestamp < o.first) o.first = ev.timestamp;
        if (ev.timestamp > o.last) o.last = ev.timestamp;
      }
      if (ev.intentText) {
        let seen = seenPrompt.get(ev.sessionId);
        if (!seen) seenPrompt.set(ev.sessionId, (seen = new Set()));
        if (seen.has(ev.intentText)) continue;
        seen.add(ev.intentText);
        const text = redact(ev.intentText);
        promptWords += words(text).length;
        messages.push({ sessionId: ev.sessionId, source: ev.source, project: ev.project, ts: ev.timestamp, text });
      }
    }
  }

  const fingerprints: RelayFingerprint[] = [];
  for (const [sessionId, o] of outputs) {
    const sh = shingles(o.text.join('\n'));
    if (sh.size === 0) continue;
    fingerprints.push({
      sessionId,
      source: o.source,
      project: o.project,
      outBloom: Bloom.of(sh, sh.size).serialize(),
      outShingles: sh.size,
      firstTs: o.first,
      lastTs: o.last,
    });
  }
  return { fingerprints, messages, promptWords };
}

/**
 * Price relayed text against the session that re-paid it. Input rate per word
 * is derived from that session's own spend rather than a global average, so a
 * paste into a premium-model session is not costed at a cheap blended rate.
 */
function priceRelays(pairs: RelayPair[], events: StoredEvent[]): { usd: number; estimated: boolean } {
  const bySession = new Map<string, StoredEvent[]>();
  for (const [id, evs] of groupByRootSession(events)) bySession.set(id, evs);
  let usd = 0;
  let estimated = false;
  for (const p of pairs) {
    const evs = bySession.get(p.toSessionId);
    if (!evs) continue;
    let input = 0, cost = 0;
    for (const e of evs) {
      input += e.input_tokens;
      const c = costOf(e.model, e.input_tokens, 0, 0, 0);
      cost += c.usd;
      if (c.estimated) estimated = true;
    }
    if (input === 0) continue;
    // ~1.3 tokens per word is the usual English ratio; the estimate is
    // deliberately coarse and labelled as such wherever it is shown.
    usd += Math.min(input, p.relayedWords * 1.3) * (cost / input);
  }
  return { usd, estimated };
}

/**
 * Scan for relayed prompts. Writes fingerprints as a side effect (idempotent),
 * so a later scan can still match against a session whose transcript the
 * agent has since deleted.
 */
export function runRelayScan(
  db: DatabaseSync,
  opts: { days?: number; source?: string; threshold?: number; minShingles?: number } = {},
): RelayResult {
  const days = opts.days ?? 30;
  const { fingerprints, messages, promptWords } = collectText(opts.source);
  recordRelayFingerprints(db, fingerprints);

  // Detect against everything stored, not just this scan: the whole point is
  // reaching sessions whose transcripts are gone.
  const stored = loadRelayFingerprints(db, days + 14);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const pairs = detectRelays(
    messages.filter((m) => m.ts >= cutoff),
    stored,
    { threshold: opts.threshold, minShingles: opts.minShingles },
  );

  const events = loadEvents(db, { days, source: opts.source });
  const { usd, estimated } = priceRelays(pairs, events);
  const relayedWords = pairs.reduce((t, p) => t + p.relayedWords, 0);
  return {
    days,
    fingerprinted: fingerprints.length,
    pairs,
    relayedWords,
    relayedShare: promptWords > 0 ? relayedWords / promptWords : 0,
    relayedCostUsd: usd,
    estimated,
  };
}
