// The office's daily upstream check (#14), in plain words for the manager's console.
import type { UpstreamView } from '../../shared/types';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line for the Upstream row, e.g. "3 updates available" or "Up to date with upstream". */
export function upstreamStatusText(u: UpstreamView): string {
  switch (u.state) {
    case 'off':
      return 'Off';
    case 'unknown':
      return 'Not checked yet';
    case 'current':
      return u.ahead > 0 ? `Up to date (this fork is ${plural(u.ahead, 'commit')} ahead)` : 'Up to date with upstream';
    case 'updates':
      return `${plural(u.missing, 'update')} available`;
    case 'diverged':
      return `Diverged: ${plural(u.missing, 'upstream commit')}, ${u.ahead} of our own`;
    case 'failed':
      return 'Last check failed';
  }
}

/** A short "when", e.g. "3h ago", for the last check. */
export function upstreamSince(at: number | null, now = Date.now()): string {
  if (!at) return 'never';
  const mins = (now - at) / 60_000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
