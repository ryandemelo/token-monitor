import type { Activity, UsageEvent } from './types.js';

// Tool names across vendors, normalized to lowercase for matching.
const WRITE_TOOLS = new Set([
  'edit', 'write', 'multiedit', 'notebookedit', 'apply_patch',
  'write_file', 'replace', 'edit_file', 'create_file',
  'str_replace_editor', 'str_replace_based_edit_tool',
]);

const SHELL_TOOLS = new Set([
  'bash', 'shell', 'run_shell_command', 'run_terminal_cmd', 'local_shell', 'exec_command',
]);

const READ_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'webfetch', 'websearch', 'agent', 'task', 'explore', 'toolsearch',
  'read_file', 'read_many_files', 'search_file_content', 'list_directory', 'find_files',
  'google_web_search', 'web_fetch', 'codebase_search', 'view',
]);

const PLAN_TOOLS = new Set([
  'enterplanmode', 'exitplanmode', 'todowrite', 'taskcreate', 'taskupdate', 'update_plan', 'plan',
]);

const TEST_RE =
  /\b(pytest|jest|vitest|mocha|playwright test|go test|cargo test|npm (run )?test|yarn test|pnpm test|bun test|phpunit|rspec|unittest|tox|mvn test|gradle test|ctest|make test|rails test)\b/i;

const SHIP_RE = /\bgit\s+(commit|push)\b|\bgh\s+pr\b|\bgit\s+merge\b/i;

function norm(name: string): string {
  return name.toLowerCase().replace(/^mcp__\S+__/, '');
}

/**
 * Classify a turn by what its tool calls did. Priority order matters:
 * shipping/testing are detected from shell commands, coding from write
 * tools, planning from plan tools, exploration from read-only tools.
 */
export function classify(ev: UsageEvent): Activity {
  const tools = ev.tools.map(norm);
  const cmds = ev.commands.join('\n');

  if (SHIP_RE.test(cmds)) return 'shipping';
  if (TEST_RE.test(cmds)) return 'testing';
  if (tools.some((t) => WRITE_TOOLS.has(t))) return 'coding';
  if (tools.some((t) => PLAN_TOOLS.has(t))) return 'thinking';
  if (tools.length > 0 && tools.every((t) => READ_TOOLS.has(t) || SHELL_TOOLS.has(t))) {
    // Read-only turn; bare shell counts as exploration unless it tested/shipped (handled above).
    return 'exploration';
  }
  if (tools.length > 0) return 'coding'; // unknown tools that act on the world
  if (ev.hasThinking || ev.thinkingTokens > 0) return 'thinking';
  return 'conversation';
}
