import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Bloom, shingles, detectRelays, words,
  MIN_MESSAGE_SHINGLES, RELAY_THRESHOLD,
} from '../src/relay.js';
import type { CandidateMessage, RelayFingerprint } from '../src/relay.js';

const LOREM = (n: number) =>
  Array.from({ length: n }, (_, i) => `token${i % 97} phrase${i % 31} value${i % 13}`).join(' ');

const fingerprint = (
  sessionId: string, text: string, lastTs: string, extra: Partial<RelayFingerprint> = {},
): RelayFingerprint => {
  const sh = shingles(text);
  return {
    sessionId, source: 'claude-code', project: 'p',
    outBloom: Bloom.of(sh, sh.size).serialize(),
    outShingles: sh.size,
    firstTs: lastTs, lastTs, ...extra,
  };
};
const msg = (sessionId: string, text: string, ts: string, extra: Partial<CandidateMessage> = {}): CandidateMessage =>
  ({ sessionId, source: 'claude-code', project: 'p', ts, text, ...extra });

test('a Bloom filter answers containment with no false negatives', () => {
  const sh = shingles(LOREM(400));
  const b = Bloom.of(sh, sh.size);
  for (const h of sh) assert.equal(b.has(h), true, 'every member must be found');
  // False positives are possible but rare at the configured rate.
  const absent = [...shingles(LOREM(400).split(' ').reverse().join(' '))].filter((h) => !sh.has(h));
  const fp = absent.filter((h) => b.has(h)).length;
  assert.ok(fp / Math.max(1, absent.length) < 0.05, `false-positive rate too high: ${fp}/${absent.length}`);
});

test('a serialised filter round-trips, k included', () => {
  const sh = shingles(LOREM(200));
  const b = Bloom.of(sh, sh.size);
  const back = Bloom.deserialize(b.serialize());
  assert.equal(back.k, b.k);
  for (const h of sh) assert.equal(back.has(h), true);
});

test('a verbatim paste is detected; unrelated text is not', () => {
  const produced = LOREM(300);
  const fps = [fingerprint('A', produced, '2026-06-01T10:00:00Z')];
  const pairs = detectRelays(
    [
      msg('B', produced, '2026-06-02T10:00:00Z'),            // pasted whole
      msg('C', LOREM(300).split(' ').reverse().join(' '), '2026-06-02T11:00:00Z'), // unrelated
    ],
    fps,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].fromSessionId, 'A');
  assert.equal(pairs[0].toSessionId, 'B');
  assert.ok(pairs[0].overlap > 0.95);
  assert.equal(pairs[0].gapDays, 1);
});

test('short quotes stay under the floor even at perfect overlap', () => {
  const produced = LOREM(300);
  // A handful of shingles scores 1.0 but is a quoted line, not a relay.
  const snippet = words(produced).slice(0, MIN_MESSAGE_SHINGLES).join(' ');
  assert.ok(shingles(snippet).size < MIN_MESSAGE_SHINGLES);
  const pairs = detectRelays([msg('B', snippet, '2026-06-02T10:00:00Z')], [fingerprint('A', produced, '2026-06-01T10:00:00Z')]);
  assert.equal(pairs.length, 0);
});

test('only earlier-to-later pairs inside the window count', () => {
  const produced = LOREM(300);
  const later = detectRelays([msg('B', produced, '2026-06-01T09:00:00Z')], [fingerprint('A', produced, '2026-06-01T10:00:00Z')]);
  assert.equal(later.length, 0, 'output produced after the prompt cannot be its source');

  const stale = detectRelays([msg('B', produced, '2026-07-01T10:00:00Z')], [fingerprint('A', produced, '2026-06-01T10:00:00Z')]);
  assert.equal(stale.length, 0, 'beyond the window');

  const self = detectRelays([msg('A', produced, '2026-06-02T10:00:00Z')], [fingerprint('A', produced, '2026-06-01T10:00:00Z')]);
  assert.equal(self.length, 0, 'a session quoting itself is not a relay');
});

test('cross-source relays are found and each paste keeps one origin', () => {
  const produced = LOREM(300);
  const pairs = detectRelays(
    [msg('B', produced, '2026-06-03T10:00:00Z', { source: 'gemini-cli', project: 'other' })],
    [
      fingerprint('A1', produced, '2026-06-01T10:00:00Z'),
      fingerprint('A2', produced, '2026-06-02T10:00:00Z'), // also matches, but later
    ],
  );
  assert.equal(pairs.length, 1, 'one paste, one reported origin');
  assert.equal(pairs[0].toSource, 'gemini-cli');
  assert.equal(pairs[0].fromSource, 'claude-code');
});

