import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Tamper-evident exports. Each machine holds an Ed25519 keypair; exports are
 * signed over a canonical serialization, and `merge --verify` checks
 * signatures (optionally against a pinned username -> fingerprint map).
 *
 * Threat model (see README): this detects modification after export and
 * impersonation of another member. It cannot stop a malicious developer
 * editing their own source logs before collection — they control the
 * machine. The mitigation for that is cross-checking totals against the
 * provider's billing/usage APIs (roadmap).
 */

export const DEFAULT_KEY_DIR = join(homedir(), '.token-monitor');
const PRIV = 'signing-key.pem';
const PUB = 'signing-key.pub.pem';

export function ensureKeypair(dir: string = DEFAULT_KEY_DIR): { privateKey: KeyObject; publicPem: string } {
  const privPath = join(dir, PRIV);
  const pubPath = join(dir, PUB);
  if (!existsSync(privPath)) {
    mkdirSync(dir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    chmodSync(privPath, 0o600);
  }
  const privateKey = createPrivateKey(readFileSync(privPath, 'utf8'));
  const publicPem = readFileSync(pubPath, 'utf8');
  return { privateKey, publicPem };
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
      .join(',') +
    '}'
  );
}

/** Short, human-comparable identity for a public key. */
export function fingerprint(publicPem: string): string {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export interface Signature {
  alg: 'ed25519';
  publicKey: string;
  signature: string;
}

export function signObject<T extends object>(payload: T, dir?: string): T & { sig: Signature } {
  const { privateKey, publicPem } = ensureKeypair(dir);
  const signature = cryptoSign(null, Buffer.from(canonicalize(payload)), privateKey).toString('base64');
  return { ...payload, sig: { alg: 'ed25519', publicKey: publicPem, signature } };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  fingerprint?: string;
}

export function verifyObject(obj: Record<string, unknown>): VerifyResult {
  const sig = obj.sig as Signature | undefined;
  if (!sig?.signature || !sig.publicKey) return { ok: false, reason: 'unsigned' };
  if (sig.alg !== 'ed25519') return { ok: false, reason: `unsupported alg ${sig.alg}` };
  const { sig: _drop, ...payload } = obj;
  try {
    const publicKey = createPublicKey(sig.publicKey);
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalize(payload)),
      publicKey,
      Buffer.from(sig.signature, 'base64'),
    );
    return ok
      ? { ok: true, fingerprint: fingerprint(sig.publicKey) }
      : { ok: false, reason: 'signature mismatch — export was modified after signing', fingerprint: fingerprint(sig.publicKey) };
  } catch (e) {
    return { ok: false, reason: `invalid key or signature: ${(e as Error).message}` };
  }
}

/** keys.json: { "username": "fingerprint", ... } pinned by the team lead. */
export function loadKeyring(path: string): Record<string, string> {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data !== 'object' || data === null) throw new Error('keyring must be an object');
  return data as Record<string, string>;
}

export function checkKeyring(
  keyring: Record<string, string>,
  user: string,
  fp: string,
): VerifyResult {
  const pinned = keyring[user];
  if (!pinned) return { ok: false, reason: `user "${user}" not in keyring — enroll fingerprint ${fp}`, fingerprint: fp };
  if (pinned !== fp) {
    return { ok: false, reason: `fingerprint mismatch for "${user}": keyring has ${pinned}, export signed by ${fp}`, fingerprint: fp };
  }
  return { ok: true, fingerprint: fp };
}

export function keyDirFor(dbPath?: string): string | undefined {
  // Keep keys beside a custom db so tests and parallel setups stay isolated.
  return dbPath ? dirname(dbPath) : undefined;
}
