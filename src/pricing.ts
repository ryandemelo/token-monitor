/**
 * Prices in USD per million tokens. Anthropic prices are current as of
 * 2026-06 (cache read ≈ 0.1× input, cache write ≈ 1.25× input for the
 * default 5-minute TTL); Gemini and OpenAI rows pinned 2026-06-12 against
 * the official price pages (sources in the table comment). Entries with
 * `estimated: true` are placeholders or assumptions — edit them to match
 * your vendor's current price sheet or contract.
 */
export interface ModelPrice {
  match: RegExp;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estimated?: boolean;
}

// Order matters: first matching row wins, so generation-specific rows come
// before the catch-alls. Gemini/OpenAI rows pinned 2026-06-12 from
// https://ai.google.dev/gemini-api/docs/pricing and
// https://developers.openai.com/api/docs/pricing (standard tier, ≤200k
// context where vendors price by tier). Gemini bills cache *storage* per
// hour rather than per write-token, and OpenAI doesn't bill cache writes —
// cacheWrite is 0 for both (their adapters report cacheCreationTokens 0).
export const PRICES: ModelPrice[] = [
  { match: /claude-fable-5|claude-mythos-5/, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: /claude-opus-4/, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /claude-sonnet-4/, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /claude-haiku-4/, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },

  { match: /gemini-3\.5-flash/, input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  { match: /gemini-3.*-pro/, input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  // Also matches Antigravity's internal ids (gemini-3-flash-a) and previews.
  { match: /gemini-3-flash/, input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  { match: /gemini-2\.5-pro/, input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { match: /gemini-2\.5-flash-lite/, input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  { match: /gemini-2\.5-flash/, input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },

  { match: /gpt-5\.5-pro/, input: 30, output: 180, cacheRead: 3, cacheWrite: 0, estimated: true }, // cacheRead unpublished, 10% assumed
  { match: /gpt-5\.5/, input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  // Original gpt-5-codex (2025-09): delisted from the official page; last published rate.
  { match: /gpt-5-codex/, input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, estimated: true },
  { match: /gpt-5\.\d+-codex/, input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },

  // Catch-alls for generations not listed above — placeholders, verify before trusting.
  { match: /gemini-.*-pro/, input: 2.5, output: 15, cacheRead: 0.31, cacheWrite: 0, estimated: true },
  { match: /gemini-.*-flash/, input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0, estimated: true },
  { match: /gpt-5|codex/, input: 1.75, output: 14, cacheRead: 0.18, cacheWrite: 0, estimated: true },
];

export interface Cost {
  usd: number;
  estimated: boolean;
  /** false when the model had no price entry — tokens counted, cost unknown. */
  priced: boolean;
}

export function costOf(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): Cost {
  const p = PRICES.find((p) => p.match.test(model));
  if (!p) return { usd: 0, estimated: false, priced: false };
  const usd =
    (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) /
    1_000_000;
  return { usd, estimated: !!p.estimated, priced: true };
}