test('detection is deterministic and ordered by relayed volume', () => {
  const big = LOREM(400), small = LOREM(120);
  const fps = [fingerprint('A', big + ' ' + small, '2026-06-01T10:00:00Z')];
  const msgs = [msg('C', small, '2026-06-02T11:00:00Z'), msg('B', big, '2026-06-02T10:00:00Z')];
  const once = detectRelays(msgs, fps);
  const twice = detectRelays([...msgs].reverse(), fps);
  assert.deepEqual(once, twice, 'input order must not change output');
  assert.equal(once[0].toSessionId, 'B', 'largest relayed block first');
});

test('the threshold is respected and tunable', () => {
  const produced = LOREM(300);
  // Half pasted, half fresh -> roughly 0.5 overlap.
  const half = words(produced).slice(0, 450).join(' ') + ' ' + LOREM(150).split(' ').reverse().join(' ');
  const fps = [fingerprint('A', produced, '2026-06-01T10:00:00Z')];
  assert.equal(detectRelays([msg('B', half, '2026-06-02T10:00:00Z')], fps, { threshold: 0.9 }).length, 0);
  assert.equal(detectRelays([msg('B', half, '2026-06-02T10:00:00Z')], fps, { threshold: 0.2 }).length, 1);
  assert.ok(RELAY_THRESHOLD > 0.2 && RELAY_THRESHOLD < 0.9);
});

// ---- storage + scan wiring --------------------------------------------------

import { openDb, recordRelayFingerprints, loadRelayFingerprints } from '../src/store.js';

test('fingerprints persist, refresh on growth, and never store text', () => {
  const db = openDb(':memory:');
  const fp = (id: string, text: string, last: string) => fingerprint(id, text, last);

  assert.equal(recordRelayFingerprints(db, [fp('A', LOREM(200), '2026-06-01T10:00:00Z')]), 1);
  const [stored] = loadRelayFingerprints(db);
  assert.equal(stored.sessionId, 'A');
  assert.ok(stored.outShingles > 0);

  // A session that gained turns has more output to match against: refresh it.
  const grown = fp('A', LOREM(600), '2026-06-01T12:00:00Z');
  recordRelayFingerprints(db, [grown]);
  assert.ok(loadRelayFingerprints(db)[0].outShingles > stored.outShingles);

  // A shorter re-derivation (a truncated re-read) must not clobber the fuller one.
  recordRelayFingerprints(db, [fp('A', LOREM(50), '2026-06-01T13:00:00Z')]);
  assert.ok(loadRelayFingerprints(db)[0].outShingles > stored.outShingles);

  // The stored row is a bit array and counts — the plaintext is nowhere in it.
  const raw = db.prepare('SELECT * FROM session_relay').all() as Array<Record<string, unknown>>;
  const blob = JSON.stringify(raw).toLowerCase();
  assert.ok(!blob.includes('token1 phrase1'), 'no source text may reach the database');
  assert.deepEqual(
    Object.keys(raw[0]).sort(),
    ['first_ts', 'last_ts', 'out_bloom', 'out_shingles', 'project', 'session_id', 'source'],
  );
});

test('detection still works after the source transcript is gone', () => {
  // The whole reason fingerprints are persisted: Claude Code deletes
  // transcripts after ~30 days, which is inside the window a paste spans.
  const db = openDb(':memory:');
  const produced = LOREM(300);
  recordRelayFingerprints(db, [fingerprint('A', produced, '2026-06-01T10:00:00Z')]);
  // A is no longer re-collectable; only its stored fingerprint remains.
  const pairs = detectRelays([msg('B', produced, '2026-06-02T10:00:00Z')], loadRelayFingerprints(db));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].fromSessionId, 'A');
});

test('secrets are redacted before anything is hashed', async () => {
  const { redact } = await import('../src/intent.js');
  const SECRET = 'ghp_ABCDEF0123456789abcdefZZ';
  const text = `${LOREM(200)} the deploy key is ${SECRET} use it for the push`;
  // The pipeline shingles redact(text), never text.
  const raw = shingles(text);
  const safe = shingles(redact(text));
  const secretShingles = [...raw].filter((h) => !safe.has(h));
  assert.ok(secretShingles.length > 0, 'redaction must change the shingle set');
  const b = Bloom.of(safe, safe.size);
  // Every shingle that spanned the secret is absent from what gets stored.
  const leaked = secretShingles.filter((h) => b.has(h)).length;
  assert.ok(leaked <= 1, `secret-bearing shingles must not be stored (found ${leaked})`);
});
