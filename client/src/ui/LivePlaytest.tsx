import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LivePlaytestStatus, LiveServerMessage, RepoView } from '../../../shared/types';
import type { Agent } from '../store';

// Watching the agent's own test browser live (#16): frames streamed from the office over /ws/live, which attaches
// read-only to the exact browser the agent's Playwright tools drive. Opening this view asks the office to capture;
// closing it (or hiding the tab) stops. The saved QA screenshots stay a separate thing, in the terminal tab.

const LABEL: Record<LivePlaytestStatus, string> = {
  off: 'No test browser yet',
  waiting: 'Waiting for the agent to open its browser…',
  live: 'Live',
  reconnecting: 'Reconnecting to the browser…',
  ended: 'Playtest ended — showing its last frame',
  unavailable: "Live capture isn't available here",
};

/** What the agent is on, for the header: the task and the issue or PR it belongs to. */
export function liveTaskLabel(agent: Agent): string {
  if (agent.task === 'qa') return `Testing PR #${agent.prNumber ?? '?'}`;
  if (agent.task === 'fix') return `Fixing PR #${agent.prNumber ?? '?'}`;
  if (agent.issueNumber) return `Issue #${agent.issueNumber}`;
  return 'Nothing assigned';
}

export function LivePlaytest({ agent, repo, className }: { agent: Agent; repo: RepoView; className?: string }) {
  const [status, setStatus] = useState<LivePlaytestStatus>('off');
  const [url, setUrl] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [big, setBig] = useState(false);
  const session = useRef(0);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    const connect = () => {
      if (stopped) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/ws/live?agent=${encodeURIComponent(agent.id)}`);
      ws = socket;
      socket.onmessage = (e) => {
        let m: LiveServerMessage;
        try {
          m = JSON.parse(String(e.data)) as LiveServerMessage;
        } catch {
          return;
        }
        if (m.t === 'state') {
          // A new capture (a new task): never keep a frame from the last one as if it were live.
          if (m.session !== session.current) {
            session.current = m.session;
            setSrc(null);
            setAt(null);
          }
          setStatus(m.status);
          setUrl(m.url);
        } else if (m.t === 'frame' && m.session === session.current) {
          setSrc(`data:${m.mime};base64,${m.data}`);
          setAt(m.at);
        }
      };
      socket.onopen = () => {
        retry = undefined;
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (!stopped) retry = window.setTimeout(connect, 1500);
      };
    };
    // Demand-driven: don't stream while the tab is hidden; pick it up again when it's back.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopped = true;
        window.clearTimeout(retry);
        ws?.close();
      } else {
        stopped = false;
        connect();
      }
    };
    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisibility);
      ws?.close();
    };
  }, [agent.id]);

  // Esc returns from the enlarged view instead of closing the whole panel.
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setBig(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [big]);

  const link: ReactNode =
    agent.prUrl && agent.prNumber ? (
      <a href={agent.prUrl} target="_blank" rel="noreferrer" className="chip">
        PR #{agent.prNumber}
      </a>
    ) : agent.issueNumber ? (
      <a href={`https://github.com/${repo.fullName}/issues/${agent.issueNumber}`} target="_blank" rel="noreferrer" className="chip">
        Issue #{agent.issueNumber}
      </a>
    ) : null;

  const body = (
    <>
      <div className="live-bar">
        <span className={`live-dot ${status === 'live' ? 'live-dot-on' : ''}`} aria-hidden />
        <strong>{agent.name}</strong>
        <span className="muted small">{liveTaskLabel(agent)}</span>
        {link}
        <span className="spacer" />
        <span className="muted small" role="status" aria-live="polite">
          {LABEL[status]}
        </span>
        <button className="btn btn-small" aria-pressed={big} title={big ? 'Return to the panel' : 'Enlarge the live view'} onClick={() => setBig((v) => !v)}>
          {big ? '⤡ Return' : '⤢ Enlarge'}
        </button>
      </div>
      <div className="live-page">
        {src ? (
          <img src={src} alt={`Live view of ${agent.name}'s test browser`} />
        ) : (
          <div className="live-empty">{LABEL[status]}</div>
        )}
        {status === 'ended' && <div className="live-ended">● Playtest ended · last frame</div>}
      </div>
      <div className="live-foot">
        <span className="live-url" title={url ?? ''}>
          🔒 {url ?? 'about:blank'}
        </span>
        {at && <span className="muted small">frame {new Date(at).toLocaleTimeString()}</span>}
      </div>
    </>
  );

  // Enlarged, the view is lifted to the document body so no panel transform or overflow can clip it.
  if (big) return createPortal(<div className="live-play live-big" role="dialog" aria-label={`${agent.name}'s live playtest`}>{body}</div>, document.body);
  return <div className={`live-play ${className ?? ''}`}>{body}</div>;
}
