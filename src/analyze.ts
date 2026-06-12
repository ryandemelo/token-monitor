import { spawnSync } from 'node:child_process';
import type { StoredEvent } from './store.js';
import { computeMetrics, groupBy, contextGrowthOf, parseTools, CACHE_TTL_MS } from './metrics.js';
import { costOf } from './pricing.js';
import { assignPersona } from './personas.js';
import { structuredFindings } from './followthrough.js';
import type { Activity } from './types.js';
import { ACTIVITIES } from './types.js';
import { table, section, fmtTokens, renderEnrichedRecs } from './report.js';
import { enrichFindings } from './recommendations.js';

/**
 * Deeper, session-level analysis. The report answers "where do tokens go";
 * analyze answers "which sessions and habits burn them" — and can hand the
 * aggregates to a local agent CLI for prioritized, LLM-written
 * recommendations.
 */

export interface SessionStat {
  sessionId: string;
  project: string;
  source: string;
  turns: number;
  spendTokens: number;
  costUsd: number;
  errorTurns: number;
  /** testing -> coding transitions: each is one fix-loop iteration. */
  fixIterations: number;
  /** Mean context fed per turn (input + cache read/creation) — bloat proxy. */
  avgContextTokens: number;
  /** Late-half avg context / early half; 0 when the session is too short. */
  contextGrowth: number;
  /** Turns resuming after a gap past the cache TTL, and what they re-paid. */
  coldRestartTurns: number;
  coldRestartTokens: number;
  durationMin: number;
  dominant: Activity;
}

export function computeSessionStats(events: StoredEvent[]): SessionStat[] {
  const out: SessionStat[] = [];
  for (const [sessionId, evs] of groupBy(events, 'session_id')) {
    let spend = 0, cost = 0, errors = 0, fixes = 0, context = 0;
    let coldTurns = 0, coldTokens = 0;
    const actTokens = Object.fromEntries(ACTIVITIES.map((a) => [a, 0])) as Record<Activity, number>;
    let prev: string | undefined;
    let prevTs: number | undefined;
    for (const e of evs) {
      spend += e.input_tokens + e.output_tokens;
      cost += costOf(e.model, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_creation_tokens).usd;
      if (e.is_error) errors++;
      if (prev === 'testing' && e.activity === 'coding') fixes++;
      prev = e.activity;
      const ts = Date.parse(e.ts);
      if (prevTs !== undefined && ts - prevTs > CACHE_TTL_MS) {
        coldTurns++;
        coldTokens += e.input_tokens + e.cache_creation_tokens;
      }
      prevTs = ts;
      context += e.input_tokens + e.cache_read_tokens + e.cache_creation_tokens;
      if (ACTIVITIES.includes(e.activity as Activity)) {
        actTokens[e.activity as Activity] += e.input_tokens + e.output_tokens;
      }
    }
    const first = Date.parse(evs[0].ts);
    const last = Date.parse(evs[evs.length - 1].ts);
    out.push({
      sessionId,
      project: evs[0].project,
      source: evs[0].source,
      turns: evs.length,
      spendTokens: spend,
      costUsd: cost,
      errorTurns: errors,
      fixIterations: fixes,
      avgContextTokens: Math.round(context / evs.length),
      contextGrowth: contextGrowthOf(evs)?.ratio ?? 0,
      coldRestartTurns: coldTurns,
      coldRestartTokens: coldTokens,
      durationMin: Math.max(0, Math.round((last - first) / 60_000)),
      dominant: ACTIVITIES.reduce((b, a) => (actTokens[a] > actTokens[b] ? a : b)),
    });
  }
  return out;
}

export interface ToolStat {
  tool: string;
  turns: number;
  errorTurns: number;
  /** Share of this tool's turns that hit an error. Errors are attributed to
   *  every tool in the failing turn — an upper bound, not exact blame. */
  errorRate: number;
  /** Tokens on turns re-running this tool right after a turn where it errored. */
  retryTokens: number;
}

