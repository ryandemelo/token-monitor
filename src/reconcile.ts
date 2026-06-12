import type { StoredEvent } from './store.js';
import { table, section, fmtTokens } from './report.js';

/**
 * Cross-check local totals against the provider's usage API — the threat-model
 * mitigation for "a developer can edit their own source logs": gamed numbers
 * won't reconcile against billing data.
 *
 * The admin/usage key is read from an env var only. It is never stored, never
 * written to config, and never included in exports. The API reports org-level
 * usage while the local db covers one machine, so local ≤ API is the expected
 * state; local > API is the red flag.
 */

export interface ProviderUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface ProviderSpec {
  keyEnv: string;
  /** Test/self-host override for the API origin. */
  urlEnv: string;
  defaultUrl: string;
  fetchUsage(baseUrl: string, key: string, startMs: number, endMs: number): Promise<ProviderUsage[]>;
}

async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${url.split('?')[0]} responded ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export const PROVIDERS: Record<string, ProviderSpec> = {
  anthropic: {
    keyEnv: 'ANTHROPIC_ADMIN_KEY',
    urlEnv: 'TOKEN_MONITOR_ANTHROPIC_URL',
    defaultUrl: 'https://api.anthropic.com',
    // Admin API: GET /v1/organizations/usage_report/messages — grouped by
    // model, daily buckets (max 31), paginated via has_more/next_page.
    async fetchUsage(baseUrl, key, startMs, endMs) {
      const byModel = new Map<string, ProviderUsage>();
      let page: string | undefined;
      do {
        const params = new URLSearchParams({
          starting_at: new Date(startMs).toISOString(),
          ending_at: new Date(endMs).toISOString(),
          bucket_width: '1d',
          limit: '31',
        });
        params.append('group_by[]', 'model');
        if (page) params.set('page', page);
        const data = await getJson(`${baseUrl}/v1/organizations/usage_report/messages?${params}`, {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        });
        for (const bucket of (data.data as Array<Record<string, unknown>>) ?? []) {
          for (const r of (bucket.results as Array<Record<string, unknown>>) ?? []) {
            const model = String(r.model ?? 'unknown');
            const u = byModel.get(model) ?? {
              model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            };
            u.inputTokens += num(r.uncached_input_tokens);
            u.outputTokens += num(r.output_tokens);
            u.cacheReadTokens += num(r.cache_read_input_tokens);
            const cc = (r.cache_creation ?? {}) as Record<string, unknown>;
            u.cacheCreationTokens += num(cc.ephemeral_5m_input_tokens) + num(cc.ephemeral_1h_input_tokens);
            byModel.set(model, u);
          }
        }
        page = data.has_more ? String(data.next_page) : undefined;
      } while (page);
      return [...byModel.values()];
    },
  },
  openai: {
    keyEnv: 'OPENAI_ADMIN_KEY',
    urlEnv: 'TOKEN_MONITOR_OPENAI_URL',
    defaultUrl: 'https://api.openai.com',
    // Usage API: GET /v1/organization/usage/completions — unix-second range,
    // grouped by model, paginated via has_more/next_page.
    async fetchUsage(baseUrl, key, startMs, endMs) {
      const byModel = new Map<string, ProviderUsage>();
      let page: string | undefined;
      do {
        const params = new URLSearchParams({
          start_time: String(Math.floor(startMs / 1000)),
          end_time: String(Math.floor(endMs / 1000)),
          bucket_width: '1d',
          group_by: 'model',
          limit: '31',
        });
        if (page) params.set('page', page);
        const data = await getJson(`${baseUrl}/v1/organization/usage/completions?${params}`, {
          authorization: `Bearer ${key}`,
        });
        for (const bucket of (data.data as Array<Record<string, unknown>>) ?? []) {
          for (const r of (bucket.results as Array<Record<string, unknown>>) ?? []) {
            const model = String(r.model ?? 'unknown');
            const u = byModel.get(model) ?? {
              model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            };
            // OpenAI's input_tokens INCLUDES cached tokens; split them out so
            // the columns line up with the local fresh/cached separation.
            u.inputTokens += num(r.input_tokens) - num(r.input_cached_tokens);
            u.cacheReadTokens += num(r.input_cached_tokens);
            u.outputTokens += num(r.output_tokens);
            byModel.set(model, u);
          }
        }
        page = data.has_more ? String(data.next_page) : undefined;
      } while (page);
      return [...byModel.values()];
    },
  },
};

