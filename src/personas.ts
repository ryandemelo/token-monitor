import type { Metrics } from './metrics.js';

/**
 * Usage personas — behavioral archetypes derived from how tokens are spent,
 * not who the user is. Each persona carries its own improvement levers.
 * Thresholds are heuristics tuned on real Claude Code / Gemini CLI traces;
 * adjust as your team's baseline emerges.
 */
export interface Persona {
  id: string;
  name: string;
  emoji: string;
  description: string;
  recommendations: string[];
}

const PERSONAS: Array<{ matches: (m: Metrics) => boolean; persona: Persona }> = [
  {
    matches: (m) => m.byActivity.testing.share >= 0.2 && m.reworkRatio >= 0.25,
    persona: {
      id: 'firefighter',
      name: 'Firefighter',
      emoji: '🚒',
      description:
        'Heavy test-fail-fix loops. Large share of tokens burned after the first test failure.',
      recommendations: [
        'Plan before coding: one planning turn before edits measurably cuts fix loops.',
        'Ask the agent to write/extend the test first, then implement against it.',
        'Run the narrowest test target (single file/case), not the whole suite, inside fix loops.',
      ],
    },
  },
  {
    matches: (m) => m.byActivity.exploration.share >= 0.45,
    persona: {
      id: 'explorer',
      name: 'Explorer',
      emoji: '🧭',
      description:
        'Most tokens go to reading and searching the codebase before any change lands.',
      recommendations: [
        'Invest in CLAUDE.md / GEMINI.md project docs — codebase maps cut repeated exploration.',
        'Delegate broad searches to cheap sub-agents instead of reading files into the main context.',
        'Keep sessions per-task: reusing one long session forces re-exploration after compaction.',
      ],
    },
  },
  {
    matches: (m) =>
      m.byActivity.thinking.share < 0.05 &&
      m.byActivity.coding.share >= 0.4 &&
      m.reworkRatio >= 0.15,
    persona: {
      id: 'sprinter',
      name: 'Sprinter',
      emoji: '🏃',
      description: 'Straight to code with minimal planning; rework eats the saved time.',
      recommendations: [
        'Use plan mode (or an explicit "plan first" instruction) on tasks touching >2 files.',
        'Write the full task spec in the first message — underspecified prompts cause thrash.',
        'Review the diff before asking for the next change; stacked corrections compound cost.',
      ],
    },
  },
  {
    matches: (m) =>
      m.cacheHitRatio >= 0.7 && m.reworkRatio < 0.1 && m.byActivity.exploration.share < 0.25,
    persona: {
      id: 'surgeon',
      name: 'Surgeon',
      emoji: '🔪',
      description:
        'Precise, low-waste usage: high cache reuse, little rework, targeted exploration.',
      recommendations: [
        'Baseline profile — document this workflow and share it with the team.',
        'Watch model mix: precise sessions often run fine one model tier cheaper.',
      ],
    },
  },
  {
    matches: (m) => m.byActivity.thinking.share >= 0.15 && m.reworkRatio < 0.15,
    persona: {
      id: 'architect',
      name: 'Architect',
      emoji: '📐',
      description: 'Deliberate planner — thinking/defining up front, low rework downstream.',
      recommendations: [
        'Healthy pattern. If latency matters, try lower effort/model on the pure-planning turns.',
        'Convert recurring plans into project docs or skills so the agent stops re-deriving them.',
      ],
    },
  },
];

const BALANCED: Persona = {
  id: 'balanced',
  name: 'Balanced',
  emoji: '⚖️',
  description: 'No single dominant pattern — spend is spread across activities.',
  recommendations: [
    'Check the cache hit ratio first: below ~50% usually means session/prompt structure issues.',
    'Compare per-project breakdowns — one project often hides an expensive workflow.',
  ],
};

export function assignPersona(m: Metrics): Persona {
  for (const { matches, persona } of PERSONAS) {
    if (matches(m)) return persona;
  }
  return BALANCED;
}

/** Cross-cutting findings independent of persona. */
export function generalRecommendations(m: Metrics): string[] {
  const recs: string[] = [];
  if (m.cacheHitRatio < 0.5 && m.spendTokens > 100_000) {
    recs.push(
      `Cache hit ratio ${(m.cacheHitRatio * 100).toFixed(0)}% — low. Cache reads cost ~10% of fresh input; long-lived sessions and stable system context raise this. Biggest single cost lever.`,
    );
  }
  if (m.reworkRatio > 0.2) {
    recs.push(
      `${(m.reworkRatio * 100).toFixed(0)}% of spend happens after test failures. Plan-first workflows and tighter task specs cut this.`,
    );
  }
  if (m.thinkToCodeRatio < 0.15 && m.byActivity.coding.tokens > 50_000) {
    recs.push(
      'Very low think:code ratio. Teams that spend 15-30% of tokens on planning/exploration ship with less rework.',
    );
  }
  const models = Object.entries(m.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  const premium = models.filter(([name]) => /fable|opus|gpt-5(?!.*mini)|gemini-.*pro/i.test(name));
  if (premium.length && models.length > 1) {
    const premiumShare = premium.reduce((s, [, v]) => s + v.tokens, 0) / (m.spendTokens || 1);
    if (premiumShare > 0.9) {
      recs.push(
        `${(premiumShare * 100).toFixed(0)}% of tokens on premium models. Route exploration and boilerplate turns to a cheaper tier.`,
      );
    }
  }
  return recs;
}
