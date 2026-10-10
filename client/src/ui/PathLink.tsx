// A file path in a message (Markdown.tsx, filePaths.ts): on the PC a click shows it in File Explorer (Finder, the file
// manager); a phone gets "Show on PC" and, for .md/.txt/.log files, a read-only viewer. The server checks the path.
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useMode } from '../pocket/mode';
import { useStore } from '../store';
import type { TextFileView } from '../../../shared/types';
import { baseName, isTextFile } from './filePaths';
import { Markdown } from './Markdown';
import { Panel } from './Panel';

function reveal(path: string) {
  api
    .revealPath(path)
    .then(() => useStore.getState().pushToast('info', `📂 ${baseName(path)}: shown in the file manager on the PC`))
    .catch(() => undefined); // the error is already a toast
}

export function PathLink({ path, children }: { path: string; children: ReactNode }) {
  const pocket = useMode((s) => s.mode) === 'pocket';
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href="#"
        className="md-path"
        title={pocket ? path : `Show in folder: ${path}`}
        onClick={(e) => {
          e.preventDefault();
          if (pocket) setOpen(true);
          else reveal(path);
        }}
      >
        <span aria-hidden="true">📂</span>
        {children}
      </a>
      {open && createPortal(<PathSheet path={path} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/** The phone's choices for a path, and the viewer once "Read here" is picked. */
function PathSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [file, setFile] = useState<TextFileView | 'loading' | null>(null);
  const read = () => {
    setFile('loading');
    api.textFile(path).then(setFile, () => setFile(null));
  };
  const view = file && file !== 'loading' ? file : null;
  return (
    <Panel title={`📄 ${view?.name ?? baseName(path)}`} className="path-sheet" onClose={onClose}>
      <p className="path-sheet-path">{path}</p>
      {view ? (
        <>
          <p className="muted small">Read-only{view.truncated ? ': only the start of this file is shown' : ''}.</p>
          <div className="path-sheet-text">{/\.md$/i.test(view.name) ? <Markdown text={view.text} /> : <pre>{view.text}</pre>}</div>
        </>
      ) : (
        <div className="path-sheet-actions">
          <button className="btn" onClick={() => reveal(path)}>
            🖥 Show on PC
          </button>
          {isTextFile(path) && (
            <button className="btn" onClick={read} disabled={file === 'loading'}>
              {file === 'loading' ? 'Opening…' : '📖 Read here'}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}
