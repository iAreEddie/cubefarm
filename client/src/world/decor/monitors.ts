// The browser monitor's client runtime (#24): which screen the player is using (so the office lets go of the mouse
// and stops moving while its page has the keyboard), and the one-time load of YouTube's IFrame API. A monitor's own
// address and volume live in its component, keyed by its stable instance id.
import { create } from 'zustand';

/** The monitor whose controls are open, as the player sees them: E opens it, Close or Esc returns to walking. */
export interface MonitorUse {
  repoId: string;
  slot: string;
  id: string;
}

interface MonitorUseState {
  use: MonitorUse | null;
  /** Open a placed monitor's controls (and hand it the mouse). */
  open(u: MonitorUse): void;
  /** Return to walking; the video carries on playing on the wall. */
  close(): void;
}

export const useMonitor = create<MonitorUseState>((set) => ({
  use: null,
  open(use) {
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
    set({ use });
  },
  close() {
    set({ use: null });
  },
}));

/** Whether some monitor currently has the keyboard, so the office ignores walking keys. */
export const monitorInUse = () => useMonitor.getState().use;

// A probe for QA and Playwright: which monitor is in use, and how to open or close one (window.__swarmMonitor).
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  if (!w.__swarmMonitor) {
    w.__swarmMonitor = {
      use: () => useMonitor.getState().use,
      open: (u: MonitorUse) => useMonitor.getState().open(u),
      close: () => useMonitor.getState().close(),
    };
  }
}

// ---------- YouTube's IFrame API ----------

/** The slice of the YouTube player API the monitor uses (https://developers.google.com/youtube/iframe_api_reference). */
export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getIframe(): HTMLIFrameElement;
  destroy(): void;
}

export interface YouTubeNamespace {
  Player: new (el: HTMLElement, options: unknown) => YouTubePlayer;
  PlayerState: { UNSTARTED: number; ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
}

let ytPromise: Promise<YouTubeNamespace> | null = null;

/** Load YouTube's IFrame API once (or fail: offline, blocked, or too slow). */
export function loadYouTube(): Promise<YouTubeNamespace> {
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    const w = window as unknown as { YT?: YouTubeNamespace; onYouTubeIframeAPIReady?: () => void };
    if (w.YT?.Player) return resolve(w.YT);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('YouTube took too long to load; the monitor may be offline.'))), 12_000);
    const prior = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prior?.();
      if (w.YT?.Player) finish(() => resolve(w.YT!));
      else finish(() => reject(new Error('YouTube player unavailable')));
    };
    if (!document.querySelector('script[data-cf-youtube]')) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.dataset.cfYoutube = '1';
      s.onerror = () => finish(() => reject(new Error('YouTube could not be reached (offline?)')));
      document.head.appendChild(s);
    }
  });
  return ytPromise;
}
