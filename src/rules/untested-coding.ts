import type { Rule } from './types.js';
import {
  CODING_FLOOR_TOKENS,
  TESTING_SHARE_CEILING,
  untestedCodingOffenders,
} from '../metrics.js';
import { fmtTokens } from '../fmt.js';
import type { StoredEvent } from '../store.js';

/** How many of the biggest offenders the evidence line names. */
const TOP_N = 3;

const rule: Rule = {
  key: 'untested-coding',
  metric: 'testingShare',
  direction: 'up',
  title: 'Coding-heavy projects with no agent-run tests',
  docs: `Per-project version of the window-wide testing warning: projects whose
agent transcript carries real coding spend while its testing share sits near
zero. The generalization of analyze's one-off note into a finding with evidence.

Deliberately an invest-MORE finding with no savings figure, like low-think-code:
pricing "write some tests" as a saving would be dishonest. The wording is a fact
about the transcript ("the agent never ran tests here"), not a claim that the
codebase lacks a suite; plenty of teams run tests outside the agent.

Gate and message agree by construction: Metrics counts the projects over
${Math.round(CODING_FLOOR_TOKENS / 1000)}k coding tokens whose testing share is
at or under ${TESTING_SHARE_CEILING * 100}%, and the rule fires only when that
count is above zero, so the finding always names something real. The tracked
metric is testingShare (window-wide), the number a team wants moving up.`,
  fires: (m) =>
    m.untestedCodingProjects > 0
      ? `The agent wrote code in ${m.untestedCodingProjects} project(s) where its transcript shows no test turns. Whatever your suite situation is, the transcript shows no verification loop there.`
      : undefined,
  score: (s) => {
    let codingTokens = 0;
    let testingTokens = 0;
    for (const e of s.events) {
      if (e.activity === 'coding') codingTokens += e.input_tokens + e.output_tokens;
      else if (e.activity === 'testing') testingTokens += e.input_tokens + e.output_tokens;
    }
    if (codingTokens < CODING_FLOOR_TOKENS || testingTokens > 0) return { score: 0, label: '' };
    return {
      score: codingTokens,
      label: `${s.project}: ${fmtTokens(codingTokens)} coding, no test turns`,
    };
  },
  clause: ({ events }) => {
    const list = untestedCodingOffenders(events);
    if (!list.length) return '';
    const names = list
      .slice(0, TOP_N)
      .map((o) => `${o.project} (${fmtTokens(o.codingTokens)})`)
      .join(', ');
    return ` ${list.length} project(s) show heavy coding with no agent-run tests: ${names}.`;
  },
};

export default rule;
