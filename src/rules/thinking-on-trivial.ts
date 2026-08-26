import type { Rule } from './types.js';
import { parseTools, TRIVIAL_OUTPUT_TOKENS, TRIVIAL_THINKING_MIN_TURNS } from '../metrics.js';

const rule: Rule = {
  key: 'thinking-on-trivial',
  metric: 'thinkingOnTrivialShare',
  direction: 'down',
  family: 'routing',
  title: 'Metered reasoning on trivial conversation turns',
  docs: `Extended reasoning is useful when it earns a tool call, a decision or a
long answer. This rule looks for the opposite shape: separately metered reasoning
tokens on short conversation turns that called no tools. A few of those are noise;
a recurring pattern usually means the effort dial is set higher than the task.

The signal is deliberately conservative:

- **Separately metered reasoning only.** Some sources record that reasoning
  happened but fold its cost into ordinary output. Those turns stay unmeasured
  here rather than being attributed by guesswork.
- **Conversation only, and no tools.** Coding, exploration and tool-driven turns
  can legitimately reason briefly before doing visible work.
- **At least ${TRIVIAL_THINKING_MIN_TURNS} qualifying turns.** Isolated small turns do not establish a
  routing habit.

A turn qualifies when its visible output is at most ${TRIVIAL_OUTPUT_TOKENS} tokens. The share
is measured over all input and output spend; savings price the exact metered
reasoning tokens at the premium-minus-cheap rate delta.`,
  fires: (m) =>
    (m.thinkingOnTrivialTurns ?? 0) >= TRIVIAL_THINKING_MIN_TURNS &&
    (m.thinkingOnTrivialTokens ?? 0) > 0 &&
    (m.spendTokens ?? 0) > 0
      ? `${(m.thinkingOnTrivialShare * 100).toFixed(0)}% of spend is metered reasoning on ${m.thinkingOnTrivialTurns} trivial conversation turn(s). Lower reasoning effort for short chat turns, or move them to a cheaper tier when the model supports it.`
      : undefined,
  score: (s) => {
    const tokens = s.events.reduce(
      (sum, e) =>
        sum +
        (e.activity === 'conversation' &&
        e.output_tokens <= TRIVIAL_OUTPUT_TOKENS &&
        e.thinking_tokens > 0 &&
        parseTools(e.tools).length === 0
          ? e.thinking_tokens
          : 0),
      0,
    );
    return { score: tokens, label: `${tokens.toLocaleString()} thinking tok on trivial chat` };
  },
  savings: ({ m, rates }) =>
    (m.thinkingOnTrivialTokens ?? 0) * Math.max(0, rates.premium - rates.cheap),
};
export default rule;
