# Token Monitor — VS Code-family extension

Status-bar token/cost for the current project plus the full [token-monitor](https://github.com/ryandemelo/token-monitor) dashboard, in any VS Code-family editor: **VS Code, Cursor, Windsurf, Antigravity**.

The extension is a thin UI over the CLI — all parsing, storage, and privacy guarantees are the CLI's. Data never leaves your machine.

**Install:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ryan653133.token-monitor) (search "token-monitor"), or the `.vsix` from the [latest release](https://github.com/ryandemelo/token-monitor/releases). Requires Node ≥ 24 on PATH.

## What you get

- **Status bar**: `1.2M · ~$45` — work tokens and estimated cost for the workspace's project over the configured window (falls back to overall when the project has no data). Hover for cache hit and rework ratios; click to open the dashboard.
- **Token Monitor: Open Dashboard** — the CLI's self-contained HTML dashboard in a webview.
- **Token Monitor: Collect & Refresh** — re-scan agent logs on demand. Auto-collect also runs on a configurable interval.

## Requirements

Node.js ≥ 24 on your PATH. By default the extension invokes `npx -y @ryandemelo/token-monitor`; point `tokenMonitor.command` at a global install (`token-monitor`) or a checkout (`node /path/to/dist/src/cli.js`) if you prefer.

## Settings

| Setting | Default | |
|---|---|---|
| `tokenMonitor.command` | `npx -y @ryandemelo/token-monitor` | CLI invocation. Machine-scoped — workspaces cannot override it. |
| `tokenMonitor.days` | `30` | Report window. |
| `tokenMonitor.autoCollect` | `true` | Run `collect` before each refresh. |
| `tokenMonitor.refreshMinutes` | `15` | Status-bar refresh interval. |

## Development

```sh
cd extension
npm install
npm test          # compiles + runs the bridge e2e suite against the repo CLI (build the root first: npm --prefix .. run build)
npm run package   # builds the .vsix
```
