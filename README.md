# token-monitor

[![CI](https://github.com/ryandemelo/token-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/ryandemelo/token-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

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
| **Cursor** | `Cursor/User/globalStorage/state.vscdb` (SQLite) | ✅ Verified — per-turn tokens on completed turns, tool calls, agent/chat sessions. Cursor doesn't persist cache tokens or the resolved backend model (Auto mode reports as `cursor-auto`) |
| **Antigravity CLI** | `~/.gemini/antigravity-cli/conversations/*.db` (SQLite + protobuf) | ✅ Verified — per-call prompt/cached/output tokens, per-row model, tool steps, workspace + branch. Vendor-internal format: fails soft if the schema changes |
| **Copilot Chat** (VS Code) | `Code/User/workspaceStorage/*/chatSessions/*` | ⚠️ Experimental — Copilot doesn't record token usage locally, so counts are **estimated** from text length (~4 chars/token) and models are suffixed `(est)`. Turn counts, timestamps, tools, and errors are real |

Adapters skip gracefully when a tool isn't installed. The Cursor adapter reads only composer/bubble keys — never the auth entries that live in the same database.

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

The report and dashboard surface the same signals in one line (context bloat, cold restarts, premium tokens on exploration/conversation, retry-loop spend), and each one becomes a tracked recommendation when it crosses its threshold.

Add `--llm` and the aggregates go to a coding agent you already have installed (`claude`, `gemini`, or `codex` — auto-detected, override with `--agent`), which returns prioritized interventions with the evidence, the workflow change, and the metric to watch:

```sh
token-monitor analyze --llm
```

No API key management: it reuses your existing agent CLI and its subscription. The payload is the same aggregates-only data as `report --json` (token counts, ratios, tool names, project basenames — never prompts or code). It does leave your machine via that agent's provider, so skip `--llm` if even project names are sensitive.

## Trends

`report --trend` compares the window against the previous same-length one — spend, cost, cache hit, rework, and the optimization signals, each with a direction arrow (green = improving, red = regressing), plus the top project movers by spend change. The HTML dashboard includes the trend automatically when two windows of data exist.

## Recommendations: evidence + savings

Every threshold-fired recommendation answers "why should I believe this and what is it worth": it cites the worst 3 sessions that triggered it (session ids, dates, token counts — aggregate-only, never content) and estimates the $/month saved if the metric hit its target, priced from **your own model mix** and the price table (`~` when estimated prices or a tier assumption are involved):

```
→ 43% of spend is premium-model tokens on exploration/conversation turns. …  ≈ $8060/mo
    worst: db0a7d17 (procurement, 2026-05-26, 1.8M premium on exploration/chat) · …
```

These show up in `report`, `analyze`, the HTML dashboard, and ride along in signed exports (`recommendationDetails`).

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
token-monitor report  [--days 30] [--trend] [--project <name>] [--source <name>] [--json] [--no-categories] [--db <path>]
token-monitor categorize [--days 30] [--threshold 0.4] [--min-cluster 2] [--project <name>] [--source <name>] [--json] [--html <path>] [--db <path>]
token-monitor analyze [--days 30] [--llm] [--agent claude|gemini|codex] [--json] [--db <path>]
token-monitor html    [--out report.html] [--days 30] [--db <path>]
token-monitor merge   <export.json>... [--team teams.yaml] [--by team|discipline] [--verify] [--keys keys.json] [--threshold 0.4] [--min-cluster 2] [--json] [--html team.html]
token-monitor reconcile [--provider anthropic|openai] [--days 30] [--db <path>]
```

## Contributing

The most valuable contribution: an adapter for another agent CLI (Aider, OpenCode, Cursor…). See [CONTRIBUTING.md](CONTRIBUTING.md) for the adapter guide, fixtures, and conventions. `npm test` runs the suite; CI covers Node 24/25 on Linux + macOS.

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
