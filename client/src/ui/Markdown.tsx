import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { codePath, fileUrlPath, splitPaths } from './filePaths';
import { PathLink } from './PathLink';

// Agent-written prose (the CEO's texts and reasons, issues, QA reports) rendered as Markdown.
// Safe by default: raw HTML is shown as text, never parsed, and only http(s)/mailto links work. File paths become
// "Show in folder" links (PathLink.tsx), which reveal and never open.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

/** Turns raw HTML (`<script>`, `<img onerror>`, …) into plain text, so it's shown exactly as written. */
function remarkHtmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === 'html') node.type = 'text';
    node.children?.forEach(walk);
  };
  return walk;
}

/** A link that shows `path` in its folder (rendered by PathLink); markdown text can't set hProperties, so it's ours. */
const pathLink = (path: string, children: MdNode[]): MdNode => ({ type: 'link', url: '', children, data: { hProperties: { dataPath: path } } });

/** Turns file paths (in text, as a whole `inline code`, or file:// links) into "Show in folder" links. */
function remarkFilePaths() {
  const walk = (node: MdNode) => {
    if (node.type === 'link') {
      const p = node.url ? fileUrlPath(node.url) : null;
      if (p) node.data = { hProperties: { dataPath: p } };
      return; // a link's text is already a link
    }
    if (!node.children) return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type === 'inlineCode') {
        const p = codePath(child.value ?? '');
        return [p ? pathLink(p, [child]) : child];
      }
      if (child.type === 'text') {
        const pieces = splitPaths(child.value ?? '');
        if (pieces.length === 1 && !pieces[0].path) return [child];
        return pieces.map((x) => (x.path ? pathLink(x.path, [{ type: 'text', value: x.text }]) : { type: 'text', value: x.text }));
      }
      walk(child);
      return [child];
    });
  };
  return walk;
}

const SAFE_LINK = /^(https?:|mailto:)/i;
const safeUrl = (url: string) => (SAFE_LINK.test(url.trim()) ? url : '');

const components: Components = {
  a: ({ href, children, ...props }) => {
    const path = (props as Record<string, unknown>)['data-path'];
    if (typeof path === 'string') return <PathLink path={path}>{children}</PathLink>;
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="md-deadlink">{children}</span>
    );
  },
  // Images would load arbitrary URLs and blow up the layout; show them as links instead.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        🖼 {alt || src}
      </a>
    ) : (
      <span>🖼 {alt}</span>
    ),
  table: ({ children }) => (
    <div className="md-table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  // Code blocks (and tables, above) scroll sideways: focusable, so the keyboard can scroll them too.
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
};

// remark-breaks keeps single line breaks, as the phone showed them before Markdown.
const remarkPlugins = [remarkGfm, remarkHtmlAsText, remarkFilePaths, remarkBreaks];

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={safeUrl}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
