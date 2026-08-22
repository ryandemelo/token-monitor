# Contributing

Thanks for helping make AI token spend measurable. Two contribution paths are open by design:

- **A waste rule** — one file, one fixture, one test. The smallest useful change, and the part of the tool where your own habits are better evidence than the maintainer's. Start here; see [Writing a waste rule](#writing-a-waste-rule).
- **An adapter for another agent CLI** — bigger, and the highest-value change when a tool nobody has covered writes logs somewhere.

Bug fixes, persona-threshold tuning, and price-table updates are all welcome too.

## Dev setup

```sh
git clone https://github.com/ryandemelo/token-monitor && cd token-monitor
npm install
npm test          # build + node:test suite
```

Node ≥ 24, zero runtime dependencies (built-in `node:sqlite`, `node:util` parseArgs). Please keep it that way — the no-install-friction property is the point of the project.

The suite has two layers: unit/integration tests per module, and `test/e2e.test.ts`, which spawns the built CLI as a subprocess against a synthetic `$HOME` seeded with the fixture logs and runs the full `collect → report → export → verify → merge → html → analyze` pipeline. If you add a command or flag, add an e2e case — unit tests alone don't cover the CLI wiring.

## Writing a waste rule

A **rule** is one heuristic that turns metrics into a finding: a firing condition, a message, and — when the waste is quantifiable — the arithmetic that prices it. Every recommendation the tool prints comes from one.

Run `token-monitor rules` to see the catalogue and which fire on your own data, and `token-monitor rules <key>` for what one measures. Several are pre-specced as `good first issue` in the tracker, each with its failure modes written down.

One file in `src/rules/`, listed once in `src/rules/index.ts`:

```ts
// src/rules/tool-retry-loops.ts
import type { Rule } from './types.js';
import { fmtTokens } from '../fmt.js';

const rule: Rule = {
  key: 'tool-retry-loops',        // stable id — follow-through baselines key on it
  metric: 'retryShare',           // the tracked metric this rule wants to move
  direction: 'down',
  family: 'rework',               // savings de-overlap group; omit for advice-only rules
  title: 'Paying to retry a tool that just failed',
  docs: `What it measures, why it costs money, what to change. Printed by \`rules <key>\`.`,
  fires: (m) => (m.retryShare >= 0.05 ? `${(m.retryShare * 100).toFixed(0)}% of spend goes to retries...` : undefined),
  score: (s) => ({ score: s.m.retryTokens, label: `${fmtTokens(s.m.retryTokens)} retry tok` }),
  savings: ({ m, rates }) => m.retryTokens * rates.spend,
};
export default rule;
```

Only `key`, `metric`, `direction`, `title`, `docs` and `fires` are required. `score` supplies the "worst sessions" evidence; `savings` prices the finding; `target`/`personalTarget` say what it is priced against; `clause` appends a sentence that needs the raw events. See `src/rules/types.ts` for the full contract and `src/rules/low-think-code.ts` for a rule that deliberately prices nothing.

Four rules to write by:

1. **`fires` gets metrics, never events.** It is also called on merged team metrics, where no events exist. Anything needing turns belongs in `score`, `savings` or `clause`.
2. **Bias to false negatives.** Every finding is an accusation about how someone works. A missed one costs a little money; a wrong one costs the trust that makes the rest of the tool worth reading. Gate on volume, and say "no measurable X" rather than "X is waste".
3. **Ship the caveat with the rule.** If your signal is a proxy (tool arguments aren't stored; a source doesn't report thinking tokens), the message says so. Sources that can't measure something report *nothing*, not zero.
4. **Justify thresholds against real data in the PR.** Persona and cluster thresholds set the precedent: a number you picked because it looked round is a number nobody can defend later.

### Getting data to write it against

`makeStored` builds synthetic turns by hand, which is enough for most rules. When you need the shape of *real* work — a fix loop, a fan-out, a session that bloats — donate one of your own sessions:

```sh
token-monitor report                       # session ids appear as recommendation evidence
token-monitor donate-fixture <id-prefix>   # -> test/fixtures/donated/
```

The generator reads the **database**, not your transcripts, and the database has no column that can hold prompt or code text. What survives is what rules measure: turn count, timing, token counts, models, tool names, error flags, result sizes and the subagent structure. Projects and branches are renamed, MCP tool names are replaced (keeping their classifier class so the session's activity mix survives the round trip), and timestamps are shifted to a fixed start with every gap preserved. Read the files before you attach them to a PR anyway — the tool's privacy claims should not be the only thing between your session and a public repo.

Then a test in `test/rules.test.ts` (or its own file) with a synthetic window from `makeStored`: one case where it fires, one where it must stay silent, and — if it prices savings — one asserting the arithmetic. `npm test` must pass.

If your new rule needs a metric that doesn't exist yet, add it to `Metrics` in `src/metrics.ts` and to the `MetricKey` union in `src/followthrough.ts` so follow-through can track whether the advice worked.

## Writing an adapter

An adapter parses one agent CLI's local logs into normalized `UsageEvent`s (see `src/types.ts`). Per turn it should produce:

- token counts: input, output, cache read/creation, thinking (0 if the vendor doesn't report it)
- `tools`: tool names invoked, `commands`: shell command strings — these drive activity classification
- `eventKey`: stable unique id within the source, so re-collecting is idempotent
- `isError` when a tool call in the turn failed (powers the rework metric)

Steps:

1. Add `src/adapters/<name>.ts` exporting `collect<Name>(root?: string)` → `{ events, result }`. Take the log root as a parameter (defaulting to the real location) so tests can point it at fixtures.
2. Register it in `src/adapters/index.ts` and add the source name to `Source` in `src/types.ts`.
3. Add fixture files under `test/fixtures/<name>/` mirroring the real log layout, and a test in `test/adapters.test.ts` asserting token numbers, activities, and error linkage.
4. If the vendor uses tool names the classifier doesn't know, extend the sets in `src/classify.ts` (lowercase).
5. Adapters must never throw when the tool isn't installed — return zero events with a `note`.

Redact real transcripts before turning them into fixtures: keep the structure, replace content.

Adapters for IDE stores (Cursor, Antigravity) read SQLite via the built-in `node:sqlite`; copy the db (+ `-wal`) to a scratch dir before opening — the IDE may hold a lock. If the store mixes usage data with credentials (Cursor does), whitelist exact keys/prefixes and add a test that plants a canary credential and asserts it cannot reach adapter output.

## The VS Code-family extension

`extension/` is a separate npm package (own `package.json`, CommonJS, `@types/vscode`). It must stay a thin UI over the CLI: all parsing lives in the CLI, and anything touching data belongs in `extension/src/bridge.ts`, which is `vscode`-free and e2e-tested against the real built CLI (`cd extension && npm test`; build the root first). `npm run package` produces the `.vsix`; CI builds and uploads it as an artifact.

## Conventions

- `npm test` must pass; CI runs Node 24 + 25 on Linux and macOS.
- No runtime dependencies. Dev dependencies: TypeScript only.
- Aggregate numbers only — adapters must not store prompt or code content in the database.
- Keep persona/threshold changes justified in the PR description (they shape the recommendations everyone sees).

## Updating prices

`src/pricing.ts` holds USD per MTok. Anthropic prices are maintained; other vendors are flagged `estimated: true` until someone confirms them against the vendor's price sheet — PRs that pin them to a dated source are very welcome.
