---
description: Collect local agent logs and walk through where this month's tokens went
---

Run token-monitor over the user's local agent session logs and explain the result.

1. Run `npx -y @ryandemelo/token-monitor collect` (idempotent; safe to re-run). If `token-monitor` is already on PATH, use that instead — it is faster and pinned.
2. Run `npx -y @ryandemelo/token-monitor report --trend`.
3. Summarize for the user, in this order:
   - the headline: spend, cost, cache hit ratio, and the coverage line (a window with gaps must be stated, not glossed over);
   - the activity breakdown — what the tokens bought (thinking, exploration, coding, testing, shipping);
   - the persona and the top two or three recommendations, each with the savings estimate and the evidence sessions the tool cited;
   - the trend arrows, and say plainly when the tool reports `insufficient data` rather than inventing a direction.

Rules:
- Report the numbers the tool produced. Do not re-derive, re-estimate, or round them into something more flattering.
- Figures marked `~` are estimates (placeholder prices, or estimated token counts for sources that do not report them). Keep the mark when you quote them.
- If Node is older than 24 or the collect finds nothing, say so and stop — do not guess at usage.
