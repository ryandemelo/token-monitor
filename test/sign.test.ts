import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalize,
  ensureKeypair,
  fingerprint,
  signObject,
  verifyObject,
  checkKeyring,
} from '../src/sign.js';

const keyDir = () => mkdtempSync(join(tmpdir(), 'tm-keys-'));

test('canonicalize is stable across key order and drops undefined', () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalize({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(canonicalize({ a: 1, skip: undefined }), '{"a":1}');
});

test('sign/verify roundtrip', () => {
  const dir = keyDir();
  const signed = signObject({ user: 'alice', total: 42 }, dir);
  const vr = verifyObject(signed as unknown as Record<string, unknown>);
  assert.equal(vr.ok, true);
  assert.equal(vr.fingerprint, fingerprint(ensureKeypair(dir).publicPem));
});

test('any payload modification breaks the signature', () => {
  const dir = keyDir();
  const signed = signObject({ user: 'alice', total: 42 }, dir) as unknown as Record<string, unknown>;
  const tampered = { ...signed, total: 43 };
  const vr = verifyObject(tampered);
  assert.equal(vr.ok, false);
  assert.match(vr.reason!, /modified after signing/);
});

test('unsigned and garbage objects are rejected, not thrown', () => {
  assert.equal(verifyObject({ user: 'x' }).ok, false);
  assert.equal(verifyObject({ user: 'x' }).reason, 'unsigned');
  const vr = verifyObject({ user: 'x', sig: { alg: 'ed25519', publicKey: 'not a key', signature: 'xx' } });
  assert.equal(vr.ok, false);
});

test('keypair is stable across calls; fingerprints differ between machines', () => {
  const dirA = keyDir();
  const dirB = keyDir();
  const fpA1 = fingerprint(ensureKeypair(dirA).publicPem);
  const fpA2 = fingerprint(ensureKeypair(dirA).publicPem);
  const fpB = fingerprint(ensureKeypair(dirB).publicPem);
  assert.equal(fpA1, fpA2);
  assert.notEqual(fpA1, fpB);
  assert.match(fpA1, /^[0-9a-f]{16}$/);
});

test('keyring pins user -> fingerprint', () => {
  assert.equal(checkKeyring({ alice: 'aabb' }, 'alice', 'aabb').ok, true);
  assert.match(checkKeyring({ alice: 'aabb' }, 'alice', 'ccdd').reason!, /mismatch/);
  assert.match(checkKeyring({}, 'bob', 'eeff').reason!, /not in keyring — enroll fingerprint eeff/);
});
