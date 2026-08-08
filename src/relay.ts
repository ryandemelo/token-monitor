/**
 * Relay-waste detection (#65) — the waste *between* sessions.
 *
 * Every other signal in this tool is single-session: cache, rework, bloat,
 * cold restarts, retries. The pattern this one catches is one session's
 * output hand-pasted into the next session's prompt — often into a different
 * agent — re-paying as fresh input for text the toolchain already produced.
 *
 * Two design decisions came out of dogfooding the original design (#65), and
 * both are load-bearing:
 *
 * 1. **The unit is one user message, not the session.** Overlap measured
 *    across a whole session's input drowns a real paste: median session input
 *    is ~4.8k shingles, so a 500-word pasted block scores ~0.10. Measured over
 *    a real 30-day window, per-session found 1 relay and per-message found 27.
 *
 * 2. **A Bloom filter, not a min-hash sketch.** Min-hash estimates Jaccard;
 *    what this needs is containment of a small set in a large one. With output
 *    sets of median ~10.7k shingles, keeping the 192 smallest is a ~2% sample
 *    a pasted message never lands in — measured recall was 0%. A Bloom filter
 *    answers exactly the question being asked ("is this shingle in that
 *    session's output?") at ~100% recall and a bounded size.
 *
 * The privacy contract is the same one categorize already keeps: text is
 * carried in memory only long enough to derive a fingerprint. What is stored
 * is a bit array of hashed 8-word shingles — not enumerable the way the
 * single-word category terms would be, which is why those are deliberately
 * kept readable and these are not. Nothing here is ever printed or exported;
 * exports carry shares and counts only.
 */

/** Words per shingle. w=5/8/12 all found the same pairs on real data; 8 is the middle. */
export const SHINGLE_WORDS = 8;
/**
 * A message needs at least this many shingles to be judged. Below it, a quoted
 * error line or a one-sentence recap would score 1.0 on a handful of shingles
 * and read as a paste.
 */
export const MIN_MESSAGE_SHINGLES = 24;
/**
 * Overlap at or above this is called a relay. The observed signal is bimodal —
 * pastes land near 1.00, everything else near 0.05 — so this sits in the empty
 * middle where the exact value barely matters.
 */
export const RELAY_THRESHOLD = 0.35;
/** Only pairs this close in time are considered; bounds the comparison space. */
export const RELAY_WINDOW_DAYS = 14;
/** Target false-positive rate for the per-session Bloom filter. */
const BLOOM_FPR = 0.01;
/** Ceiling on one session's filter, so a huge session can't bloat the database. */
const BLOOM_MAX_BYTES = 256 * 1024;

/** FNV-1a, the same hash categorize uses for intent ids. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A second, independent hash for the Kirsch-Mitzenmacher double-hashing scheme. */
function fnv1aSeeded(s: string): number {
  let h = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x000001b3) >>> 0;
  }
  return h >>> 0;
}

export function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Hashed w-word shingles. Order-insensitive by construction (a Set). */
export function shingles(text: string, w: number = SHINGLE_WORDS): Set<number> {
  const ws = words(text);
  const out = new Set<number>();
  for (let i = 0; i + w <= ws.length; i++) out.add(fnv1a(ws.slice(i, i + w).join(' ')));
  return out;
}

/**
 * A Bloom filter sized for `n` items at BLOOM_FPR. Deliberately the simplest
 * thing that answers containment: a bit array plus k derived hashes, no
 * dependency, and serialisable to a BLOB as-is.
 */
export class Bloom {
  readonly bits: Uint8Array;
  readonly k: number;

  constructor(bits: Uint8Array, k: number) {
    this.bits = bits;
    this.k = k;
  }

  static forItems(n: number): Bloom {
    const items = Math.max(1, n);
    const bitsWanted = Math.ceil((-items * Math.log(BLOOM_FPR)) / (Math.LN2 * Math.LN2));
    const bytes = Math.min(BLOOM_MAX_BYTES, Math.max(8, Math.ceil(bitsWanted / 8)));
    const m = bytes * 8;
    // k that minimises the false-positive rate for this m/n, clamped so a
    // capped filter on a huge session stays cheap rather than hashing 30 times.
    const k = Math.max(1, Math.min(12, Math.round((m / items) * Math.LN2)));
    return new Bloom(new Uint8Array(bytes), k);
  }

  static of(items: Iterable<number>, n: number): Bloom {
    const b = Bloom.forItems(n);
    for (const h of items) b.add(h);
    return b;
  }

