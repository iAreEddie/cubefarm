// The office's panel (a titled card over a dimmed backdrop) and closing it. Kept apart from Overlays.tsx, which pulls
// in the 3D world, so pocket mode can open panels without loading it. A panel is a modal dialog for the keyboard and
// screen readers (dialogFocus.ts): focus moves in, stays in, and goes back when it closes.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useStore } from '../store';
import { useDialogFocus } from './dialogFocus';

// Closing a panel grabs the mouse again right away (world/lookLock.ts; "Grab the mouse when panels
// close" in help turns that off), and mouse presses are swallowed for a moment so a double click on
// ✕ or the backdrop can't act on whatever the crosshair lands on.
export function closeOverlay() {
  useStore.getState().openOverlay(null);
}

export function Panel({
  title,
  children,
  wide,
  accent,
  className,
  onClose,
  scrollBody,
}: {
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  accent?: string;
  className?: string;
  onClose?: () => void;
  /** Makes the scrolling body a focusable region (a card's long description), so the keyboard can scroll it. */
  scrollBody?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(box);
  // The dialog takes focus unless something inside already has it; a scroll body wants it, for arrow keys,
  // PageUp/Down and Home/End. Runs after useDialogFocus, so the body ends up with focus.
  useEffect(() => {
    if (scrollBody) body.current?.focus({ preventScroll: true });
  }, [scrollBody]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose ? onClose() : closeOverlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && (onClose ? onClose() : closeOverlay())}>
      <div
        ref={box}
        className={`panel ${wide ? 'panel-wide' : ''} ${className ?? ''}`}
        style={{ ['--accent' as string]: accent ?? '#ff8a5b' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="panel-head">
          <h2 className="panel-title" id={titleId}>
            {title}
          </h2>
          <button className="panel-x" onClick={() => (onClose ? onClose() : closeOverlay())} aria-label="Close">
            ✕
          </button>
        </div>
        <div ref={body} className="panel-body" tabIndex={scrollBody ? 0 : undefined}>
          {children}
        </div>
      </div>
    </div>
  );
}
