# token-monitor

[![CI](https://github.com/ryandemelo/token-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/ryandemelo/token-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![good first issues](https://img.shields.io/github/issues/ryandemelo/token-monitor/good%20first%20issue?label=good%20first%20issues&color=7057ff)](https://github.com/ryandemelo/token-monitor/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

Measure how effectively your team spends AI coding-agent tokens — locally, with zero setup.

Most token dashboards tell you *how much* you spent. token-monitor tells you *what you spent it on* — separating thinking and defining from actual coding, testing, and shipping — and what to change. It parses the session logs that Claude Code, Gemini CLI, Codex, Cursor, Antigravity, and Copilot Chat already write to your machine. No API keys, no server, no telemetry.

```
Where the tokens go (activity share of input+output)

  thinking      ████████░░░░░░░░░░░░░░░░  31.5%  33.5M   18087
  exploration   ████░░░░░░░░░░░░░░░░░░░░  18.0%  19.1M   19067
  coding        █████░░░░░░░░░░░░░░░░░░░  21.6%  22.9M    7351
  testing       ░░░░░░░░░░░░░░░░░░░░░░░░   1.2%   1.3M    1407
  shipping      █░░░░░░░░░░░░░░░░░░░░░░░   2.7%   2.8M    2064

  rework ratio 17.1%  ·  think:code 2.30

  Project        Tokens  Cost      Cache  Rework  Persona
  ────────────   ──────  ────────  ─────  ──────  ───────────
  checkout-api   12.4M   $2104     97%    13%     📐 Architect
  etl-pipeline    5.0M    $730     96%    60%     🚒 Firefighter
```

## Quick start

Requires Node.js ≥ 24 (uses the built-in `node:sqlite` — zero runtime dependencies).

```sh
npx @ryandemelo/token-monitor collect   # scan local agent logs
npx @ryandemelo/token-monitor report    # activity breakdown, personas, recommendations
npx @ryandemelo/token-monitor html      # self-contained dashboard -> report.html
```

Persistent install: `npm install -g @ryandemelo/token-monitor`, then `token-monitor <command>`. For development: clone, `npm install && npm test`.

### Or let your coding agent install it

Paste this into Claude Code, Gemini CLI, or any coding agent:

> Install token-monitor from https://github.com/ryandemelo/token-monitor (instructions in its AGENTS.md), run `collect` and `report`, and walk me through what my token usage says.

The repo ships [`AGENTS.md`](AGENTS.md) and [`llms.txt`](llms.txt) so agents can install and operate it without guesswork.

## What it measures

| Metric | Why it matters |
|---|---|
| **Activity breakdown** | Each turn is classified by its tool calls: *thinking/defining* (plan mode, reasoning-only turns), *exploration* (read/search), *coding* (edits), *testing* (test runners), *shipping* (commit/push/PR), *conversation*. |
| **Cache hit ratio** | Cache reads cost ~10% of fresh input — the single biggest cost lever. Low ratios point at session and prompt-structure problems. |
| **Rework ratio** | Share of tokens spent on code/test turns *after* the first failed turn in a session. High rework usually means skipped planning. Distinct from `analyze`'s **fix iterations**, which counts testing→coding transitions — sessions that barely test can have high rework but zero visible fix loops. User-declined permission prompts are *not* counted as failures. |
| **Think:code ratio** | Planning+exploration tokens per coding token. Too low correlates with high rework. |
| **Model mix** | Premium-model tokens on turns a cheaper tier would handle. |
| **Subagent share** | Spend from Task/Agent fan-out rather than the main loop. Descriptive, not a verdict — but every other number is wrong without it, and a fan-out of 40 agents still counts as the one session someone actually had. |
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
| **Claude Code** | `~/.claude/projects/**/*.jsonl`, incl. `<session>/subagents/**/agent-*.jsonl` | ✅ Verified — per-turn tokens, cache split, model, tools, git branch, **subagent runs** |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/*.json` | ✅ Verified — per-turn tokens incl. thoughts, tool calls |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` | ⚠️ Experimental — diffs cumulative `token_count` events; verify against Codex's own usage screens |
| **Cursor** | `Cursor/User/globalStorage/state.vscdb` (SQLite) | ✅ Verified — per-turn tokens on completed turns, tool calls, agent/chat sessions. Cursor doesn't persist cache tokens or the resolved backend model (Auto mode reports as `cursor-auto`) |
| **Antigravity CLI** | `~/.gemini/antigravity-cli/conversations/*.db` (SQLite + protobuf) | ✅ Verified — per-call prompt/cached/output tokens, per-row model, tool steps, workspace + branch. Vendor-internal format: fails soft if the schema changes |
| **Copilot Chat** (VS Code) | `Code/User/workspaceStorage/*/chatSessions/*` | ⚠️ Experimental — Copilot doesn't record token usage locally, so counts are **estimated** from text length (~4 chars/token) and models are suffixed `(est)`. Turn counts, timestamps, tools, and errors are real |

Adapters skip gracefully when a tool isn't installed. The Cursor adapter reads only composer/bubble keys — never the auth entries that live in the same database.

**Subagent coverage.** Claude Code writes each Task/Agent run to its own transcript under the session directory, and the main transcript never mentions what those runs spent. token-monitor reads them: on the maintainer's own 30-day window that is 24% of spend across 2,027 runs — invisible to every version before 0.13, and to any tool that reads only the top level. The format is vendor-internal and undocumented, so parsing is fail-soft (a reshaped or unreadable agent file costs its own turns, never the collect). Only Claude Code is known to persist this; the other five sources report no sidechain data, so their subagent share reads as absent rather than zero.

## Claude Code plugin

```
/plugin marketplace add ryandemelo/token-monitor
/plugin install token-monitor
```

Adds `/token-report`, `/token-context` and `/token-rules`, plus a skill that teaches the agent the whole workflow — including the rules that matter: quote the numbers the tool produced, keep the `~` on estimates, treat absent as absent rather than zero, and never move tool or MCP-server names off the machine.

An **opt-in** `SessionStart` hook can name the rules currently firing on your own data. It is silent until you turn it on (`touch ~/.token-monitor/session-hint`), never runs a collect, never touches the network, and fails open. The plugin is a thin wrapper over the CLI — the same contract the IDE extension follows.

## IDE extension

[`extension/`](extension/) ships a VS Code-family extension (works in VS Code, Cursor, Windsurf, Antigravity): status-bar tokens/cost for the current project and the dashboard in a webview, both powered by the CLI. Install **[Token Monitor](https://marketplace.visualstudio.com/items?itemName=ryan653133.token-monitor)** from the VS Code Marketplace (search "token-monitor"), or grab the `.vsix` from the latest release and use *Extensions: Install from VSIX…*

## Team usage

### Remote rollout (lead → team)

The lead hosts one config file anywhere (gist, internal wiki, S3) and sends one line — pasteable by the dev, an MDM/onboarding script, or their coding agent:

```sh
npx @ryandemelo/token-monitor init --from https://example.com/team-config.json
```

```jsonc
// team-config.json
{
  "teamName": "acme-eng",
  "push": { "type": "http", "url": "https://reports.example.com/token-monitor" },
  // or: "push": { "type": "path", "dir": "/Volumes/shared/token-monitor" }
  "scheduleHours": 24,
  "windowDays": 30
}
```

`init` saves the config, generates the signing keypair, runs the first collection, installs the recurring collect+push job (launchd on macOS, cron on Linux), and prints the dev's fingerprint for the lead's `keys.json`. From then on signed exports arrive on schedule; the lead runs `merge <files> --verify --keys keys.json`. `token-monitor schedule --remove` uninstalls.

### Manual flow

Each developer exports locally; the JSON contains aggregate metrics only (no prompts, no code, no file paths beyond project basenames), so it's safe to share:

```sh
# each developer (exports/ is gitignored — keep real metrics out of repos)
mkdir -p exports
token-monitor collect && token-monitor report --json > exports/$(whoami).json

# team lead
cat > team.yaml <<'EOF'
alice: frontend
bob: backend
carol: data
EOF
token-monitor merge exports/*.json --team team.yaml
```

The team report shows per-discipline rollups: tokens, cost, cache hit, rework, think:code ratio, dominant activity, and persona — so you can see *which discipline* needs which intervention, not just a total bill.

### Org rollups (lead → org)

The same machinery scales to many teams with no server: every team's `push` targets **one drop** (shared dir or HTTP endpoint), and the org lead merges the signed files that land there. The member map can group by team:

```sh
cat > teams.yaml <<'EOF'
platform:
  alice: frontend
  bob: backend
data:
  carol: ml
EOF

token-monitor merge drop/*.json --team teams.yaml --by team   # or --by discipline
token-monitor merge drop/*.json --team teams.yaml --by team --html org.html
```

`--by` picks the comparison axis; `--html` also writes a self-contained org dashboard. Flat `team.yaml` files keep working unchanged.

Identity is the **signing fingerprint**, not the OS username: two different "ryan"s on different teams stay distinct, and when the same signer's exports show up more than once (stale files in the drop), only the newest is counted. With `--keys keys.json` the lead's pinned `user → fingerprint` map is also the naming authority — members are labeled by their enrolled name regardless of what their machine reports.

## Deep analysis & LLM-powered recommendations

`token-monitor analyze` goes a level deeper than the report — which sessions and habits burn the tokens:

- **Most expensive sessions** — turns, fix loops, avg context per turn, duration, dominant activity
- **Fix-loop sessions** — testing→coding churn
- **Context-heavy sessions** — average tokens fed per turn (context-bloat proxy)
- **Context bloat trend** — sessions whose late-half context grew ≥2× without cache reads keeping pace (start fresh / compact earlier)
- **Cold restarts** — turns resuming after the ~5-min cache TTL that re-paid their context as fresh input (batch prompts, split idle work)
- **Tool error rates** — tools that keep failing, plus the token cost of their retry loops
- **Subagent fan-out** — which sessions delegated, what their agent runs cost next to the driver's own turns, and the spend per subagent type (Claude Code only)

The report and dashboard surface the same signals in one line (context bloat, cold restarts, premium tokens on exploration/conversation, retry-loop spend, subagent share), and each one becomes a tracked recommendation when it crosses its threshold.

Fan-out is reported, not judged: delegating heavily can be exactly the right call, so there is no "too many subagents" finding. Read the ratio against what the fan-out produced. Subagent **type** names stay on your machine — a custom agent can be named after something private — so exports and `--llm` payloads carry the share and the counts only.

**Cache TTL.** Cold restarts are measured against the TTL a session actually used, not a fixed five minutes. Claude Code reports how each cache write was split between the 5-minute and 1-hour ephemeral tiers; a session whose writes are mostly 1-hour is scored against a 1-hour window, so a 20-minute pause stops being counted as a re-paid context it never was. The choice is made once per session — one number the report names and you can check — and anything without the split (every other source, and everything collected before 0.13) keeps the 5-minute assumption it was always measured under, so no historical number moves.

This matters more than a window-wide average would suggest. On the maintainer's own machine the main loop runs entirely on the 1-hour cache while every subagent run sits on the 5-minute one: averaged together that reads as "about half", which would have mis-scored every session in both directions. If your sessions are still on the 5-minute cache and keep resuming inside the hour, the cold-restart recommendation says so and prices enabling the extended cache net of its higher write premium.

Two signals are deliberately scoped to the main loop on **both** sides of their ratio: **context bloat** and **cold restarts**. Their remedies — compact, start fresh, batch prompts, split idle work — cannot be applied to a run that is spawned, works back-to-back and exits, and subagent runs outnumber conversations by roughly 14:1, so including them would bury a real hygiene problem in a denominator nobody can act on. Everything that measures *spend* — activity mix, cost, rework, retries, premium routing, per-project totals — counts subagent turns in full.

One-time re-basing: on the first collect after upgrading, spend-share metrics (rework, retry, premium) and **cache hit ratio** step because their denominators finally include the fan-out. If you are tracking a recommendation through follow-through across that boundary, treat that single move as a measurement correction, not as your intervention working.

Add `--llm` and the aggregates go to a coding agent you already have installed (`claude`, `gemini`, or `codex` — auto-detected, override with `--agent`), which returns prioritized interventions with the evidence, the workflow change, and the metric to watch:

```sh
token-monitor analyze --llm
```

No API key management: it reuses your existing agent CLI and its subscription. The payload is the same aggregates-only data as `report --json` (token counts, ratios, tool names, project basenames — never prompts or code). It does leave your machine via that agent's provider, so skip `--llm` if even project names are sensitive.

## Context economics: what you pay before a turn does anything

Every other number here prices what a turn *did*. `token-monitor context` prices what it had to **carry**:

```
Session floor 78.0k tokens (median of the smallest context each of 64 main-loop sessions ran with) — 17% of main-loop context spend

Tool-result carry (what returned payloads cost while they ride along)
  ~3.3B carried tokens from ~27.8M returned — 15% of all input-side tokens, ~$1630 at cache-read rates

  Tool                     Calls  Returned  Avg carried  Carried tok  Cost
  ─────────────────────    ─────  ────────  ───────────  ───────────  ────────
  Bash                     41611  ~19.4M    186.1 turns  ~2.2B        ~$1099.62
  Read                      2314  ~8.1M     117.0 turns  ~956.5M      ~$479.69

MCP servers
  Server        Tools  Turns  Spend  Cost   Errors  Returned  Last used
  ───────────   ─────  ─────  ─────  ─────  ──────  ────────  ─────────
  search            7     16  11.4k  $6.20  —       ~16.1k    2026-08-10

  ⚠ 3 connected server(s) were never invoked in this window: …
```

Three measurements, all from logs you already collected:

- **Session floor** — the smallest context a session ever runs with: system prompt, the tool definitions of every connected MCP server, loaded skills, `CLAUDE.md` and its imports. Written once, re-read every turn after. It is not waste — it is what makes the agent useful — but it is the number that moves permanently every time you connect a server or load a skill pack, and `report --trend` carries a row for it so you can see it creep. Measured over main-loop sessions only, as a median so one enormous resumed session can't set it.
- **Tool-result carry** — a result is not paid once. It enters the context and is re-read in every later request of that session, so a 40k-token search result on turn 3 of a 30-turn session is carried ~27 more times. The remedy is usually a flag, not a workflow change: bound the output, page the MCP call, or hand the payload to a subagent whose context ends with it.
- **Per-MCP-server spend** — turns, cost, error rate and returned bytes per server, plus the servers that are **connected and never invoked**, which are still paying for their tool definitions on every single request. Usage is not value: a server called twice may have saved an afternoon. A server called zero times is paying rent.

Both context signals appear on the one-line summary in `report` and the dashboard, and two rules (`tool-result-bloat`, `context-floor-creep`) fire on them with priced savings.

**Honesty.** Result sizes are estimated from characters (~4 chars/token) and marked `~`. A result counts as carried until its session ends or its context collapses — compaction and `/clear` aren't written to the transcript, but the drop they cause is measurable, and that is where the carry is cut — and the total is clamped per session to the input-side tokens that session actually paid, so it can never claim more context than was provably bought. Claude Code is currently the only source that persists tool results; every other source reports carry as **unmeasured**, never as zero.

**Privacy.** Tool and MCP server names are shown by `context` and stay on the machine. They can name a client, an internal system or a private endpoint, so — exactly like subagent type names — they never enter an export, a signed payload, or an `--llm` payload; the LLM payload's tool-error rows are redacted to `mcp:<tool>`. Connected servers are read from the local agent config by **key only**: a server's command, arguments and environment are never parsed or stored.

## Skill ROI: did codifying it actually work?

`categorize` ends every duplicate-work finding with the same advice — *codify it as a shared skill instead of re-deriving it*. This closes that loop.

```
Skill adoption

  Skill            Sessions  Turns  First seen  Last used
  ───────────────  ────────  ─────  ──────────  ──────────
  invoice-helper         43   2976  2026-08-08  2026-08-22

  ⚠ 1 skill(s) used historically but not once in this window: old-thing

Did codifying it work? (category recurrence before → after the skill)

  Skill           Category            Link   Before/30d  After/30d  Realized    Status
  ──────────────  ──────────────────  ─────  ──────────  ─────────  ──────────  ───────────
  invoice-helper  invoice ledger …    map    4.2         1.1        ~$310/mo    ✅ realized
```

Two things it refuses to do, both learned from running it on real data:

- **A name match is a candidate, not a cause.** Automatic links show the before/after numbers and **never** a dollar figure — nothing in the transcripts says a skill was written to absorb a category's work. You assert that in `~/.token-monitor/skill-map.json` (`{"category name": "skill"}`), and only a mapped link unlocks the estimate. The first version linked on any shared word and confidently priced a `code-review` skill against three unrelated categories.
- **Slash-command markers are not skill invocations.** They exist in the transcripts and are dominated by built-ins — `/effort`, `/model`, `/compact`. Reading them as skills would report `/compact` as your most-adopted skill. Only the harness's own skill attribution is used.

Even a mapped link needs recurrence to have *fallen*, the skill to have been *used* in the window, and at least three sessions before it appeared. A category can also fade because a project ended — this is correlation, and the figure is the recurrence delta times the category's average session cost.

Attribution marks **turns**, not invocations: one use of a skill attributes every turn it stays active for, so sessions are the adoption number and turns are the volume. Only Claude Code records this today; other sources report nothing rather than zero. **Skill names are local display only** — never exported, signed, or sent to an LLM.

## Outcomes: what the tokens bought

Every other metric here is denominator-less. Outcomes add the missing half:

```
outcomes: 34/67 sessions reached a ship signal (51%)  ·  ~$456.32 per shipped session  ·  308.5k tok in 4 idle unshipped stream(s)
```

- **Shipped share** — a session ships when it has a shipping turn (`git commit`/`push`, `gh pr`, `git merge` — already classified on every source) or a linked pull request. Claude Code records PR links in its transcripts; they are counted per session and de-duplicated, and the repo name and URL are discarded at the adapter.
- **Cost per shipped session** — the blunt, honest unit economics. No attribution theater.
- **Unshipped work** — spend in *streams* (a project plus a branch) that wrote code, reached no ship signal, and have since sat idle. `analyze` lists them.

Three guards, because this is the metric most likely to be misread:

1. **Streams, not sessions.** Coding Monday and shipping Wednesday from a new session is one stream that shipped. Sources without branch information fall back to per-session grouping and say so.
2. **Never work in flight.** A stream touched recently is reported as **open** and excluded from the finding entirely.
3. **Main loop, coding only.** A subagent run ships through its caller; a stream that never wrote code was never trying to ship.

Research, spikes and learning ship nothing by design and are not waste. The metric answers exactly one question — how much of this window's spend reached a ship signal — and the `abandoned-work` rule fires only on repeated, idle, code-bearing streams.

**Privacy.** Branch names are shown by `analyze` on your machine and never leave it: they name features and clients, the same class as file paths. Exports and `--llm` payloads carry shares and counts only.

## Seat value (subscription lens)

Every dollar figure here is **API-equivalent** — what the same tokens would have cost at API rates. Most people run coding agents on a seat, where that number answers nothing on its own. `--plan` converts it:

```sh
token-monitor report --plan max-20x        # add --annual for annual-billing rates
```

```
Seat value

  API-equivalent ~$412/mo against a $200/mo Max 20x — ≈2.1× the seat price. The seat is returning well over what it costs.
```

Under-utilization gets the inverse framing (`≈0.3× — a lower tier may fit, if the headroom is not what you are paying for`), and a window under a week says so instead of quoting a ratio it can't support.

The plan name rides along in `report --json` / `push` as a self-declared field, so a lead's `merge` shows seat value per member plus one org line — *"$1,240/mo of API-equivalent work on $600/mo of seats"*. Members who declare nothing show `—`; nobody is assumed onto the lead's tier.

Prices live in [`src/plans.ts`](src/plans.ts), checked against claude.com/pricing on 2026-08-22 and meant to be edited to match your contract. Anything the public page doesn't state outright is marked and says why.

**This is not a quota tracker.** Plan limits are multipliers over shifting baselines with their own windows, and nothing local can read them. Vendoring a guess would produce confident-looking wrong numbers, so the tool prices seats and stops there.

## Data completeness

Agent tools rotate their logs — Claude Code deletes transcripts after `cleanupPeriodDays` (default 30) — so a window can be full of holes without anything saying so. Every report now opens with what it actually covers:

```
coverage: claude-code 26/30d ⚠ · 4d gap
```

Three things follow from it. A window reaching past retention gets an explanation rather than a shrug — *"history before ~35d ago was likely deleted by Claude Code's 30-day retention before it could be collected"* — worded as a likelihood, and only when the record actually runs out where deletion would have cut it. `report --trend` **suppresses its arrows** when the previous window has materially less data than the current one, printing `insufficient data` instead: an arrow drawn across a collection gap measures the gap, not your behavior, and a false "improving" costs more than a missing verdict. And exports carry per-source day counts and dates, so a lead's `merge` can flag a member whose scheduled push is still arriving faithfully while their adapter has collected nothing for weeks — previously indistinguishable from a genuinely quiet member.

Coverage is counts and dates only. A quiet day is not proof of missing data, and the report says so rather than guessing.

## Relay waste

Every other signal here is single-session. `relay` looks at the waste *between* them: a prompt whose text substantially repeats an earlier session's output — the answer from one session hand-pasted into the next, often into a different agent.

```sh
token-monitor relay --days 30
```

```
23.2k words of prompt text were carried over from an earlier session
(1.8% of everything typed or pasted, $0.15 re-paid as fresh input)

  From      To        Overlap  Words  Gap  Route
  ────────  ────────  ───────  ─────  ───  ───────────
  f0bc06ca  7fa86ed5  100%     1.2k   0d   claude-code
  3c2923b6  254351ff  100%     1.1k   0d   claude-code
```

**The dollar figure is deliberately not the headline.** Re-paying a thousand words as fresh input costs cents; measured on the maintainer's own month it came to $0.15. What the number is good for is finding the *handoffs* — text a person moved by hand is work the toolchain could have passed along directly, and the duplicated effort around it is where the real spend goes. Write the output to a file and point the next session at it, or let a subagent carry it.

Detection is offline and deterministic, like `categorize`. Comparison runs on hashed 8-word shingles: each session's output becomes a Bloom filter, and a later prompt is scored by how much of it that filter recognises. Prompt and response text is read in memory, redacted first, hashed, and dropped — it is never stored, printed, or sent, and exports carry shares and counts only. Fingerprints persist so a paste can still be traced after the source transcript has been deleted, which at a 30-day retention is well inside the window a handoff spans.

`--threshold` tunes how much overlap counts (default 0.35). The signal is strongly bimodal in practice — real pastes score near 100%, unrelated prompts near 5% — so the exact value rarely matters, and the detector is biased toward missing a relay rather than inventing one.

## Trends

`report --trend` compares the window against the previous same-length one — spend, cost, cache hit, rework, and the optimization signals, each with a direction arrow (green = improving, red = regressing), plus the top project movers by spend change. The HTML dashboard includes the trend automatically when two windows of data exist.

## Recommendations: evidence + savings

Every threshold-fired recommendation answers "why should I believe this and what is it worth": it cites the worst 3 sessions that triggered it (session ids, dates, token counts — aggregate-only, never content) and estimates the $/month saved if the metric hit its target, priced from **your own model mix** and the price table (`~` when estimated prices or a tier assumption are involved):

```
→ 43% of spend is premium-model tokens on exploration/conversation turns. …  ≈ $8060/mo
    worst: db0a7d17 (procurement, 2026-05-26, 1.8M premium on exploration/chat) · …
```

These show up in `report`, `analyze`, the HTML dashboard, and ride along in signed exports (`recommendationDetails`).

Each one comes from a **rule** — a single file under `src/rules/` holding its firing condition, its message, and the arithmetic that prices it. `token-monitor rules` lists the catalogue and marks which fire on your window; `token-monitor rules <key>` explains one:

```
  Rule                   Metric             Goal     Family   Savings
  ────────────────────   ────────────────   ──────   ───────  ───────────
⚠ low-cache-hit          cacheHitRatio      ↑ raise  caching  priced
· low-think-code         thinkToCodeRatio   ↑ raise  —        advice only
```

Adding a rule is one file, one fixture and one test — the smallest useful contribution, and the fastest way to encode a waste pattern you keep hitting. See [CONTRIBUTING.md](CONTRIBUTING.md#writing-a-waste-rule).

Three more pieces of intelligence:

- **Personalized targets** — with enough sessions, targets come from *your own* top-quartile sessions ("your best sessions already hit 92% cache") instead of static heuristics; thin data falls back to the static targets.
- **Honest combined math** — overlapping levers are grouped into families (caching / routing / rework) and de-overlapped, giving one headline: `Potential: $18.8k/mo → $8.9k/mo (routing −$9.2k · caching −$712)`. Recommendations sort by their marginal value.
- **Realized savings** — once a tracked recommendation's metric moves, follow-through prices the move: `Realized +$70/mo`. The advice proves (or disproves) its own worth.

## Follow-through

Recommendations are tracked, not just printed. The first time one fires, its target metric is recorded as a baseline; every later report re-measures and shows the delta:

```
Recommendation         Metric         Baseline  Now   Since       Status
high-rework            reworkRatio    24%       11%   2026-06-01  ✅ resolved
premium-model-overuse  premiumShare   99%       97%   2026-06-12  — tracking
```

Resolved findings re-open automatically if the metric regresses.

## Task categories

`token-monitor categorize` answers a different question from the cost report: *what* is the team using the agent for, and where is that work being repeated?

It clusters sessions by task intent and surfaces duplicate work across projects plus candidates worth codifying as a shared skill or prompt:

```
By category
  Category                  Sessions  Projects  Tokens  Cost
  ⚠ api authentication jwt  6         3         210k    ~$84.00
  css layout responsive     4         2          88k    ~$31.00

Duplicate work (same task across ≥2 projects)
  ⚠ api authentication jwt — 6 sessions across 3 projects (billing, gateway, mobile-api)  ~$84.00
  Recurring across projects → codify it as a shared skill/prompt instead of re-deriving it.
```

It runs **fully offline and deterministic** — no agent, no network. Each session's prompt is reduced **on-device** to a handful of redacted keyword tokens (structured secrets — keys, URLs, paths, IPs, connection strings — are stripped first); raw prompt text is never stored, printed, or sent. `--threshold` (0–1, default 0.4) and `--min-cluster` (default 2) tune the clustering; bias toward false negatives, since a wrong "duplicate work" call costs more trust than a missed one.

Intent text is read from Claude Code, Cursor, Copilot, Gemini CLI, and Codex sessions (Antigravity is token-only for now). `--html <path>` writes a self-contained task-category dashboard, and once you've run `categorize`, `report` and `html` surface a one-line duplicate-work callout (counts and cost only — never labels).

### Project families

A session that `cd`-s into monorepo subdirs used to fragment one repo into several "projects" (`backend`, `frontend`, `db`…) — inflating the project table and letting duplicate-work detection accuse the *same* repo of cross-project repetition. `collect` now assigns each session **one project: the directory where most of its events ran**, with subdirectories folding into the shallowest parent the session visited (a directory only adopts a label from an ancestor the session actually entered, so sibling projects can never merge, and near-root launch dirs like a home directory never donate their name). This is pure path grouping — no disk access, identical results for deleted directories — and deliberately conservative: resolving to the git repo root was tried and rejected because on umbrella repos it silently merged distinct products into one row, and a wrong merge corrupts the duplicate-work signal where a missed merge only under-reports.

The first 0.11 collect relabels historical rows in one pass — you'll see `(N relabeled into project families; originals in project_raw)` once, and per-project rows may visibly merge. The pre-relabel name of every changed row is kept in the `project_raw` column (`UPDATE events SET project = project_raw WHERE project_raw IS NOT NULL` reverts). Git-worktree checkouts opened as their own directory (`myapp-wt1`) still count as separate projects — fold those explicitly in `~/.token-monitor/project-aliases.json`:

```json
{ "myapp-wt1": "myapp", "quaestor-cl-iter-02": "quaestor-cl" }
```

### Cross-user duplicate work and org skills (lead)

Member exports (`report --json` / `push`) carry each person's task categories — **labels only**: at most 8 redacted keyword terms plus counts and cost per category, capped at the 40 largest, only for sessions with real prompt text. `merge` re-clusters those categories **across people** and reports the same task done independently by two or more members, plus org-skill candidates ranked by `sessions × users`:

```
Cross-user duplicate work (same task, ≥2 people)
  $84.00 spent on tasks done independently by ≥2 people (1 task)

  ⚠ payment retry backoff — 5 session(s) by alice, bob across 2 project(s)  $84.00

  Same task, different people → codify one org skill/prompt instead of re-deriving it per person.

Org-skill candidates (team-wide)
  Task                   Users  Sessions  Cost    Score
  payment retry backoff  2      5         $84.00  10
```

`merge` honors the same `--threshold` / `--min-cluster` knobs as `categorize`. Members can opt out entirely with `report --json --no-categories` / `push --no-categories`. Unsigned exports are identified as `user@host` and flagged `(unsigned)` — one person on two machines can read as two people, so sign exports before acting on a cross-user finding.

## CLI

```
token-monitor collect [--source claude-code|gemini-cli|codex|cursor|antigravity|copilot] [--db <path>]
token-monitor report  [--days 30] [--trend] [--project <name>] [--source <name>] [--json] [--plan <name>] [--annual] [--no-categories] [--db <path>]
token-monitor categorize [--days 30] [--threshold 0.4] [--min-cluster 2] [--project <name>] [--source <name>] [--json] [--html <path>] [--db <path>]
token-monitor analyze [--days 30] [--llm] [--agent claude|gemini|codex] [--json] [--db <path>]
token-monitor context [--days 30] [--json] [--db <path>]
token-monitor donate-fixture <session-id-or-prefix> [--out <dir>] [--db <path>]
token-monitor rules   [<rule-key>] [--days 30] [--json] [--db <path>]
token-monitor html    [--out report.html] [--days 30] [--db <path>]
token-monitor merge   <export.json>... [--team teams.yaml] [--by team|discipline] [--verify] [--keys keys.json] [--threshold 0.4] [--min-cluster 2] [--json] [--html team.html]
token-monitor reconcile [--provider anthropic|openai] [--days 30] [--db <path>]
```

## Contributing

Two ways in, both documented in [CONTRIBUTING.md](CONTRIBUTING.md).

**Write a waste rule.** One file in `src/rules/`, one fixture, one test — no pipeline knowledge needed. This is where your own habits are better evidence than the maintainer's: if your agent keeps doing something expensive, encode it and everyone else's report learns to catch it.

```sh
token-monitor rules                        # the catalogue, and which fire on your data
token-monitor donate-fixture <id-prefix>   # your own session, scrubbed into a fixture
```

Eight are pre-specced and open as [`good first issue`](https://github.com/ryandemelo/token-monitor/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — each with its likely false positive written out, because that is the part you cannot get from the code:

| Rule | The pattern |
|---|---|
| `error-cascade` | runs of three or more consecutive failing turns |
| `search-loop` | long unbroken exploration with nothing landing |
| `redundant-reads` | re-reading what is already in context |
| `untested-coding` | projects with coding spend and no test turns |
| `mega-turns` | single turns emitting runaway output |
| `abandoned-on-error` | sessions whose last turn failed |
| `session-thrash` | overlapping sessions in one project, each paying its own floor |
| `thinking-on-trivial` | reasoning tokens on turns that produced nothing |

**Write an adapter.** Bigger, and the highest-value change when a tool nobody has covered writes logs somewhere: [Aider](https://github.com/ryandemelo/token-monitor/issues/38), [OpenCode](https://github.com/ryandemelo/token-monitor/issues/39), [Windsurf](https://github.com/ryandemelo/token-monitor/issues/12) are open.

`npm test` runs the suite; CI covers Node 24/25 on Linux + macOS. Zero runtime dependencies is a hard constraint — please keep it that way.

## Roadmap

- [x] Team rollups: `merge` command + `team.yaml` discipline mapping
- [x] Org rollups: two-level `teams.yaml`, `merge --by team|discipline`, fingerprint identity, org HTML dashboard
- [x] Self-contained HTML dashboard
- [x] Follow-through tracking: baseline on first firing, delta on every later report
- [x] IDE coverage: Cursor, Antigravity, Copilot Chat adapters
- [ ] Adapters: Aider, OpenCode, Windsurf (needs a contributor with Windsurf — #12)
- [x] VS Code-family extension: status-bar cost + dashboard webview
- [x] Org-level cross-check via provider usage APIs: `reconcile`
- [x] npm publish: `npx @ryandemelo/token-monitor`
- [x] Task categorization: cluster sessions by intent, flag cross-project duplicate work, suggest org skills (`categorize`, on-device)
- [x] Project families: monorepo subdirs fold into one project per session (anchor-based path grouping, `project_raw` audit trail; worktrees fold via `project-aliases.json`)
- [x] Cross-user duplicate work: aggregate-only category exports, `merge` clusters tasks across people and ranks org-skill candidates

## Integrity & threat model

Exports are **tamper-evident**. Each machine generates an Ed25519 keypair on first export (`~/.token-monitor/signing-key.pem`, mode 0600); `report --json` signs a canonical serialization of the payload. The team lead verifies on merge:

```sh
# dev, once: print fingerprint for enrollment
token-monitor fingerprint            # e.g. 3f9a1c0b2d4e5f67

# lead: pin who may sign for whom (keys.json), then verify on every merge
echo '{"alice": "3f9a1c0b2d4e5f67"}' > keys.json
token-monitor merge exports/*.json --verify --keys keys.json
```

`--verify` rejects any export modified after signing or unsigned; `--keys` additionally rejects exports signed by a key not enrolled for that username (impersonation).

**What this does not cover — read before relying on it:** a developer controls their own machine, so someone determined to game metrics could edit the *source logs* before collection. Signing detects tampering after export, not dishonest inputs. The mitigation is `reconcile` (below) — gamed numbers won't reconcile against the provider's billing data. Treat these metrics as a coaching instrument, not a performance-review weapon; the latter invites exactly the gaming this can't stop.

### Reconcile against provider usage APIs

`reconcile` cross-checks the local database against the provider's own usage report:

```sh
ANTHROPIC_ADMIN_KEY=sk-ant-admin... token-monitor reconcile --provider anthropic
OPENAI_ADMIN_KEY=...               token-monitor reconcile --provider openai
```

Per model it shows local tokens, org-billed tokens, and a coverage %. The local db covers one machine while the API covers the whole org, so **local ≤ API is the expected state** — a model whose local total *exceeds* what the org was billed is the red flag (inflated or double-counted logs; exit code 1, so it's CI-able). The admin key is org-lead-only, read from the environment for that one run, and never stored, logged, or exported. Window is capped at 31 days (the APIs' daily-bucket limit). Supported: the Anthropic Admin API and the OpenAI Usage API. Both follow the providers' documented schemas and are exercised against mock servers in the test suite; live-org runs need an admin key, so report any schema drift you hit in an issue.

## Privacy

Everything stays on your machine. token-monitor reads log files locally, stores aggregate numbers in a local SQLite file, and never makes a network request. The core report stores only token counts, tool names, timestamps, and project/branch names — never prompt or code content.

`categorize` is the one command that looks at prompt text, and it does so **entirely on-device**: each session is reduced to at most 8 redacted keyword tokens before anything is written. Structured secrets of known shape (emails, API keys, URLs, file paths, IPs, UUIDs, connection strings, PEM blocks, `key=value` secrets) are stripped first, and key/hash-shaped survivors are dropped — so the database stores keyword *labels*, never sentences. This is defence-in-depth, not a guarantee: a secret that looks exactly like an ordinary word can still survive, which is why only labels (never raw prose) are ever kept.

**What's in a team export** (`report --json` / `push`), field by field: token/cost aggregates, activity shares, per-project metrics keyed by project basename, persona + recommendation strings, and — new in 0.11 — task categories: `{id, name, terms (≤8 redacted keywords), sessions, projects, tokens, cost, estimated, duplicate}`. No prompts, no code, no paths, no session text, and `--no-categories` drops the category block entirely. The terms are deliberately *not* hashed: a dictionary of common dev words would reverse such hashes trivially, so hashing would only obscure the surface from the member shipping it — readable terms keep it auditable.

The one network exception is opt-in: `analyze --llm` sends aggregates to your own agent CLI's provider for analysis. Everything else — `categorize` included — is fully offline.

## License

MIT