  private *slots(h: number): Generator<number> {
    const m = this.bits.length * 8;
    const h1 = h >>> 0;
    const h2 = (fnv1aSeeded(String(h)) | 1) >>> 0; // odd, so it strides the whole array
    for (let i = 0; i < this.k; i++) yield ((h1 + Math.imul(i, h2)) >>> 0) % m;
  }

  add(h: number): void {
    for (const s of this.slots(h)) this.bits[s >>> 3] |= 1 << (s & 7);
  }

  has(h: number): boolean {
    for (const s of this.slots(h)) if ((this.bits[s >>> 3] & (1 << (s & 7))) === 0) return false;
    return true;
  }

  /** `k` rides in the first byte so a stored filter is self-describing. */
  serialize(): Uint8Array {
    const out = new Uint8Array(this.bits.length + 1);
    out[0] = this.k;
    out.set(this.bits, 1);
    return out;
  }

  static deserialize(buf: Uint8Array): Bloom {
    return new Bloom(buf.subarray(1), buf[0] || 1);
  }
}

/** One session's output fingerprint, as stored. */
export interface RelayFingerprint {
  sessionId: string;
  source: string;
  project: string;
  /** Serialised Bloom over this session's assistant-output shingles. */
  outBloom: Uint8Array;
  outShingles: number;
  /** Earliest and latest event timestamps, for ordering and the time window. */
  firstTs: string;
  lastTs: string;
}

/** One detected paste: text produced by `from` reappearing in a prompt to `to`. */
export interface RelayPair {
  fromSessionId: string;
  fromSource: string;
  fromProject: string;
  toSessionId: string;
  toSource: string;
  toProject: string;
  /** Fraction of the pasted message's shingles found in the earlier output. */
  overlap: number;
  /** Words in the relayed message — the re-paid text. */
  relayedWords: number;
  /** Whole days between the earlier session ending and the paste. */
  gapDays: number;
}

/** A prompt as offered to detection: one user turn, with its timestamp. */
export interface CandidateMessage {
  sessionId: string;
  source: string;
  project: string;
  ts: string;
  text: string;
}

const DAY = 86_400_000;

/**
 * Find pastes: prompts whose text substantially reappears from an earlier
 * session's output. Only earlier-to-later pairs within the window are
 * considered, and each message keeps only its strongest source — a paste has
 * one origin, and reporting every partial match would turn one event into a
 * pile of accusations.
 *
 * Biased to false negatives on purpose, like the duplicate-work signal: a
 * wrong "you are relaying" costs more trust than a missed one.
 */
export function detectRelays(
  messages: CandidateMessage[],
  fingerprints: RelayFingerprint[],
  opts: { threshold?: number; minShingles?: number } = {},
): RelayPair[] {
  const threshold = opts.threshold ?? RELAY_THRESHOLD;
  const minShingles = opts.minShingles ?? MIN_MESSAGE_SHINGLES;
  const sources = fingerprints.map((f) => ({ f, bloom: Bloom.deserialize(f.outBloom), last: Date.parse(f.lastTs) }));
  const out: RelayPair[] = [];

  for (const m of messages) {
    const sh = shingles(m.text);
    if (sh.size < minShingles) continue;
    const at = Date.parse(m.ts);
    let best: RelayPair | undefined;
    for (const { f, bloom, last } of sources) {
      if (f.sessionId === m.sessionId) continue;
      if (last >= at || at - last > RELAY_WINDOW_DAYS * DAY) continue;
      let hit = 0;
      for (const h of sh) if (bloom.has(h)) hit++;
      const overlap = hit / sh.size;
      if (overlap < threshold || (best && overlap <= best.overlap)) continue;
      best = {
        fromSessionId: f.sessionId,
        fromSource: f.source,
        fromProject: f.project,
        toSessionId: m.sessionId,
        toSource: m.source,
        toProject: m.project,
        overlap,
        relayedWords: words(m.text).length,
        gapDays: Math.max(0, Math.round((at - last) / DAY)),
      };
    }
    if (best) out.push(best);
  }
  // Total order so the same database always renders the same list.
  return out.sort(
    (a, b) =>
      b.relayedWords - a.relayedWords ||
      b.overlap - a.overlap ||
      (a.toSessionId < b.toSessionId ? -1 : a.toSessionId > b.toSessionId ? 1 : 0),
  );
}
