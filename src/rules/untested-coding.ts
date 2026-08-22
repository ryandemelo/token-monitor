import type { Rule } from './types.js';
import { groupBy } from '../metrics.js';
import { fmtTokens } from '../fmt.js';

/** Projects under this coding spend are too small to judge. */
const CODING_FLOOR_TOKENS = 100_000;
/** A project at or below this testing share counts as "the agent never ran tests". */
const TESTING_SHARE_CEILING = 0.02;
/** How many of the biggest offenders the evidence line names. */
const TOP_N = 3;

interface Offender {
  project: string;
  codingTokens: number;
  testingShare: number;
}

/**
 * Per-project view: coding-heavy projects where the agent ran essentially zero
 * test turns in this window. The wording is deliberately about what the agent
 * ran, not whether the codebase has tests — some suites run outside the
 * agent entirely.
 */
export function untestedProjects(events: import('../store.js').StoredEvent[]): Offender[] {
  const byProject = groupBy(events, 'project');
  const out: Offender[] = [];
  for (const [project, evs] of byProject) {
    let codingTokens = 0;
    let testingTokens = 0;
    for (const e of evs) {
      if (e.activity === 'coding') codingTokens += e.input_tokens + e.output_tokens + e.cache_creation_tokens;
      else if (e.activity === 'testing') testingTokens += e.input_tokens + e.output_tokens + e.cache_creation_tokens;
    }
    if (codingTokens < CODING_FLOOR_TOKENS) continue;
    const total = codingTokens + testingTokens;
    const testingShare = total ? testingTokens / total : 0;
    if (testingShare <= TESTING_SHARE_CEILING) {
      out.push({ project, codingTokens, testingShare });
    }
  }
  return out.sort((a, b) => b.codingTokens - a.codingTokens);
}

const rule: Rule = {
  key: 'untested-coding',
  metric: 'thinkToCodeRatio',
  direction: 'up',
  title: 'Coding-heavy projects with no agent-run tests',
  docs: `Per-project version of the window-wide testing warning: projects whose
agent transcript carries real coding spend while its testing share sits near
zero. The generalization of analyze's one-off note into a finding with evidence.

Deliberately an invest-MORE finding with no savings figure — like
low-think-code, pricing "write some tests" as a saving would be dishonest. The
wording is a fact about the transcript ("the agent never ran tests here"), not a
claim that the codebase lacks a suite; plenty of teams run tests outside the
agent.

Fires per project above ${Math.round(CODING_FLOOR_TOKENS / 1000)}k coding tokens
with testing share at or under ${TESTING_SHARE_CEILING * 100}%.`,
  fires: (m) =>
    m.byActivity.testing.share <= 0.05 && m.byActivity.coding.tokens > CODING_FLOOR_TOKENS
      ? 'The agent is writing code in projects it never runs tests in. Whatever your suite situation is, the transcript shows no verification loop.'
      : undefined,
  score: (s) => {
    let codingTokens = 0;
    let testingTokens = 0;
    for (const e of s.events) {
      if (e.activity === 'coding') codingTokens += e.input_tokens + e.output_tokens + e.cache_creation_tokens;
      else if (e.activity === 'testing') testingTokens += e.input_tokens + e.output_tokens + e.cache_creation_tokens;
    }
    if (codingTokens < CODING_FLOOR_TOKENS || testingTokens > 0) return { score: 0, label: '' };
    return {
      score: codingTokens,
      label: `${s.project}: ${fmtTokens(codingTokens)} coding, no test turns`,
    };
  },
  clause: ({ events }) => {
    const list = untestedProjects(events);
    if (!list.length) return '';
    const names = list
      .slice(0, TOP_N)
      .map((o) => `${o.project} (${fmtTokens(o.codingTokens)})`)
      .join(', ');
    return ` ${list.length} project(s) show heavy coding with no agent-run tests: ${names}.`;
  },
};

export default rule;
