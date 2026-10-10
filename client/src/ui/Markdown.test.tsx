import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

// The real link needs the browser (the store, the phone's sheet); this checks which text becomes one.
vi.mock('./PathLink', () => ({
  PathLink: ({ path, children }: { path: string; children: ReactNode }) => (
    <a className="md-path" title={`Show in folder: ${path}`}>
      {children}
    </a>
  ),
}));

const md = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
const titles = (html: string) => [...html.matchAll(/class="md-path" title="Show in folder: ([^"]*)"/g)].map((m) => m[1]);

describe('file paths in Markdown', () => {
  it('makes paths in text, whole inline code and file:// links "Show in folder" links', () => {
    const html = md('Clone: `C:\\My Projects\\app`, log at /home/me/.cubefarm/run.log and [notes](file:///C:/x/NOTES.md).');
    expect(titles(html)).toEqual(['C:\\My Projects\\app', '/home/me/.cubefarm/run.log', 'C:\\x\\NOTES.md']);
    expect(html).toContain('<code>C:\\My Projects\\app</code></a>');
  });

  it('leaves URLs, code blocks and other code alone', () => {
    const html = md('See https://example.com/home/x and `npm run build`.\n\n```\nC:\\x\\y.md\n```');
    expect(titles(html)).toEqual([]);
    expect(html).toContain('href="https://example.com/home/x"');
  });

  it('keeps unknown link schemes dead', () => {
    expect(md('[x](javascript:alert(1))')).toContain('md-deadlink');
  });
});