export function computeToolStats(events: StoredEvent[]): ToolStat[] {
  const map = new Map<string, { turns: number; errorTurns: number; retryTokens: number }>();
  const stat = (t: string) => {
    let s = map.get(t);
    if (!s) map.set(t, (s = { turns: 0, errorTurns: 0, retryTokens: 0 }));
    return s;
  };
  for (const [, evs] of groupBy(events, 'session_id')) {
    let prevErrTools: Set<string> | undefined;
    for (const e of evs) {
      const tools = new Set(parseTools(e.tools));
      for (const t of tools) {
        const s = stat(t);
        s.turns++;
        if (e.is_error) s.errorTurns++;
        if (prevErrTools?.has(t)) s.retryTokens += e.input_tokens + e.output_tokens;
      }
      prevErrTools = e.is_error ? tools : undefined;
    }
  }
  return [...map.entries()]
    .map(([tool, s]) => ({ tool, ...s, errorRate: s.turns ? s.errorTurns / s.turns : 0 }))
    .sort((a, b) => b.turns - a.turns);
}

export interface DeepAnalysis {
  expensiveSessions: SessionStat[];
  fixLoopSessions: SessionStat[];
  contextHeavySessions: SessionStat[];
  bloatTrendSessions: SessionStat[];
  coldRestartSessions: SessionStat[];
  toolStats: ToolStat[];
}

export function deepAnalysis(events: StoredEvent[]): DeepAnalysis {
  const stats = computeSessionStats(events);
  return {
    expensiveSessions: [...stats].sort((a, b) => b.spendTokens - a.spendTokens).slice(0, 8),
    fixLoopSessions: stats
      .filter((s) => s.fixIterations >= 2)
      .sort((a, b) => b.fixIterations - a.fixIterations)
      .slice(0, 8),
    contextHeavySessions: stats
      .filter((s) => s.turns >= 10)
      .sort((a, b) => b.avgContextTokens - a.avgContextTokens)
      .slice(0, 8),
    bloatTrendSessions: stats
      .filter((s) => s.contextGrowth >= 2)
      .sort((a, b) => b.contextGrowth - a.contextGrowth)
      .slice(0, 8),
    coldRestartSessions: stats
      .filter((s) => s.coldRestartTurns > 0)
      .sort((a, b) => b.coldRestartTokens - a.coldRestartTokens)
      .slice(0, 8),
    toolStats: computeToolStats(events).slice(0, 15),
  };
}

// ---------- LLM-powered recommendations ----------

const round = (n: number, d = 3) => Number(n.toFixed(d));

/**
 * Compact, aggregates-only payload. By construction this contains token
 * counts, ratios, tool names, project basenames, and persona ids — never
 * prompt or code content.
 */
export function buildLlmPayload(events: StoredEvent[], days: number): object {
  const m = computeMetrics(events);
  const deep = deepAnalysis(events);
  const slim = (s: SessionStat) => ({
    project: s.project,
    source: s.source,
    turns: s.turns,
    spendTokens: s.spendTokens,
    costUsd: round(s.costUsd, 2),
    errorTurns: s.errorTurns,
    fixIterations: s.fixIterations,
    avgContextTokens: s.avgContextTokens,
    contextGrowth: round(s.contextGrowth, 1),
    coldRestartTokens: s.coldRestartTokens,
    durationMin: s.durationMin,
    dominant: s.dominant,
  });
  return {
    windowDays: days,
    overall: {
      sessions: m.sessions,
      turns: m.events,
      spendTokens: m.spendTokens,
      costUsd: round(m.costUsd, 2),
      cacheHitRatio: round(m.cacheHitRatio),
      reworkRatio: round(m.reworkRatio),
      thinkToCodeRatio: round(m.thinkToCodeRatio),
      contextBloatShare: round(m.contextBloatShare),
      coldRestartShare: round(m.coldRestartShare),
      premiumWasteShare: round(m.premiumWasteShare),
      retryShare: round(m.retryShare),
      activityShares: Object.fromEntries(
        ACTIVITIES.filter((a) => m.byActivity[a].tokens > 0).map((a) => [a, round(m.byActivity[a].share)]),
      ),
      models: Object.fromEntries(
        Object.entries(m.byModel).map(([k, v]) => [k, { tokens: v.tokens, costUsd: round(v.costUsd, 2) }]),
      ),
      persona: assignPersona(m).id,
    },
    projects: [...groupBy(events, 'project').entries()]
      .map(([proj, evs]) => ({ proj, m: computeMetrics(evs) }))
      .sort((a, b) => b.m.spendTokens - a.m.spendTokens)
      .slice(0, 10)
      .map(({ proj, m: pm }) => ({
        project: proj,
        spendTokens: pm.spendTokens,
        costUsd: round(pm.costUsd, 2),
        cacheHitRatio: round(pm.cacheHitRatio),
        reworkRatio: round(pm.reworkRatio),
        thinkToCodeRatio: round(pm.thinkToCodeRatio),
        persona: assignPersona(pm).id,
      })),
    expensiveSessions: deep.expensiveSessions.map(slim),
    fixLoopSessions: deep.fixLoopSessions.map(slim),
    contextHeavySessions: deep.contextHeavySessions.map(slim),
    bloatTrendSessions: deep.bloatTrendSessions.map(slim),
    coldRestartSessions: deep.coldRestartSessions.map(slim),
    toolErrorRates: deep.toolStats
      .filter((t) => t.errorRate > 0.05 && t.turns >= 20)
      .map((t) => ({ tool: t.tool, turns: t.turns, errorRate: round(t.errorRate, 2), retryTokens: t.retryTokens })),
    ruleBasedFindings: structuredFindings(m).map((f) => f.key),
  };
}

