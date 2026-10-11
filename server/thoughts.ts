import fs from 'node:fs';

// Reasoning text the office can show, read from each CLI's own output — never invented and never a second model call
// (#26). The formats are the installed tools' own: Claude Code 2.1's transcript (JSONL), OpenCode 1.4's message parts
// (through its plugin), and, for completeness, Codex 0.161's rollout file. The parsers are pure and tested against
// fixtures so the office's behaviour is verified without a paid session (thoughts.test.ts).

/** The reasoning blocks in one Claude Code transcript line, if it is a sidechain-free assistant message. */
export function claudeThinking(line: string): string[] {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const msg = o as { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
  if (msg?.type !== 'assistant' || msg.isSidechain === true) return [];
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: 'thinking'; thinking: string } => !!b && (b as { type?: string }).type === 'thinking' && typeof (b as { thinking?: unknown }).thinking === 'string' && !!(b as { thinking: string }).thinking.trim())
    .map((b) => b.thinking);
}

/** The reasoning summaries in one Codex rollout line (a `response_item` of type `reasoning`). */
export function codexReasoning(line: string): string[] {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const item = (o as { type?: string; payload?: { type?: string; summary?: unknown } }).payload;
  if (item?.type !== 'reasoning' || !Array.isArray(item.summary)) return [];
  return item.summary
    .filter((s): s is { text: string } => !!s && typeof (s as { text?: unknown }).text === 'string' && !!(s as { text: string }).text.trim())
    .map((s) => s.text);
}

/** The reasoning text of an OpenCode assistant message's parts (the plugin reads them from the session). */
export function opencodeReasoning(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p): p is { type: 'reasoning'; text: string } => !!p && (p as { type?: string }).type === 'reasoning' && typeof (p as { text?: unknown }).text === 'string' && !!(p as { text: string }).text.trim())
    .map((p) => p.text);
}

export interface TranscriptLines {
  /** The complete lines that appeared after `from` (a trailing partial line is held back for the next read). */
  lines: string[];
  /** The byte offset to pass as `from` next time. */
  offset: number;
}

/**
 * The complete JSONL lines a growing file gained since byte `from`, and the new offset. Reads only the new bytes, so a
 * long transcript costs nothing to follow. A line without its closing newline waits for the next read.
 */
export function readNewLines(path: string, from = 0): TranscriptLines {
  let fd: number | undefined;
  try {
    const size = fs.statSync(path).size;
    if (size <= from) return { lines: [], offset: from };
    const len = size - from;
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(path, 'r');
    const read = fs.readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf8', 0, read);
    const nl = text.lastIndexOf('\n');
    if (nl < 0) return { lines: [], offset: from };
    const complete = text.slice(0, nl);
    return { lines: complete.split('\n').filter((l) => l.trim() !== ''), offset: from + Buffer.byteLength(complete, 'utf8') + 1 };
  } catch {
    return { lines: [], offset: from };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
