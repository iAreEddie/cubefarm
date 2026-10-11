// The browser monitor's screen and controls (#24): an address bar and navigation, a plain page in a sandboxed frame,
// or a YouTube video in its own player with play/pause, seeking, volume and fullscreen. One instance per placed
// monitor, keyed by its stable id; the address and volume are saved so a reload brings them back. Nothing here knows
// whether it's drawn on the wall in the office or in a phone's panel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMBED_BLOCKED_TEXT, parseMonitor, youtubeErrorText } from '../../../shared/monitor';
import { DEFAULT_MONITOR, type MonitorState } from '../../../shared/progress';
import { api } from '../api';
import { loadYouTube, type YouTubePlayer, type YouTubeNamespace } from '../world/decor/monitors';

const SLOW_LOAD_MS = 9000;
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';

export interface BrowserSurfaceProps {
  repoId: string;
  id: string;
  initial?: MonitorState;
  /** Return to walking (or close the panel); playback keeps going on the wall. */
  onClose: () => void;
  /** Office: only the open screen takes the mouse and the keyboard. */
  focused?: boolean;
  /** Office: a bigger, closer view of the same screen (never a second player). */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export function BrowserSurface({ repoId, id, initial, onClose, focused = true, expanded = false, onToggleExpand }: BrowserSurfaceProps) {
  const start = initial ?? DEFAULT_MONITOR;
  const [url, setUrl] = useState(start.url ?? '');
  const [draft, setDraft] = useState(start.url ?? '');
  const [volume, setVolume] = useState(start.volume ?? DEFAULT_MONITOR.volume);
  const [muted, setMuted] = useState(!!start.muted);
  const [powered, setPowered] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [hist, setHist] = useState<string[]>([start.url ?? '']);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const target = useMemo(() => parseMonitor(url), [url]);

  // ---------- persisting the address and volume ----------
  const saveTimer = useRef<number | undefined>(undefined);
  const persist = useCallback(
    (patch: Partial<MonitorState>) => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void api.saveMonitor(repoId, id, patch).catch(() => undefined), 600);
    },
    [repoId, id],
  );
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const applyUrl = useCallback(
    (next: string) => {
      setUrl(next);
      setDraft(next);
      setNonce((n) => n + 1);
      setLoaded(false);
      setSlow(false);
      persist({ url: next });
    },
    [persist],
  );

  const navigate = useCallback(
    (raw: string) => {
      const parsed = parseMonitor(raw);
      if (parsed.kind === 'invalid') {
        setDraft(raw);
        return;
      }
      const next = parsed.kind === 'home' ? '' : parsed.url;
      setHist((h) => [...h.slice(0, idx + 1), next]);
      setIdx((i) => i + 1);
      applyUrl(next);
    },
    [idx, applyUrl],
  );

  const jump = useCallback(
    (to: number) => {
      if (to < 0 || to >= hist.length || to === idx) return;
      setIdx(to);
      applyUrl(hist[to]);
    },
    [hist, idx, applyUrl],
  );

  // ---------- power, tab focus ----------
  // Leaving the tab (or powering off) stops the sound at once; the same monitor never runs a hidden second player.
  const [wasPlaying, setWasPlaying] = useState(false);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onVis = () => {
      const hidden = document.hidden;
      setSuspended(hidden);
      if (hidden) {
        const p = playerRef.current;
        if (p) {
          setWasPlaying(p.getPlayerState() === 1);
          p.pauseVideo();
        }
      } else if (wasPlaying) {
        playerRef.current?.playVideo();
        setWasPlaying(false);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [wasPlaying]);

  useEffect(() => {
    if (!powered) playerRef.current?.pauseVideo();
  }, [powered]);

  // ---------- Escape returns to walking while the office UI has focus ----------
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, onClose]);

  // ---------- the page frame ----------
  useEffect(() => {
    if (target.kind !== 'page' || suspended) return;
    setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(t);
  }, [target.kind, target.kind === 'page' ? target.url : '', nonce, suspended]);

  // ---------- the YouTube player ----------
  const ytHost = useRef<HTMLDivElement>(null);
  const [ytReady, setYtReady] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const videoId = target.kind === 'youtube' ? target.id : null;

  useEffect(() => {
    if (!videoId || !powered) return;
    let alive = true;
    setYtReady(false);
    setYtError(null);
    setPlaying(false);
    loadYouTube()
      .then((YT: YouTubeNamespace) => {
        if (!alive || !ytHost.current) return;
        const player = new YT.Player(ytHost.current, {
          videoId,
          playerVars: { origin: location.origin, enablejsapi: 1, playsinline: 1, rel: 0, autoplay: 0, controls: 1 },
          events: {
            onReady: () => {
              if (!alive) return;
              playerRef.current = player;
              player.setVolume(muted ? 0 : volume);
              if (muted) player.mute();
              setYtReady(true);
            },
            onStateChange: (e: { data: number }) => setPlaying(e.data === 1),
            onError: (e: { data: number }) => setYtError(youtubeErrorText(e.data)),
          },
        });
      })
      .catch((err: unknown) => {
        if (alive) setYtError((err as Error).message);
      });
    return () => {
      alive = false;
      try {
        playerRef.current?.destroy();
      } catch {
        // the player may already be gone
      }
      playerRef.current = null;
      setPlaying(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, powered, nonce]);

  useEffect(() => {
    playerRef.current?.setVolume(volume);
    if (muted) playerRef.current?.mute();
    else playerRef.current?.unMute();
    persist({ volume, muted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, muted]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const p = playerRef.current;
      if (p) {
        setTime(p.getCurrentTime());
        setDuration(p.getDuration());
      }
    }, 500);
    return () => clearInterval(t);
  }, [playing]);

  const requestFullscreen = () => {
    const el = (playerRef.current?.getIframe() ?? surfaceRef.current) as HTMLElement | null;
    void el?.requestFullscreen?.().catch(() => undefined);
  };
  const openExternal = target.kind === 'youtube' ? `https://www.youtube.com/watch?v=${target.id}` : url;

  const seek = (seconds: number) => {
    playerRef.current?.seekTo(seconds, true);
    setTime(seconds);
  };

  return (
    <div ref={surfaceRef} className={`monitor-surface ${focused ? '' : 'monitor-idle'} ${expanded ? 'monitor-expanded' : ''}`}>
      <div className="monitor-bar" role="toolbar" aria-label="Browser controls">
        <button className="monitor-btn" onClick={() => jump(idx - 1)} disabled={idx <= 0} title="Back through what you entered" aria-label="Back">
          ◀
        </button>
        <button className="monitor-btn" onClick={() => jump(idx + 1)} disabled={idx >= hist.length - 1} title="Forward through what you entered" aria-label="Forward">
          ▶
        </button>
        <button className="monitor-btn" onClick={() => setNonce((n) => n + 1)} disabled={!url} title="Reload" aria-label="Reload">
          ⟳
        </button>
        <form
          className="monitor-address"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(draft);
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search? No—type an http(s) address or a YouTube link" spellCheck={false} aria-label="Address" />
          <button className="monitor-btn" type="submit" title="Go">
            Go
          </button>
        </form>
        <button className="monitor-btn" onClick={() => navigate('')} title="Home" aria-label="Home">
          ⌂
        </button>
        <button className="monitor-btn" onClick={() => setPowered((p) => !p)} title={powered ? 'Power off (stops sound)' : 'Power on'} aria-label="Power" aria-pressed={powered}>
          ⏻
        </button>
        <button className="monitor-btn" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute' : 'Mute'} aria-label="Mute" aria-pressed={muted} disabled={!videoId}>
          {muted ? '🔇' : '🔊'}
        </button>
        <input
          className="monitor-vol"
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          disabled={!videoId}
          title={videoId ? 'Volume' : 'The page controls its own sound'}
          aria-label="Volume"
        />
        {onToggleExpand && (
          <button className={`monitor-btn ${expanded ? 'monitor-btn-on' : ''}`} onClick={onToggleExpand} aria-pressed={expanded} title="Enlarge this view" aria-label="Enlarge">
            ⤢
          </button>
        )}
        <button className="monitor-btn" onClick={requestFullscreen} title="Fullscreen" aria-label="Fullscreen">
          ⛶
        </button>
        <button className="monitor-btn monitor-close" onClick={onClose} title="Close and go back to walking">
          ✕ Close
        </button>
      </div>

      <div className="monitor-screen">
        {!powered ? (
          <div className="monitor-off" role="status">
            <span>⏻</span>
            <p>The monitor is off. Press power to switch it back on; its address and volume are kept.</p>
          </div>
        ) : target.kind === 'home' ? (
          <HomeSurface onSubmit={navigate} />
        ) : target.kind === 'invalid' ? (
          <div className="monitor-note">
            <h4>That link can't open here</h4>
            <p>{target.reason}</p>
          </div>
        ) : target.kind === 'youtube' ? (
          <div className="monitor-yt">
            <div key={videoId} ref={ytHost} className="monitor-yt-host" />
            {ytError && (
              <div className="monitor-note monitor-over" role="alert">
                <h4>This video won't play here</h4>
                <p>{ytError}</p>
                <a className="btn btn-small" href={openExternal} target="_blank" rel="noreferrer">
                  Open in YouTube ↗
                </a>
              </div>
            )}
            {!ytError && (
              <div className="monitor-yt-bar">
                <button className="monitor-btn" onClick={() => (playing ? playerRef.current?.pauseVideo() : playerRef.current?.playVideo())} disabled={!ytReady} title={playing ? 'Pause' : 'Play'}>
                  {playing ? '❚❚' : '▶'}
                </button>
                <input
                  className="monitor-seek"
                  type="range"
                  min={0}
                  max={Math.max(1, Math.floor(duration))}
                  value={Math.min(time, duration || 0)}
                  onChange={(e) => seek(Number(e.target.value))}
                  disabled={!ytReady || !duration}
                  aria-label="Seek"
                />
                <span className="monitor-time">{`${clock(time)} / ${clock(duration)}`}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="monitor-page">
            {suspended ? null : (
              <iframe
                key={`${target.url}|${nonce}`}
                className="monitor-frame"
                src={target.url}
                title="Browser monitor page"
                sandbox={SANDBOX}
                allow="autoplay; fullscreen; clipboard-write; picture-in-picture"
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={() => {
                  setLoaded(true);
                  setSlow(false);
                }}
              />
            )}
            {(slow || !loaded) && (
              <div className="monitor-hint" role="status">
                <span>{slow ? EMBED_BLOCKED_TEXT : 'Loading…'}</span>
                <a className="btn btn-small" href={target.url} target="_blank" rel="noreferrer">
                  Open in browser ↗
                </a>
              </div>
            )}
            {slow && <p className="monitor-foot small">{EMBED_BLOCKED_TEXT}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

const clock = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** The monitor's own home: a place to paste a link, plus a word on what it can and can't show. */
function HomeSurface({ onSubmit }: { onSubmit: (raw: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="monitor-home">
      <h4>📺 Browser monitor</h4>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste a video or page link (YouTube, https://…)" spellCheck={false} aria-label="Open a link" />
        <button className="btn btn-small btn-good" type="submit">
          Open
        </button>
      </form>
      <p className="muted small">
        YouTube watch, youtu.be and embed links open in its player. Other http(s) pages open in a frame when the site allows it; if it refuses, use <b>Open in browser</b>.
      </p>
    </div>
  );
}
