import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionSkillRow } from './store.js';
import { loadSessionSkills } from './store.js';
import type { CategoryRow } from './categorize.js';

/**
 * Skill ROI (#67) — closing the loop on the tool's own standing advice.
 *
 * `categorize` ends every duplicate-work finding with "codify it as a shared
 * skill/prompt instead of re-deriving it", and until now nothing measured
 * whether taking that advice worked. This does: it links a skill to the
 * category whose work it was meant to absorb, and compares how often that
 * category recurred before the skill first appeared against after.
 *
 * Two things this deliberately does NOT do:
 *
 * - **Count slash-command markers as skill invocations.** `<command-name>`
 *   markers exist in the transcripts, but on real data they are dominated by
 *   built-ins (/effort, /model, /compact, /login). Reading them as skills
 *   would report "/compact" as the team's most-adopted skill.
 * - **Freeze a baseline in a table.** The split point is the skill's first
 *   observed turn — a fact in the data, not a judgement — so recomputing it
 *   each run is more reproducible than storing it, and there is no id to go
 *   stale as clusters shift.
 */

export interface SkillUsage {
  skill: string;
  /** Turns attributed to the skill. See the store comment: turns, not uses. */
  turns: number;
  sessions: number;
  firstSeen: string;
  lastSeen: string;
  /** Seen historically but not once in the current window. */
  dormant: boolean;
}

export interface SkillRoi {
  skill: string;
  category: string;
  /** How the link was made — a manual map always wins over term overlap. */
  link: 'map' | 'terms';
  /** Category sessions per 30 days before the skill's first turn, and after. */
  beforePer30: number;
  afterPer30: number;
  /** Realized $/month, only when the two-condition gate below passes. */
  realizedUsdPerMonth?: number;
  estimated: boolean;
  /** Why no number is claimed yet, when none is. */
  status: 'realized' | 'tracking' | 'no-change' | 'insufficient-history';
}

export interface SkillReport {
  usage: SkillUsage[];
  roi: SkillRoi[];
  /** True when nothing in the store records skills at all (no Claude Code data). */
  unmeasured: boolean;
}

/** Each side of the before/after split needs this many days to mean anything. */
export const ROI_MIN_SIDE_DAYS = 7;
/** ...and this many sessions before the skill appeared, or the delta is noise. */
export const ROI_MIN_BEFORE_SESSIONS = 3;

/**
 * Tokens too generic to link on. Found by dogfooding: the first version
 * matched `code-review` to every category whose redacted terms contained
 * "code" — three of them — and reported a confident "$1,936/mo realized"
 * against categories the skill had nothing to do with.
 */
const GENERIC_TOKENS = new Set([
  'code', 'file', 'files', 'data', 'test', 'tests', 'task', 'tasks', 'work',
  'project', 'session', 'review', 'build', 'error', 'errors', 'fix', 'update',
  'check', 'user', 'time', 'name', 'type', 'list', 'page', 'line', 'lines',
]);

const SKILL_MAP_PATH = join(homedir(), '.token-monitor', 'skill-map.json');

/**
 * Manual category→skill links: `{"api auth jwt": "auth-helper"}`, keyed by the
 * category name `categorize` prints. Manual beats silently-wrong automatic
 * matching — the project-aliases.json precedent.
 */
export function loadSkillMap(path: string = SKILL_MAP_PATH): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [category, skill] of Object.entries(data)) {
      if (typeof skill === 'string' && skill) out[category.toLowerCase()] = skill;
    }
    return out;
  } catch {
    return {};
  }
}

/** Name tokens a skill and a category can be matched on. */
export function skillTokens(skill: string): string[] {
  return skill
    .toLowerCase()
    .replace(/^[^:]+:/, '') // drop a plugin prefix: "caveman:caveman" -> "caveman"
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t));
}

/**
 * Does this skill plausibly name this category's work? Deliberately strict:
 * a multi-token skill must match on at least two distinctive tokens, and a
 * single-token skill must match its one token exactly. Even then the link only
 * surfaces the pair for inspection — see computeRoi for why an automatic link
 * never produces a dollar figure.
 */
export function autoLinks(skill: string, terms: string[]): boolean {
  const tokens = skillTokens(skill);
  if (tokens.length === 0) return false;
  const set = new Set(terms.map((t) => t.toLowerCase()));
  const hits = tokens.filter((t) => set.has(t)).length;
  return tokens.length === 1 ? hits === 1 : hits >= 2;
}

