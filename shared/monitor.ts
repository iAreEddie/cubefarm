// The browser monitor's addressing and playback rules (#24), pure and shared: turn whatever the player typed into
// something safe to load, tell a YouTube video link from an ordinary page, and explain the ways a site can refuse
// to be shown inside the office. Nothing here touches the DOM, so both sides and the tests can use it.

/** What a monitor is showing: its own home surface, an http(s) page in a frame, or a YouTube video in the player. */
export type MonitorTarget =
  | { kind: 'home' }
  | { kind: 'page'; url: string }
  | { kind: 'youtube'; id: string; url: string }
  | { kind: 'invalid'; reason: string };

/** Where a typed address points. Empty input is the home surface. */
export function parseMonitor(input: string): MonitorTarget {
  const raw = (input ?? '').trim();
  if (!raw) return { kind: 'home' };
  // A scheme-less entry is treated as https, the way a browser's address bar does.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { kind: 'invalid', reason: `“${raw}” isn't a web address.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: `${url.protocol.replace(':', '')} links aren't supported: the monitor opens http and https pages only.` };
  }
  const id = youtubeId(url);
  if (id) return { kind: 'youtube', id, url: url.href };
  return { kind: 'page', url: url.href };
}

const YT_VIDEO = /^[\w-]{11}$/;

/** The video id in a YouTube link (watch, youtu.be, embed, shorts, live), or null for its homepage and anything else. */
export function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '').replace(/^music\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return YT_VIDEO.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  const v = url.searchParams.get('v');
  if (v && YT_VIDEO.test(v)) return v;
  const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(url.pathname);
  return m ? m[1] : null;
}

/** The player URL for `id`, asking YouTube to identify us by `origin` (needed for playback and error 153). */
export function youtubeEmbedUrl(id: string, origin: string): string {
  return `https://www.youtube.com/embed/${id}?enablejsapi=1&playsinline=1&rel=0&origin=${encodeURIComponent(origin)}`;
}

/** The address the toolbar should show: what was typed, kept truthful even when a cross-origin page moves on its own. */
export function monitorAddress(url: string): string {
  return url || '';
}

/**
 * YouTube's player error codes, in plain words. 153 is Google's "no referrer/origin": our embedding page must send
 * its origin, and some networks or privacy settings strip it.
 * https://developers.google.com/youtube/iframe_api_reference#onError
 */
export const YOUTUBE_ERRORS: Record<number, string> = {
  2: 'The video link looks wrong (player error 2).',
  5: "This video can't play in the HTML5 player (player error 5).",
  100: 'This video was removed or made private (player error 100).',
  101: "The video's owner doesn't allow it to be embedded (player error 101).",
  150: "The video's owner doesn't allow it to be embedded (player error 150).",
  153: "YouTube refused the embed: the page's origin or referrer wasn't accepted (error 153). Open it in YouTube instead.",
};

export function youtubeErrorText(code: number): string {
  return YOUTUBE_ERRORS[code] ?? `The video wouldn't play (player error ${code}).`;
}

/** Shown when a page can't be framed in the office: X-Frame-Options or a CSP frame-ancestors rule refuses it. */
export const EMBED_BLOCKED_TEXT =
  "This site won't let another page show it inside a frame (its X-Frame-Options or Content-Security-Policy frame-ancestors rule). The monitor can't force it; open it in your browser instead.";

/** Shown while a page is taking long enough that it may be refusing to embed. */
export const EMBED_SLOW_TEXT = 'Still loading… some sites refuse to appear inside the office and only say so after a while.';
