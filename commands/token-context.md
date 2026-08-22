---
description: Show what the standing context surface costs — floor, tool-result carry, MCP servers
---

Run `npx -y @ryandemelo/token-monitor context` (after `collect` if the database is empty) and explain what it found.

Cover:
- **Session floor** — the smallest context each session runs with: system prompt, the tool definitions of every connected MCP server, loaded skills, `CLAUDE.md` and its imports. Frame it as the standing cost re-read every turn, not as waste; the question is whether it is creeping, which `report --trend` answers.
- **Tool-result carry** — result size × the turns it kept riding in context. Point at the specific tools at the top of the table and suggest concrete bounds: a line limit, a narrower search, a paged MCP call, or handing the payload to a subagent whose context ends with it.
- **MCP servers** — spend and error rate per server, and any server that is connected but was never invoked in the window. Say clearly that usage is not value: a server called twice may have saved an afternoon. A server called zero times is paying for its tool definitions on every request.

Rules:
- Everything in this command's output is an estimate (`~`): sizes come from characters at ~4 chars/token, and carry is an upper bound cut at the last measurable context collapse. Say so once, plainly.
- Tool and MCP server names in this output are **local only**. Do not put them in a file, a commit, an issue, or any message that leaves the user's machine unless they ask for exactly that.
- Only Claude Code persists tool results today. For other sources carry reads as unmeasured, which is not the same as zero — do not report it as zero.
