// Finding file paths in agent-written prose, for Markdown.tsx's "Show in folder" links: Windows paths (with spaces
// when they're the whole of an `inline code`), file:// links and absolute POSIX paths under the usual top folders.
// The server checks every path again (server/reveal.ts); this only decides what looks clickable.

/** The phone's viewer reads these (server/reveal.ts TEXT_TYPES). */
const TEXT_TYPES = ['.md', '.txt', '.log'];

// POSIX paths only count under these, so routes (/api/state), subreddits and "and/or" stay text.
const POSIX_TOPS = 'home|Users|tmp|var|opt|srv|mnt|root|private|Volumes|media|workspace|workspaces|data|usr|etc';
const WIN = String.raw`[A-Za-z]:[\\/][^\s<>"'\x60|*?]+`;
const POSIX = String.raw`\/(?:${POSIX_TOPS})\/[^\s<>"'\x60|*?]+`;
const FILE_URL = String.raw`file:\/\/[^\s<>"'\x60]+`;
// Only at the start of a word: not the "/b/c" of a URL or the "C:" inside "ABC:\x".
const IN_TEXT = new RegExp(String.raw`(?<![\w\\/:.~-])(?:${FILE_URL}|${WIN}|${POSIX})`, 'g');
const WHOLE_CODE = new RegExp(String.raw`^(?:${FILE_URL}|[A-Za-z]:[\\/][^<>"|*?\n]+|\/(?:${POSIX_TOPS})\/[^<>"|*?\n]+)$`);

/** The path a file:// link points at (C:\… for a drive letter); null for another machine's or a broken one. */
export function fileUrlPath(url: string): string | null {
  const m = /^file:\/\/(localhost)?(\/.*)$/i.exec(url.trim());
  if (!m) return null;
  let p: string;
  try {
    p = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(p)) return p.slice(1).replace(/\//g, '\\');
  return /^\/\//.test(p) ? null : p;
}

const asPath = (s: string) => (/^file:/i.test(s) ? fileUrlPath(s) : s);

// Sentence punctuation after a path isn't part of it; a ")" is only when the path has no "(" of its own.
function trimEnd(s: string): string {
  let out = s.replace(/[.,;:!?'"\]}]+$/, '');
  while (out.endsWith(')') && !out.includes('(')) out = out.slice(0, -1).replace(/[.,;:!?'"\]}]+$/, '');
  return out;
}

/** A piece of text: plain, or a path (`path` set) written as `text`. */
export interface TextPiece {
  text: string;
  path?: string;
}

/** Splits plain text into its paths and the text between them; a single plain piece when there are none. */
export function splitPaths(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let at = 0;
  for (const m of text.matchAll(IN_TEXT)) {
    const raw = trimEnd(m[0]);
    const p = raw.length > 3 ? asPath(raw) : null;
    if (!p) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: raw, path: p });
    at = m.index + raw.length;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at) });
  return out;
}

/** The path an `inline code` span is, when it's nothing but one (spaces allowed); else null. */
export function codePath(code: string): string | null {
  const s = code.trim();
  return WHOLE_CODE.test(s) ? asPath(s) : null;
}

/** The file's name: what follows the last slash or backslash. */
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** The phone can read this file in its viewer (the server has the last word). */
export const isTextFile = (p: string) => TEXT_TYPES.some((ext) => p.toLowerCase().endsWith(ext));
