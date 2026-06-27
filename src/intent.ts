/**
 * On-device intent derivation — the privacy floor of `categorize`.
 *
 * Raw user-prompt text is redacted and reduced to a bounded keyword fingerprint
 * HERE, before anything is persisted, clustered, or printed. Nothing downstream
 * ever sees the raw prompt: `categorize` stores only the ≤8-token fingerprint
 * plus a short top-terms label — never a free-text sentence column.
 *
 * redact() strips structured secrets of KNOWN SHAPE (emails, any-scheme URIs and
 * connection strings, file paths, PEM blocks, labelled `key=value` secrets,
 * prefixed API keys, JWTs, IP addresses, UUIDs, long digit/hex/base64 runs);
 * tokenize() then drops high-entropy key/hash-shaped survivors. This is
 * defence-in-depth, not a guarantee: a novel secret that looks exactly like an
 * ordinary word can still survive — which is why only redacted keyword LABELS
 * (never prose) are kept, and multi-session cluster names prefer shared terms
 * over rare one-offs so a survivor is unlikely to surface as a public label.
 */
import { norm } from './classify.js';

// Redaction patterns. Order matters: structured/credential-bearing spans are
// removed whole before the generic base64/hex/digit catch-alls.
const PEM_RE = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;
// Any scheme://… URI, including credential-bearing connection strings
// (postgres://user:pass@host, redis://:pw@localhost, ssh://…). URIs are never
// task keywords, so dropping the whole run is safe.
const URI_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const WWW_RE = /\bwww\.[^\s]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// Labelled secret: `password=…`, `token: …`, `api_key = …` → drop the value.
const ASSIGN_SECRET_RE =
  /\b(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|credential|auth|bearer)s?\s*[:=]\s*\S+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const SECRET_RE =
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[baprs]|AKIA|ASIA|AIza|ya29|Bearer)[-_A-Za-z0-9]{6,}\b/gi;
const PATH_RE = /(?:[A-Za-z]:)?(?:[\\/][\w.+-]+){2,}[\\/]?/g; // unix + windows paths
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\b/gi;
const BASE64_RE = /\b[A-Za-z0-9+/]{20,}={0,2}\b/g; // long base64 / opaque secret runs
const HEX_RE = /\b[0-9a-f]{16,}\b/gi; // hashes / hex secrets
const DIGITS_RE = /\b\d{7,}\b/g; // long digit runs (ids, card-ish numbers)

/** Strip structured secrets/identifiers on-device. Runs before tokenize. */
export function redact(text: string): string {
  return text
    .replace(PEM_RE, ' ')
    .replace(URI_RE, ' ')
    .replace(WWW_RE, ' ')
    .replace(EMAIL_RE, ' ')
    .replace(ASSIGN_SECRET_RE, ' ')
    .replace(JWT_RE, ' ')
    .replace(SECRET_RE, ' ')
    // Before PATH_RE: opaque keys may contain '/' (AWS secret keys), so catch the
    // whole high-entropy run before path-splitting fragments it.
    .replace(BASE64_RE, ' ')
    .replace(PATH_RE, ' ')
    .replace(UUID_RE, ' ')
    .replace(IPV4_RE, ' ')
    .replace(IPV6_RE, ' ')
    .replace(HEX_RE, ' ')
    .replace(DIGITS_RE, ' ');
}

/**
 * Heuristic: does this surviving token look like a key/hash/id rather than a
 * word? Long mixed letter+digit runs and hex-ish id fragments are dropped so
 * unknown-prefix secrets don't reach the fingerprint. Short alnum terms with
 * real signal (oauth2, sha256, utf8, gpt5) are kept.
 */
function looksLikeSecret(t: string): boolean {
  if (t.length >= 12 && /[a-z]/.test(t) && /[0-9]/.test(t)) return true;
  if (t.length >= 8 && /^[0-9a-f]+$/.test(t) && /[0-9]/.test(t)) return true;
  return false;
}

// Common English + instruction filler that carries no task signal. Task verbs
// that DO carry signal (test, fix, refactor, debug, deploy) are deliberately kept.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'with', 'from', 'into', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
  'must', 'i', 'we', 'you', 'it', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'its',
  'me', 'us', 'please', 'want', 'wants', 'need', 'needs', 'make', 'makes', 'use', 'using', 'used',
  'add', 'adds', 'added', 'adding',
  'get', 'gets', 'got', 'set', 'help', 'let', 'lets', 'also', 'so', 'not', 'no', 'yes', 'have',
  'has', 'had', 'here', 'there', 'what', 'which', 'when', 'where', 'how', 'why', 'all', 'any',
  'some', 'more', 'most', 'very', 'just', 'like', 'about', 'up', 'down', 'out', 'over', 'than',
  'too', 'one', 'two', 'now', 'via', 'per', 'etc', 'eg', 'ie', 'currently', 'currentl', 'able',
]);

/** Redact, lowercase, split, drop stopwords/short/pure-number tokens. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of redact(text).toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^[.+#]+|[.+#]+$/g, '');
    if (t.length < 3 || t.length > 30) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (looksLikeSecret(t)) continue;
    out.push(t);
  }
  return out;
}

export const FINGERPRINT_K = 8;

/** Top ≤K terms by frequency (alpha tie-break) — the only thing we persist. */
export function fingerprint(tokens: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, FINGERPRINT_K)
    .map(([t]) => t);
}

/** First up-to-3 fingerprint terms — a glanceable category name. */
export function labelOf(fp: string[]): string {
  return fp.slice(0, 3).join(' ') || 'misc';
}

/** FNV-1a (deterministic, zero-dep) — stable ids for intents/clusters. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface SessionIntent {
  /** ≤8 redacted keyword tokens — the persisted, labels-only fingerprint. */
  fingerprint: string[];
  /** Short top-terms label. */
  label: string;
  /** True when derived from real user text; false for a tool/activity fallback. */
  hasText: boolean;
}

/**
 * Derive one session's intent from its (already on-device) user text. When the
 * session has no usable text — tool-only turns, or a non-text adapter — fall
 * back to the coarse activity + normalized tool names. Never calls an LLM.
 */
export function deriveSessionIntent(
  text: string,
  fallback: { activity?: string; tools?: string[] } = {},
): SessionIntent {
  const tokens = text ? tokenize(text) : [];
  if (tokens.length >= 2) {
    const fp = fingerprint(tokens);
    return { fingerprint: fp, label: labelOf(fp), hasText: true };
  }
  const toolToks = (fallback.tools ?? []).map(norm).filter((t) => t.length >= 3);
  const act = fallback.activity || 'work';
  const fp = fingerprint([act, ...toolToks]);
  return { fingerprint: fp, label: labelOf(fp), hasText: false };
}
