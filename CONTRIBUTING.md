# Contributing

Thanks for helping make AI token spend measurable. The highest-value contribution is an **adapter for another agent CLI** — but bug fixes, persona-threshold tuning, and price-table updates are all welcome.

## Dev setup

```sh
git clone https://github.com/ryandemelo/token-monitor && cd token-monitor
npm install
npm test          # build + node:test suite
```

Node ≥ 24, zero runtime dependencies (built-in `node:sqlite`, `node:util` parseArgs). Please keep it that way — the no-install-friction property is the point of the project.

The suite has two layers: unit/integration tests per module, and `test/e2e.test.ts`, which spawns the built CLI as a subprocess against a synthetic `$HOME` seeded with the fixture logs and runs the full `collect → report → export → verify → merge → html → analyze` pipeline. If you add a command or flag, add an e2e case — unit tests alone don't cover the CLI wiring.

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

## Conventions

- `npm test` must pass; CI runs Node 24 + 25 on Linux and macOS.
- No runtime dependencies. Dev dependencies: TypeScript only.
- Aggregate numbers only — adapters must not store prompt or code content in the database.
- Keep persona/threshold changes justified in the PR description (they shape the recommendations everyone sees).

## Updating prices

`src/pricing.ts` holds USD per MTok. Anthropic prices are maintained; other vendors are flagged `estimated: true` until someone confirms them against the vendor's price sheet — PRs that pin them to a dated source are very welcome.
