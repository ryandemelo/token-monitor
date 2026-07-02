/**
 * Project-family resolution — folds a session's monorepo-subdirectory cwds
 * into ONE canonical project name, so `report` doesn't fragment a repo into
 * per-subdir rows ("backend"/"frontend" out of one session that cd-ed
 * around) and `categorize` doesn't read those fragments as "duplicate work
 * across ≥2 projects".
 *
 * Mechanism: descendant adoption over the session's OWN observed cwds. A cwd
 * that is a path-descendant of another observed cwd adopts the shallowest
 * observed ancestor's basename. Zero disk access, identical answers for live
 * and deleted paths, and structurally unable to over-merge sibling projects
 * because a label is only ever adopted from a directory the session actually
 * visited.
 *
 * Git-root resolution (walking up to `.git`, following worktree pointers)
 * was built, dogfooded, and REJECTED: on a real umbrella repo it folded five
 * distinct products (goose, openwebui, kevq/process, quaestor-cl,
 * corporate-site) into one "metis" row, while sessions on deleted worktree
 * paths — which can't walk the disk — kept the subdir name, splitting one
 * family into two labels. A wrong merge silently corrupts the duplicate-work
 * signal the product sells; a missed merge only under-reports. The anchor
 * directory a session was opened in matches the agent's own workspace notion
 * and never surprises. Name heuristics (stripping "-iter-NN") are absent for
 * the same reason; worktree checkouts that SHOULD fold into their repo are
 * the user's call via ~/.token-monitor/project-aliases.json.
 */

/** Basename that tolerates either separator — cwds may come from another OS's logs. */
function lastSegment(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/**
 * A directory this shallow (`/`, `/Users`, `/Users/ryan`) is a launch
 * location, not a project: a session started in the home dir must not
 * relabel every repo it cd-s into as "ryan". Three path segments
 * (`/Users/ryan/Documents`…) is the shallowest thing that can plausibly BE a
 * project, so only those may donate their name to descendants.
 */
function canDonate(normPath: string): boolean {
  return normPath.split('/').filter(Boolean).length >= 3;
}

/**
 * Label each observed cwd of ONE session. A cwd that is a path-descendant of
 * another observed cwd adopts the SHALLOWEST observed ancestor's basename
 * (a session that visited `…/kevq/process` and `…/kevq/process/backend` is
 * one project: `process`). Unrelated cwds keep their own basename — sibling
 * projects under a common parent can never merge, because the parent itself
 * was never visited — and near-root launch dirs never donate (canDonate).
 */
export function collapseSessionCwds(cwds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const uniq = [...new Set(cwds)];
  const norm = new Map(uniq.map((c) => [c, c.replace(/\\/g, '/').replace(/\/+$/, '')]));
  // Shallowest-first (shortest normalized path), so the first matching
  // ancestor is the shallowest one the session visited.
  const sorted = [...uniq].sort((a, b) => {
    const na = norm.get(a)!, nb = norm.get(b)!;
    return na.length - nb.length || (na < nb ? -1 : na > nb ? 1 : 0);
  });
  for (const c of uniq) {
    const nc = norm.get(c)!;
    let label = lastSegment(nc);
    for (const anc of sorted) {
      if (anc === c) continue;
      const na = norm.get(anc)!;
      if (canDonate(na) && nc.startsWith(na + '/')) {
        label = lastSegment(na);
        break;
      }
    }
    out.set(c, label);
  }
  return out;
}

/**
 * One project per session: the DOMINANT label over all events' cwds (after
 * descendant adoption), first-seen order breaking ties. Dominant beats
 * first-seen because sessions are often launched in a parent/launcher dir
 * and immediately cd into the real workspace — where the work happens is
 * the project. A single-cwd session is byte-identical to plain
 * basename(cwd). Pass one cwd PER EVENT (with repeats), not a unique set.
 */
export function sessionProjectOf(eventCwds: string[]): string | undefined {
  if (eventCwds.length === 0) return undefined;
  const labels = collapseSessionCwds(eventCwds);
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  eventCwds.forEach((c, i) => {
    const l = labels.get(c)!;
    counts.set(l, (counts.get(l) ?? 0) + 1);
    if (!firstSeen.has(l)) firstSeen.set(l, i);
  });
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!,
  )[0][0];
}
