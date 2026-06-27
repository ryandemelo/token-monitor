import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redact,
  tokenize,
  fingerprint,
  FINGERPRINT_K,
  deriveSessionIntent,
  fnv1a,
} from '../src/intent.js';

test('redact strips emails, URLs, paths, API keys, JWTs, long digit/hex runs', () => {
  const secrets = [
    'alice@example.com',
    'https://internal.corp/secret?token=abc123',
    '/Users/dev/secret/path/file.ts',
    'sk-CANARYdeadbeef1234',
    'ghp_ABCDEF0123456789abcdef',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.sigpart',
    'deadbeefdeadbeef0123',
    '123456789012',
  ];
  for (const s of secrets) {
    const r = redact(`please look at ${s} thanks`);
    assert.ok(!r.includes(s), `secret survived redaction: ${s}`);
  }
});

test('tokenize drops secrets before they become tokens (privacy canary)', () => {
  const toks = tokenize('Add auth to the API. key is sk-CANARYdeadbeef1234 and email bob@corp.com');
  assert.ok(toks.includes('auth'));
  assert.ok(toks.includes('api'));
  assert.ok(!toks.some((t) => t.includes('canary')), 'secret leaked into tokens');
  assert.ok(!toks.some((t) => t.includes('corp')), 'email domain leaked into tokens');
});

test('tokenize drops stopwords, short tokens, and pure numbers', () => {
  assert.deepEqual(tokenize('the a I to add 42 refactor'), ['refactor']);
});

test('redact hardening: connection strings, key=value, IPs, UUIDs, opaque keys, PEM', () => {
  const leaks: Array<[string, string]> = [
    ['redis://:hunter2pass@localhost:6379/0', 'hunter2pass'],
    ['mongodb://root:Pa55word@cluster', 'pa55word'],
    ['postgres://admin:s3cr3tpw@db.example.com/app', 's3cr3tpw'],
    ['set password=Tr0ub4dor3 in config', 'tr0ub4dor3'],
    ['token: xkd9Qm2vLp8Rn4Ts here', 'xkd9qm2vlp8rn4ts'],
    ['server at 192.168.10.42 done', '192.168.10.42'],
    ['record 550e8400-e29b-41d4-a716-446655440000 lookup', '550e8400'],
    ['unknown key Ab12Cd34Ef56Gh78Ij90Kl12 value', 'ab12cd34ef56gh78ij90kl12'],
    ['aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE done', 'wjalrxutnfemi'],
    ['-----BEGIN RSA PRIVATE KEY----- MIIBcontent -----END RSA PRIVATE KEY-----', 'miibcontent'],
  ];
  for (const [input, secret] of leaks) {
    const toks = tokenize(input);
    assert.ok(!toks.some((t) => t.includes(secret)), `"${secret}" leaked from "${input}" -> ${JSON.stringify(toks)}`);
  }
});

test('redact hardening keeps legitimate task keywords and short alnum signal', () => {
  assert.deepEqual(tokenize('fix the css flexbox layout'), ['fix', 'css', 'flexbox', 'layout']);
  assert.deepEqual(tokenize('use oauth2 sha256 gpt5'), ['oauth2', 'sha256', 'gpt5']);
});

test('fingerprint caps at K and ranks by frequency then alpha', () => {
  const tokens = [
    'auth', 'auth', 'auth', 'api', 'api',
    'jwt', 'token', 'login', 'cache', 'redis', 'queue', 'worker',
  ];
  const fp = fingerprint(tokens);
  assert.ok(fp.length <= FINGERPRINT_K, 'fingerprint exceeded K');
  assert.equal(fp[0], 'auth');
  assert.equal(fp[1], 'api');
});

test('deriveSessionIntent: real text yields hasText with an auth fingerprint', () => {
  const i = deriveSessionIntent('Add JWT authentication and login to the REST API');
  assert.equal(i.hasText, true);
  assert.ok(
    i.fingerprint.includes('authentication') || i.fingerprint.includes('jwt'),
    'auth terms missing from fingerprint',
  );
  assert.ok(i.label.length > 0);
});

test('deriveSessionIntent: no usable text falls back to activity + tools', () => {
  const i = deriveSessionIntent('', { activity: 'testing', tools: ['Bash', 'mcp__server__run_tests'] });
  assert.equal(i.hasText, false);
  assert.ok(i.fingerprint.includes('testing'));
  assert.ok(i.fingerprint.includes('run_tests'), 'mcp prefix should be normalized off');
});

test('fnv1a is deterministic and discriminates', () => {
  assert.equal(fnv1a('auth|api|jwt'), fnv1a('auth|api|jwt'));
  assert.notEqual(fnv1a('auth'), fnv1a('api'));
});