export interface ReconcileRow {
  model: string;
  localTokens: number;
  apiTokens: number;
  /** local / api — how much of the org's usage this machine accounts for. */
  coverage: number;
  verdict: 'ok' | 'local-exceeds-api' | 'local-only';
}

/** Local > API beyond this tolerance = the red flag (clock skew, bucket snapping). */
const TOLERANCE = 1.05;

export function compareUsage(events: StoredEvent[], api: ProviderUsage[]): ReconcileRow[] {
  const localByModel = new Map<string, number>();
  for (const e of events) {
    const t = e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_creation_tokens;
    localByModel.set(e.model, (localByModel.get(e.model) ?? 0) + t);
  }
  const total = (u: ProviderUsage) =>
    u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;

  const rows: ReconcileRow[] = [];
  for (const u of api) {
    const local = localByModel.get(u.model) ?? 0;
    localByModel.delete(u.model);
    const apiTokens = total(u);
    rows.push({
      model: u.model,
      localTokens: local,
      apiTokens,
      coverage: apiTokens ? local / apiTokens : 0,
      verdict: apiTokens && local > apiTokens * TOLERANCE ? 'local-exceeds-api' : 'ok',
    });
  }
  // Models collected locally that the API doesn't report at all.
  for (const [model, local] of localByModel) {
    rows.push({ model, localTokens: local, apiTokens: 0, coverage: 0, verdict: 'local-only' });
  }
  return rows.sort((a, b) => b.apiTokens - a.apiTokens);
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const VERDICT_LABEL: Record<ReconcileRow['verdict'], string> = {
  ok: `${GREEN}✓ reconciles${RESET}`,
  'local-exceeds-api': `${RED}✗ local exceeds org usage — investigate${RESET}`,
  'local-only': `${DIM}— not in API report${RESET}`,
};

export function renderReconcile(provider: string, rows: ReconcileRow[], days: number): string {
  const out: string[] = [];
  out.push(section(`Reconcile — local db vs ${provider} usage API, last ${days} days`));
  if (rows.length === 0) {
    out.push('  No usage on either side in the window.');
    return out.join('\n');
  }
  out.push(
    table(
      ['Model', 'Local', 'Org API', 'Coverage', 'Verdict'],
      rows.map((r) => [
        r.model,
        fmtTokens(r.localTokens),
        r.apiTokens ? fmtTokens(r.apiTokens) : '—',
        r.apiTokens ? (r.coverage * 100).toFixed(1) + '%' : '—',
        VERDICT_LABEL[r.verdict],
      ]),
    ),
  );
  out.push(
    `\n  ${DIM}Local covers this machine; the API covers the whole org — local ≤ API is expected.` +
      `\n  Local > API means the local logs claim more than the org was billed for: tampered or` +
      `\n  double-counted data. "Not in API report" can be other vendors' models or pre-window usage.${RESET}\n`,
  );
  return out.join('\n');
}

export interface ReconcileResult {
  rows: ReconcileRow[];
  /** True when any model's local total exceeds the org's billed usage. */
  breach: boolean;
}

export async function reconcile(
  provider: string,
  events: StoredEvent[],
  days: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReconcileResult> {
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw new Error(`Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const key = env[spec.keyEnv];
  if (!key) {
    throw new Error(
      `${spec.keyEnv} is not set. Reconcile needs an admin/usage API key (org lead only) — ` +
        `export it for this run, e.g. \`${spec.keyEnv}=... token-monitor reconcile --provider ${provider}\`. ` +
        `The key is read from the environment only and never stored.`,
    );
  }
  const endMs = Date.now();
  const startMs = endMs - days * 86_400_000;
  const baseUrl = (env[spec.urlEnv] || spec.defaultUrl).replace(/\/$/, '');
  const usage = await spec.fetchUsage(baseUrl, key, startMs, endMs);
  const rows = compareUsage(events, usage);
  return { rows, breach: rows.some((r) => r.verdict === 'local-exceeds-api') };
}
