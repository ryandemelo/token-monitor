---
description: List the waste rules, which fire on this window, and explain one
---

Run `npx -y @ryandemelo/token-monitor rules` and show the user the catalogue: what each rule measures, which fire on their current window (marked ⚠), and which are priced versus advice-only.

If the user asks about a specific finding, run `npx -y @ryandemelo/token-monitor rules <key>` and explain it in their terms, including the caveats the rule's own documentation states.

If the user describes a waste pattern that no rule covers, tell them a rule is one file in `src/rules/`, one fixture and one test — and point them at CONTRIBUTING.md in https://github.com/ryandemelo/token-monitor. Several are pre-specced as `good first issue`.
