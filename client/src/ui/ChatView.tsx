import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { foldChat, thoughtLabel, type ChatEntry } from '../../../shared/chat';
import type { LogLine } from '../../../shared/types';
import { Markdown } from './Markdown';

// The agent's conversation as a compact, scrollable chat (#26): messages, tool activity and individually collapsible
// thought/reasoning sections. Long output scrolls inside its own window, so it never pushes the composer or the
// close button out of the panel. It follows new output while the reader is at the bottom; scrolling up holds their
// place and offers a return-to-latest button. Expansion state is kept per agent, so switching agents never mixes them.

/** Which thought sections each agent has expanded, kept across opens (never shared between agents). */
const expandedByAgent = new Map<string, Set<string>>();
const expandedFor = (agentId: string) => {
  let set = expandedByAgent.get(agentId);
  if (!set) expandedByAgent.set(agentId, (set = new Set()));
  return set;
};

const domId = (agentId: string, entryId: string) => `thought-${agentId}-${entryId}`.replace(/[^a-zA-Z0-9_-]/g, '-');

function ThoughtSection({ agentId, entry, open, onToggle }: { agentId: string; entry: ChatEntry; open: boolean; onToggle: (e: MouseEvent<HTMLButtonElement>, entry: ChatEntry) => void }) {
  const bodyId = domId(agentId, entry.id);
  return (
    <div className="chat-thought" data-thought-id={entry.id}>
      <button className="chat-thought-head" aria-expanded={open} aria-controls={bodyId} onClick={(e) => onToggle(e, entry)} title={open ? 'Collapse these thoughts' : 'Show these thoughts'}>
        <span className="chat-thought-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="chat-thought-icon" aria-hidden="true">
          ✻
        </span>
        <span className="chat-thought-label">
          {thoughtLabel(entry.text) || 'Thought'}
        </span>
        <span className="chat-thought-count">
          {entry.lines} line{entry.lines === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="chat-thought-body" id={bodyId}>
          <Markdown text={entry.text} />
        </div>
      )}
    </div>
  );
}

export function ChatView({
  agentId,
  lines,
  thoughtsSupported,
  cliLabel,
  busyLine,
  onSetup,
}: {
  agentId: string;
  lines: LogLine[];
  thoughtsSupported: boolean;
  /** The coding agent's name, for the "thoughts aren't available" note. */
  cliLabel: string;
  /** A line to show under the conversation while the agent is working (a spinner-style status). */
  busyLine?: string | null;
  /** Called when the reader taps "show the terminal" from the empty chat (optional, keeps the panel usable). */
  onSetup?: () => void;
}) {
  const entries = useMemo(() => foldChat(lines), [lines]);
  const expanded = expandedFor(agentId);
  const [version, setVersion] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [enlarged, setEnlarged] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pending = useRef<{ id: string; top: number } | null>(null);

  // Follow new output while the reader is at the bottom. Scrolling up holds their place (nothing scrolls).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, busyLine]);

  // Expanding or collapsing a thought keeps that section where it was: the scroll jumps by exactly the height change.
  useLayoutEffect(() => {
    const el = scroller.current;
    const anchor = pending.current;
    pending.current = null;
    if (!el) return;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (!anchor) return;
    const node = el.querySelector<HTMLElement>(`[data-thought-id="${CSS.escape(anchor.id)}"]`);
    if (node) el.scrollTop += node.getBoundingClientRect().top - anchor.top;
  }, [version]);

  const onToggle = (e: MouseEvent<HTMLButtonElement>, entry: ChatEntry) => {
    const section = e.currentTarget.closest<HTMLElement>('[data-thought-id]');
    if (section && scroller.current) pending.current = { id: entry.id, top: section.getBoundingClientRect().top };
    if (expanded.has(entry.id)) expanded.delete(entry.id);
    else expanded.add(entry.id);
    setVersion((v) => v + 1);
  };

  const jumpToLatest = () => {
    stick.current = true;
    setAtBottom(true);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className={`chat ${enlarged ? 'chat-enlarged' : ''}`}>
      <div className="chat-bar">
        <span className="chat-bar-title">Conversation</span>
        <span className="spacer" />
        <button className="btn btn-small" aria-pressed={enlarged} title={enlarged ? 'Use the compact size' : 'Show the conversation at a larger size'} onClick={() => setEnlarged((v) => !v)}>
          {enlarged ? 'Compact' : 'Enlarge'}
        </button>
      </div>
      {!thoughtsSupported && (
        <div className="chat-note" role="note">
          ✻ {cliLabel} doesn't expose its reasoning to the office, so thoughts aren't shown here. Messages and tool activity still are.
        </div>
      )}
      <div className="chat-window">
        <div
          className="chat-scroll"
          ref={scroller}
          tabIndex={0}
          role="group"
          aria-label={thoughtsSupported ? 'Conversation with thought sections' : 'Conversation'}
          onScroll={(e) => {
            const el = e.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            stick.current = bottom;
            setAtBottom(bottom);
          }}
        >
          {entries.length === 0 && !busyLine && (
            <div className="chat-empty muted">
              Nothing yet.
              {onSetup && (
                <>
                  {' '}
                  <button className="chat-link" onClick={onSetup}>
                    Open the terminal
                  </button>
                  .
                </>
              )}
            </div>
          )}
          {entries.map((entry) =>
            entry.kind === 'thought' ? (
              <ThoughtSection key={entry.id} agentId={agentId} entry={entry} open={expanded.has(entry.id)} onToggle={onToggle} />
            ) : (
              <div key={entry.id} className={`chat-row chat-${entry.kind}`}>
                {entry.kind === 'message' ? (
                  <Markdown text={entry.text} className="chat-md" />
                ) : (
                  <span className="chat-line">{entry.text || ' '}</span>
                )}
              </div>
            ),
          )}
          {busyLine && <div className="chat-row chat-busy">{busyLine}</div>}
        </div>
        {!atBottom && (
          <button className="chat-latest" onClick={jumpToLatest}>
            ↓ Latest
          </button>
        )}
      </div>
    </div>
  );
}
