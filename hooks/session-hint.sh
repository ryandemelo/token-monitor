#!/usr/bin/env bash
# Opt-in SessionStart hint: which waste rules currently fire on your own data.
#
# OFF BY DEFAULT. Turn it on with:
#   touch ~/.token-monitor/session-hint
# or by exporting TOKEN_MONITOR_SESSION_HINT=1. Turn it off by removing either.
#
# Three things this must never do, because a session start is not a report:
#   - run `collect` (a scan takes seconds; starting a session is not the moment)
#   - reach the network (no npx: the CLI must already be installed)
#   - fail loudly (any problem here exits 0 with no output)
set -u

hint_enabled() {
  [ "${TOKEN_MONITOR_SESSION_HINT:-0}" = "1" ] && return 0
  [ -f "${HOME}/.token-monitor/session-hint" ] && return 0
  return 1
}

hint_enabled || exit 0
command -v token-monitor >/dev/null 2>&1 || exit 0
[ -f "${HOME}/.token-monitor/token-monitor.sqlite" ] || exit 0

firing=$(token-monitor rules --days 7 --json 2>/dev/null |
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const rules = JSON.parse(s).filter((r) => r.firing);
        if (rules.length) process.stdout.write(rules.map((r) => r.key).join(", "));
      } catch { /* nothing to say */ }
    });
  ' 2>/dev/null)

[ -n "${firing}" ] || exit 0
echo "token-monitor (last 7 days): ${firing}. Run \`token-monitor report\` for the evidence and the priced fix, or \`token-monitor rules <key>\` for what one measures."
exit 0