export function buildLlmPrompt(events: StoredEvent[], days: number): string {
  return `You are an engineering-efficiency analyst. The JSON below contains AGGREGATE token-usage telemetry from AI coding agents (Claude Code / Gemini CLI / Codex) for one developer or team over ${days} days. There is no prompt or code content — only counts, ratios, tool names, and project names.

Definitions: reworkRatio = share of tokens spent on coding/testing turns after the first failed turn in a session (fix loops). cacheHitRatio = cache reads / all input-side tokens (reads cost ~10% of fresh input). thinkToCodeRatio = (planning+exploration tokens) / coding tokens. fixIterations = testing->coding transitions in one session. avgContextTokens = mean context fed per turn (bloat proxy). contextGrowth = late-half avg context / early half per session; contextBloatShare = share of long sessions growing >=2x without cache keeping pace. coldRestartTokens = input re-paid on turns resuming after the ~5-min cache TTL; coldRestartShare = that over all fresh-paid input. premiumWasteShare = premium-model tokens on exploration/conversation turns / all spend. retryShare/retryTokens = spend on turns re-running a tool right after it errored. Personas: architect (plans first), surgeon (precise, low waste), explorer (heavy reading), sprinter (codes first, reworks later), firefighter (test-fail loops), balanced.

Analyze the data and respond in markdown:
1. **Top 3 interventions**, prioritized by expected token/cost savings. For each: the evidence (cite specific numbers/projects/sessions from the data), the concrete workflow change, and which metric will move if it works.
2. **Anomalies** worth investigating (outlier sessions, suspicious tool error rates, odd activity mixes).
3. **Per-project notes** for the 3 highest-spend projects — one or two sentences each.

Be specific to this data. No generic advice that ignores the numbers. If the data is too thin for a conclusion, say so.

DATA:
${JSON.stringify(buildLlmPayload(events, days))}`;
}

