# token-monitor

Measure how effectively your team spends AI coding-agent tokens — locally, with zero setup.

Most token dashboards tell you *how much* you spent. token-monitor tells you *what you spent it on* — separating thinking and defining from actual coding, testing, and shipping — and what to change. It parses the session logs that Claude Code, Gemini CLI, and Codex already write to your machine. No API keys, no server, no telemetry.

```
Where the tokens go (activity share of input+output)

  thinking      ████████░░░░░░░░░░░░░░░░  31.5%  33.5M   18087
  exploration   ████░░░░░░░░░░░░░░░░░░░░  18.0%  19.1M   19067
  coding        █████░░░░░░░░░░░░░░░░░░░  21.6%  22.9M    7351
  testing       ░░░░░░░░░░░░░░░░░░░░░░░░   1.2%   1.3M    1407
  shipping      █░░░░░░░░░░░░░░░░░░░░░░░   2.7%   2.8M    2064

  rework ratio 17.1%  ·  think:code 2.30

  Project     Tokens  Cost      Cache  Rework  Persona
  ─────────   ──────  ────────  ─────  ──────  ───────────
  checkout-api   12.4M   $2104     97%    13%     📐 Architect
  etl-pipeline    5.0M    $730     96%    60%     🚒 Firefighter
```

## Quick start

Requires Node.js ≥ 24 (uses the built-in `node:sqlite` — zero runtime dependencies).

```sh
git clone https://github.com/<you>/token-monitor && cd token-monitor
npm install && npm run build

node dist/cli.js collect    # scan local agent logs into ~/.token-monitor/
node dist/cli.js report     # activity breakdown, personas, recommendations
```

## What it measures

| Metric | Why it matters |
|---|---|
| **Activity breakdown** | Each turn is classified by its tool calls: *thinking/defining* (plan mode, reasoning-only turns), *exploration* (read/search), *coding* (edits), *testing* (test runners), *shipping* (commit/push/PR), *conversation*. |
| **Cache hit ratio** | Cache reads cost ~10% of fresh input — the single biggest cost lever. Low ratios point at session and prompt-structure problems. |
| **Rework ratio** | Share of tokens spent on code/test turns *after* the first test failure in a session. High rework usually means skipped planning. |
| **Think:code ratio** | Planning+exploration tokens per coding token. Too low correlates with high rework. |
| **Model mix** | Premium-model tokens on turns a cheaper tier would handle. |
| **Estimated cost** | API-equivalent USD from a built-in price table (`src/pricing.ts`). Non-Anthropic prices are placeholders marked `~` — edit to match your contract. |

## Personas

Aggregate metrics are assigned a behavioral archetype, each with tailored recommendations:

| Persona | Signature |
|---|---|
| 📐 **Architect** | Plans up front, low rework downstream |
| 🔪 **Surgeon** | High cache reuse, targeted exploration, minimal waste |
| 🧭 **Explorer** | Most tokens go to reading/searching before changes land |
| 🏃 **Sprinter** | Straight to code, minimal planning, rework eats the savings |
| 🚒 **Firefighter** | Heavy test-fail-fix loops |
| ⚖️ **Balanced** | No dominant pattern |

Personas are computed per-project and overall, so one expensive workflow can't hide in the average.

## Supported agents

| Agent | Source | Status |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | ✅ Verified — per-turn tokens, cache split, model, tools, git branch |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/*.json` | ✅ Verified — per-turn tokens incl. thoughts, tool calls |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` | ⚠️ Experimental — diffs cumulative `token_count` events; verify against Codex's own usage screens |

Adapters skip gracefully when a tool isn't installed.

## Team usage

Each developer runs `collect` + `report --json` locally; the JSON contains aggregate metrics only (no prompts, no code), so it's safe to share for a team rollup. A `team.yaml` discipline mapping and merge command are on the roadmap.

## CLI

```
token-monitor collect [--source claude-code|gemini-cli|codex] [--db <path>]
token-monitor report  [--days 30] [--project <name>] [--source <name>] [--json] [--db <path>]
```

## Contributing an adapter

The most valuable contribution: support for another agent CLI (Aider, OpenCode, Cursor…).

1. Add `src/adapters/<name>.ts` exporting a function that parses the tool's local logs into `UsageEvent[]` (see `src/types.ts` — per-turn tokens, tool names, shell commands for activity classification).
2. Register it in `src/adapters/index.ts`.
3. Adapters must return zero events with a `note` when the tool isn't installed.

The classifier (`src/classify.ts`) already recognizes common tool names across vendors; extend its sets if yours differ.

## Roadmap

- [ ] `team.yaml` discipline mapping (frontend/backend/data/QA) + `merge` command for team rollups
- [ ] Static HTML dashboard
- [ ] Follow-through tracking: store recommendations with a baseline, re-measure the delta next period
- [ ] Adapters: Aider, OpenCode, Cursor
- [ ] Org-level cross-check via provider usage APIs

## Privacy

Everything stays on your machine. token-monitor reads log files locally, stores aggregate numbers in a local SQLite file, and never makes a network request. Prompt and code content is never stored — only token counts, tool names, timestamps, and project/branch names.

## License

MIT