export function summarizeUsage(rows: SessionSkillRow[], windowStart: string): SkillUsage[] {
  const map = new Map<string, { turns: number; sessions: Set<string>; first: string; last: string }>();
  for (const r of rows) {
    const s = map.get(r.skill) ?? { turns: 0, sessions: new Set<string>(), first: r.first_ts, last: r.last_ts };
    s.turns += r.turns;
    s.sessions.add(r.session_id);
    if (r.first_ts < s.first) s.first = r.first_ts;
    if (r.last_ts > s.last) s.last = r.last_ts;
    map.set(r.skill, s);
  }
  return [...map.entries()]
    .map(([skill, s]) => ({
      skill,
      turns: s.turns,
      sessions: s.sessions.size,
      firstSeen: s.first,
      lastSeen: s.last,
      dormant: s.last < windowStart,
    }))
    .sort((a, b) => b.turns - a.turns);
}

/**
 * Link a skill to a category, and measure the category's recurrence on each
 * side of the skill's first turn.
 *
 * `sessionDates` is category id -> the dates of that category's sessions, which
 * is what makes the before/after split possible without new storage.
 */
export function computeRoi(
  categories: CategoryRow[],
  sessionDates: Map<string, string[]>,
  usage: SkillUsage[],
  opts: { windowStart: string; windowEnd: string; map?: Record<string, string> },
): SkillRoi[] {
  const map = opts.map ?? {};
  const byName = new Map(usage.map((u) => [u.skill.toLowerCase(), u]));
  const out: SkillRoi[] = [];

  for (const category of categories) {
    const mapped = map[category.name.toLowerCase()];
    let skill: SkillUsage | undefined;
    let link: SkillRoi['link'] = 'map';
    if (mapped) {
      skill = byName.get(mapped.toLowerCase()) ?? { skill: mapped, turns: 0, sessions: 0, firstSeen: '', lastSeen: '', dormant: true };
    } else {
      skill = usage.find((u) => autoLinks(u.skill, category.terms));
      link = 'terms';
    }
    if (!skill || !skill.firstSeen) continue;

    const dates = (sessionDates.get(category.id) ?? []).slice().sort();
    if (dates.length === 0) continue;
    const split = Date.parse(skill.firstSeen);
    const start = Date.parse(opts.windowStart);
    const end = Date.parse(opts.windowEnd);
    const beforeDays = (split - start) / 86_400_000;
    const afterDays = (end - split) / 86_400_000;
    const before = dates.filter((d) => Date.parse(d) < split).length;
    const after = dates.length - before;

    const row: SkillRoi = {
      skill: skill.skill,
      category: category.name,
      link,
      beforePer30: beforeDays >= ROI_MIN_SIDE_DAYS ? (before / beforeDays) * 30 : 0,
      afterPer30: afterDays >= ROI_MIN_SIDE_DAYS ? (after / afterDays) * 30 : 0,
      estimated: true, // recurrence x average session cost is an approximation, always
      status: 'tracking',
    };

    if (beforeDays < ROI_MIN_SIDE_DAYS || afterDays < ROI_MIN_SIDE_DAYS) {
      // Most often this means the skill predates the window. Widening --days
      // is the fix, and saying so beats inventing a baseline.
      row.status = 'insufficient-history';
      out.push(row);
      continue;
    }

    const drop = row.beforePer30 - row.afterPer30;
    const usedInWindow = !skill.dormant;
    if (before < ROI_MIN_BEFORE_SESSIONS) {
      // Two sessions falling to none is not evidence a skill absorbed the work.
      row.status = 'insufficient-history';
    } else if (drop <= 0) {
      row.status = 'no-change';
    } else if (!usedInWindow) {
      row.status = 'tracking';
    } else if (link !== 'map') {
      // An automatic link is a CANDIDATE, never a causal claim. This tool
      // cannot know a skill was written to absorb a category's work; the user
      // can, and says so in skill-map.json. Dogfooding this on real data is
      // exactly what caught the alternative: "code-review" matched three
      // unrelated categories and priced them at four figures a month.
      row.status = 'tracking';
    } else {
      const avgCost = category.sessions > 0 ? category.cost / category.sessions : 0;
      row.realizedUsdPerMonth = Math.max(0, drop * avgCost);
      row.status = 'realized';
    }
    out.push(row);
  }
  return out.sort((a, b) => (b.realizedUsdPerMonth ?? -1) - (a.realizedUsdPerMonth ?? -1));
}

export function skillReport(
  db: DatabaseSync,
  categories: CategoryRow[],
  sessionDates: Map<string, string[]>,
  opts: { days: number; now?: number; mapPath?: string },
): SkillReport {
  const now = opts.now ?? Date.now();
  const windowStart = new Date(now - opts.days * 86_400_000).toISOString();
  const all = loadSessionSkills(db);
  if (all.length === 0) return { usage: [], roi: [], unmeasured: true };
  const usage = summarizeUsage(all, windowStart);
  return {
    usage,
    roi: computeRoi(categories, sessionDates, usage, {
      windowStart,
      windowEnd: new Date(now).toISOString(),
      map: loadSkillMap(opts.mapPath),
    }),
    unmeasured: false,
  };
}
