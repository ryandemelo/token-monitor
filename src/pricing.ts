/**
 * Prices in USD per million tokens. Anthropic prices are current as of
 * 2026-06 (cache read ≈ 0.1× input, cache write ≈ 1.25× input for the
 * default 5-minute TTL). Entries with `estimated: true` are placeholders —
 * edit them to match your vendor's current price sheet.
 */
export interface ModelPrice {
  match: RegExp;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estimated?: boolean;
}

export const PRICES: ModelPrice[] = [
  { match: /claude-fable-5|claude-mythos-5/, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: /claude-opus-4/, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /claude-sonnet-4/, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /claude-haiku-4/, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Placeholders — verify against the vendor price sheet before trusting cost figures.
  { match: /gemini-.*-pro/, input: 2.5, output: 15, cacheRead: 0.31, cacheWrite: 2.5, estimated: true },
  { match: /gemini-.*-flash/, input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5, estimated: true },
  { match: /gpt-5|codex/, input: 1.75, output: 14, cacheRead: 0.18, cacheWrite: 1.75, estimated: true },
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
