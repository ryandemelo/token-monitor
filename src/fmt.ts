/**
 * Formatting helpers with no dependencies of their own.
 *
 * `fmtTokens` used to live in report.ts, which imports the whole rendering
 * and recommendation stack. Rules build their own evidence labels, so keeping
 * the formatter here is what lets `src/rules/*` stay leaf modules instead of
 * importing the renderer that renders them.
 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
