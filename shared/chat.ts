import type { AgentCli, LogLine } from './types.ts';

// The agent conversation as chat sections (#26). Both runtimes arrive as the same flat LogLine[]: the Agent SDK's
// stream and the terminal CLIs' hooks. This folds those lines into readable sections — messages, tool calls and
// thought/reasoning blocks — and groups consecutive thought lines into one section that keeps a stable id while it
// streams, so the panel can expand and collapse each one on its own.

/** One section of the agent's chat. */
export interface ChatEntry {
  /** Stable while the section streams: derived from its first log line's id. */
  id: string;
  kind: 'message' | 'thought' | 'tool' | 'result' | 'system' | 'error' | 'manager' | 'done';
  at: number;
  text: string;
  tool?: string;
  /** How many log lines are folded into it (a thought grows as more thinking streams in). */
  lines: number;
}

// The server prefixes assistant text with "● " (first line) and two spaces (the rest) for the terminal's look; the chat
// strips that back off so a message reads as the model wrote it.
const LINE_MARKER = /^(?:●\s| {2})/;

/** The plain text of a run of assistant message lines, markers removed. */
export function messageText(lines: readonly LogLine[]): string {
  return lines.map((l) => l.text.replace(LINE_MARKER, '')).join('\n');
}

/** The text of a run of thinking lines, blank lines between them, trimmed. */
export function thoughtText(lines: readonly LogLine[]): string {
  return lines
    .map((l) => l.text.replace(/^✻\s*/, ''))
    .join('\n\n')
    .trim();
}

/** A compact one-line label for a thought section (its first non-empty line, clipped). */
export function thoughtLabel(text: string, max = 80): string {
  const first = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

type GroupKind = 'thought' | 'message' | 'result';
const groupable = (kind: LogLine['kind']): GroupKind | null => (kind === 'thinking' ? 'thought' : kind === 'text' ? 'message' : kind === 'result' ? 'result' : null);

/**
 * Folds a run of log lines into chat sections. Consecutive message lines become one message, consecutive result lines
 * one result, and consecutive thinking lines one thought section. Any other kind is a section of its own.
 */
export function foldChat(lines: readonly LogLine[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  let group: { kind: GroupKind; lines: LogLine[] } | null = null;
  const flush = () => {
    if (!group) return;
    const first = group.lines[0];
    const text = group.kind === 'message' ? messageText(group.lines) : group.kind === 'thought' ? thoughtText(group.lines) : group.lines.map((l) => l.text).join('\n');
    if (text.trim() || group.kind === 'result') out.push({ id: `${group.kind[0]}:${first.id}`, kind: group.kind, at: first.t, text, lines: group.lines.length });
    group = null;
  };
  for (const line of lines) {
    const kind = groupable(line.kind);
    if (kind) {
      if (group && group.kind === kind) group.lines.push(line);
      else {
        flush();
        group = { kind, lines: [line] };
      }
      continue;
    }
    flush();
    out.push({ id: `l:${line.id}`, kind: line.kind as ChatEntry['kind'], at: line.t, text: line.text, tool: line.tool, lines: 1 });
  }
  flush();
  return out;
}

/**
 * Whether a CLI exposes the model's reasoning as text the office can show. Claude Code's transcript and OpenCode's
 * message parts carry thinking; Codex keeps its reasoning summaries in its own session files, not in what its notify
 * program or hooks report, so the office cannot show them.
 */
export function thoughtsSupported(cli: AgentCli): boolean {
  return cli === 'claude' || cli === 'opencode';
}
