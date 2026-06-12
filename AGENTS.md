# Agent instructions

Instructions for coding agents (Claude Code, Gemini CLI, Codex, Cursor, …) working with this repository — whether installing it for a user or contributing to it.

## Installing for a user

Requires Node.js ≥ 24 (uses built-in `node:sqlite`). No other dependencies.

```sh
# one-off, no install
npx @ryandemelo/token-monitor collect
npx @ryandemelo/token-monitor report

# or persistent
npm install -g @ryandemelo/token-monitor
token-monitor collect && token-monitor report
```

`collect` reads the user's local agent session logs (`~/.claude/projects/`, `~/.gemini/tmp/`, `~/.codex/sessions/`, Cursor's `state.vscdb`, `~/.gemini/antigravity-cli/`, VS Code `chatSessions/`) into `~/.token-monitor/token-monitor.sqlite`. It is idempotent — safe to re-run any time. `report` prints the analysis; `html` writes a dashboard file; nothing makes network calls.

After installing, run `collect` then `report` and walk the user through their activity breakdown, cache hit ratio, rework ratio, and persona.

## Working on the codebase

- Build/test: `npm install && npm test` (TypeScript build + `node:test` suite). Tests must pass before any commit.
- **Zero runtime dependencies is a hard constraint** — only Node built-ins (`node:sqlite`, `node:util` parseArgs). Do not add packages.
- Privacy is a hard constraint: adapters store aggregate numbers, tool names, timestamps, and project basenames — never prompt or code content. Fixtures must be synthetic; sample output in docs must use fictional project names and costs.
- New adapters: follow CONTRIBUTING.md — `src/adapters/<name>.ts` with the log root as a parameter, fixtures under `test/fixtures/<name>/`, registered in `src/adapters/index.ts`.
- Workflow: feature branches (`feat/...`, `fix/...`, `chore/...`) → PR → merge to `main`. Releases are tagged `vX.Y.Z`.
- Never commit user-specific agent context (`.claude/`, `CLAUDE.md`, `.gemini/`) or generated reports/exports (`report.html`, `exports/`) — these are gitignored; keep them that way.