export function renderAnalysis(events: StoredEvent[], days: number): string {
  const deep = deepAnalysis(events);
  const m = computeMetrics(events);
  const out: string[] = [];
  const sessRow = (s: SessionStat) => [
    s.project.length > 24 ? s.project.slice(0, 23) + '…' : s.project,
    s.source,
    String(s.turns),
    fmtTokens(s.spendTokens),
    '$' + s.costUsd.toFixed(2),
    String(s.fixIterations),
    fmtTokens(s.avgContextTokens),
    s.durationMin + 'm',
    s.dominant,
  ];
  const headers = ['Project', 'Source', 'Turns', 'Tokens', 'Cost', 'Fix loops', 'Ctx/turn', 'Span', 'Dominant'];

  out.push(section(`Deep analysis — last ${days} days`));
  out.push(`${'\x1b[1m'}Most expensive sessions${'\x1b[0m'}`);
  out.push(table(headers, deep.expensiveSessions.map(sessRow)));

  if (deep.fixLoopSessions.length) {
    out.push(`\n${'\x1b[1m'}Fix-loop sessions (testing→coding churn)${'\x1b[0m'}`);
    out.push(table(headers, deep.fixLoopSessions.map(sessRow)));
  } else if (m.byActivity.testing.share < 0.02 && m.reworkRatio > 0.1) {
    out.push(
      `\n\x1b[33m⚠\x1b[0m rework ratio is ${(m.reworkRatio * 100).toFixed(0)}% but testing is only ${(m.byActivity.testing.share * 100).toFixed(1)}% of spend — fix-loop detection needs test turns to see churn. The rework is real; the loops are invisible because little gets tested.`,
    );
  }
  if (deep.contextHeavySessions.length) {
    out.push(`\n${'\x1b[1m'}Context-heavy sessions (avg tokens fed per turn)${'\x1b[0m'}`);
    out.push(table(headers, deep.contextHeavySessions.map(sessRow)));
  }
  if (deep.bloatTrendSessions.length) {
    out.push(`\n${'\x1b[1m'}Context bloat trend (late-half context vs early half)${'\x1b[0m'}`);
    out.push(
      table(
        ['Project', 'Source', 'Turns', 'Ctx/turn', 'Growth', 'Span', 'Dominant'],
        deep.bloatTrendSessions.map((s) => [
          s.project.length > 24 ? s.project.slice(0, 23) + '…' : s.project,
          s.source,
          String(s.turns),
          fmtTokens(s.avgContextTokens),
          s.contextGrowth.toFixed(1) + '×',
          s.durationMin + 'm',
          s.dominant,
        ]),
      ),
    );
  }
  if (deep.coldRestartSessions.length) {
    out.push(`\n${'\x1b[1m'}Cold restarts (turns resuming after the ~5-min cache TTL)${'\x1b[0m'}`);
    out.push(
      table(
        ['Project', 'Source', 'Turns', 'Cold turns', 'Re-paid tokens', 'Span'],
        deep.coldRestartSessions.map((s) => [
          s.project.length > 24 ? s.project.slice(0, 23) + '…' : s.project,
          s.source,
          String(s.turns),
          String(s.coldRestartTurns),
          fmtTokens(s.coldRestartTokens),
          s.durationMin + 'm',
        ]),
      ),
    );
  }
  const failing = deep.toolStats.filter((t) => t.errorRate > 0.05 && t.turns >= 20);
  if (failing.length) {
    out.push(`\n${'\x1b[1m'}Tool error rates (errors attributed to all tools in the failing turn)${'\x1b[0m'}`);
    out.push(
      table(
        ['Tool', 'Turns', 'Error turns', 'Error rate', 'Retry cost'],
        failing.map((t) => [
          t.tool,
          String(t.turns),
          String(t.errorTurns),
          (t.errorRate * 100).toFixed(1) + '%',
          fmtTokens(t.retryTokens),
        ]),
      ),
    );
  }
  const recs = enrichFindings(events, m, days);
  if (recs.length) {
    out.push(`\n${'\x1b[1m'}\x1b[32mRecommendations (evidence-cited)\x1b[0m`);
    out.push(...renderEnrichedRecs(recs));
  }
  out.push(
    `\n\x1b[2mAdd --llm to get prioritized recommendations from your local agent CLI (claude/gemini/codex).\x1b[0m\n`,
  );
  return out.join('\n');
}

export const LLM_AGENTS: Record<string, (prompt: string) => { cmd: string; args: string[] }> = {
  claude: (p) => ({ cmd: 'claude', args: ['-p', p] }),
  gemini: (p) => ({ cmd: 'gemini', args: ['-p', p] }),
  codex: (p) => ({ cmd: 'codex', args: ['exec', p] }),
};

export function detectAgent(): string | undefined {
  for (const name of Object.keys(LLM_AGENTS)) {
    const r = spawnSync('which', [name], { stdio: 'ignore' });
    if (r.status === 0) return name;
  }
  return undefined;
}

export function runLlm(prompt: string, agent: string): number {
  const spec = LLM_AGENTS[agent];
  if (!spec) {
    console.error(`Unknown agent "${agent}". Supported: ${Object.keys(LLM_AGENTS).join(', ')}`);
    return 1;
  }
  const { cmd, args } = spec(prompt);
  console.error(`Sending aggregate metrics (no prompts/code) to ${cmd} for analysis...\n`);
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  return r.status ?? 1;
}
