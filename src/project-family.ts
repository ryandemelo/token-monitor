/**
 * Project-family resolution — folds monorepo subdirectories and git-worktree
 * checkouts into ONE canonical project name, so `report` doesn't fragment a
 * repo into per-subdir rows ("backend"/"frontend" out of one session that
 * cd-ed around) and `categorize` doesn't read two worktrees of the same repo
 * as "duplicate work across ≥2 projects".
 *
 * Two mechanisms, in order of trust:
 *   1. gitRootOf() — resolve a cwd against the REAL repo layout on disk:
 *      walk up to the first `.git`, and follow a worktree's `.git`-FILE
 *      `gitdir:` pointer back to the main checkout. Truth from git itself.
 *   2. collapseSessionCwds() — when paths are dead (deleted worktrees, logs
 *      from another machine), descendant-adoption WITHIN one session's
 *      observed cwds: zero disk access, and structurally unable to over-merge
 *      sibling repos because a label is only ever adopted from an ancestor
 *      the session actually visited.
 *
 * Name heuristics (e.g. stripping "-iter-NN" suffixes) are deliberately
 * absent: a wrong merge silently corrupts the duplicate-work signal the
 * product sells, while a missed merge only under-reports.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * cwd -> resolved root, memoized: one kevq session carried 1255 events on a
 * single cwd, and every event of every historical file re-asks on collect.
 * Valid for one process run (the CLI is one-shot); tests reset explicitly.
 */
const rootCache = new Map<string, string | undefined>();

export function resetProjectFamilyCache(): void {
  rootCache.clear();
}

/** Basename that tolerates either separator — cwds may come from another OS's logs. */
function lastSegment(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/**
 * A worktree's `.git` is a FILE containing `gitdir: <path-into-main-checkout>`.
 * Map it back to the main repo root; a submodule (`/.git/modules/`) keeps the
 * containing dir — a submodule IS its own project, not its superproject.
 * Anything unparsable falls back to the containing dir (plain repo semantics).
 */
function resolveGitFile(gitFile: string, containing: string): string {
  try {
    const m = readFileSync(gitFile, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return containing;
    // Relative gitdirs resolve against the .git file's own directory.
    const gitdir = resolve(dirname(gitFile), m[1].trim());
    // \ -> / is length-preserving, so indexes found on the normalized copy
    // slice the original correctly (keeps native separators in the result).
    const norm = gitdir.replace(/\\/g, '/');
    const wt = norm.indexOf('/.git/worktrees/');
    if (wt !== -1) return gitdir.slice(0, wt);
    return containing;
  } catch {
    return containing;
  }
}

/**
 * Walk up from cwd to the enclosing git repo root, following worktree
 * pointers to the MAIN checkout. Returns undefined when nothing resolves —
 * dead paths, permission errors, network mounts all fail closed so callers
 * keep today's basename behavior. Capped at 32 levels (deeper is not a
 * real workspace; unbounded walks on cyclic mounts are worse).
 */
export function gitRootOf(cwd: string): string | undefined {
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let root: string | undefined;
  try {
    let dir = cwd;
    for (let i = 0; i < 32; i++) {
      const marker = join(dir, '.git');
      let st;
      try {
        st = statSync(marker);
      } catch {
        st = undefined;
      }
      if (st?.isDirectory()) {
        root = dir;
        break;
      }
      if (st?.isFile()) {
        root = resolveGitFile(marker, dir);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  } catch {
    root = undefined;
  }
  rootCache.set(cwd, root);
  return root;
}

/** Canonical project name for a cwd, or undefined when the path doesn't resolve. */
export function familyOf(cwd: string): string | undefined {
  const root = gitRootOf(cwd);
  return root ? lastSegment(root) : undefined;
}

/**
 * Dead-path fallback: label each observed cwd of ONE session without touching
 * disk. A cwd that is a path-descendant of another observed cwd adopts the
 * SHALLOWEST observed ancestor's basename (a session that visited
 * `…/kevq/process` and `…/kevq/process/backend` is one project: `process`).
 * Unrelated cwds keep their own basename — sibling repos under a common
 * parent can never merge, because the parent itself was never visited.
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
      if (nc.startsWith(na + '/')) {
        label = lastSegment(na);
        break;
      }
    }
    out.set(c, label);
  }
  return out;
}
