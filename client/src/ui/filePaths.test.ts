import { describe, expect, it } from 'vitest';
import { baseName, codePath, fileUrlPath, isTextFile, splitPaths } from './filePaths';

const paths = (text: string) => splitPaths(text).filter((p) => p.path).map((p) => p.path);

describe('splitPaths', () => {
  it('finds Windows paths and keeps the text around them', () => {
    expect(splitPaths('Notes are in C:\\Users\\me\\.cubefarm\\ceo\\NOTES.md.')).toEqual([
      { text: 'Notes are in ' },
      { text: 'C:\\Users\\me\\.cubefarm\\ceo\\NOTES.md', path: 'C:\\Users\\me\\.cubefarm\\ceo\\NOTES.md' },
      { text: '.' },
    ]);
    expect(paths('see D:/work/app/src, then (C:\\logs\\run.log)')).toEqual(['D:/work/app/src', 'C:\\logs\\run.log']);
  });

  it('finds absolute POSIX paths and file:// links', () => {
    expect(paths('clone at /home/me/.cubefarm/workspaces/a__b/main; done')).toEqual(['/home/me/.cubefarm/workspaces/a__b/main']);
    expect(paths('on a Mac: /Users/me/Projects/app/README.md!')).toEqual(['/Users/me/Projects/app/README.md']);
    expect(paths('open file:///C:/My%20Projects/app/notes.md now')).toEqual(['C:\\My Projects\\app\\notes.md']);
    expect(paths('or file:///home/me/a%20b.txt')).toEqual(['/home/me/a b.txt']);
  });

  it('leaves normal text, routes and URLs alone', () => {
    for (const text of [
      'Merged 3 PRs and/or closed 2 issues: 1/2 done.',
      'Call /api/state, then /ws for updates.',
      'See https://github.com/home/x/blob/main/README.md and http://localhost:4317/tmp/x',
      'Ratio 16:9, time 10:30, at C: drive',
      'A Windows-ish word: ABC:\\x and ~/notes.md',
      'Network shares like \\\\server\\share\\x stay text',
    ]) {
      expect(splitPaths(text), text).toEqual([{ text }]);
    }
    expect(paths('file://server/share/x.md')).toEqual([]);
  });
});

describe('codePath', () => {
  it('takes a whole inline code span as a path, spaces included', () => {
    expect(codePath('C:\\Users\\me\\My Projects\\app\\README.md')).toBe('C:\\Users\\me\\My Projects\\app\\README.md');
    expect(codePath(' /home/me/My Projects/app ')).toBe('/home/me/My Projects/app');
    expect(codePath('file:///C:/a%20b/c.log')).toBe('C:\\a b\\c.log');
  });

  it('leaves code that only mentions a path alone', () => {
    for (const code of ['npm run build', 'cd C:\\x && npm test', '/api/state', 'https://example.com/home/x', 'git push origin HEAD', 'a/b/c', '\\\\server\\share']) {
      expect(codePath(code), code).toBeNull();
    }
  });
});

describe('helpers', () => {
  it('reads file:// links, names and text types', () => {
    expect(fileUrlPath('file://localhost/srv/a.md')).toBe('/srv/a.md');
    expect(fileUrlPath('file:///%E0%A4%A')).toBeNull();
    expect(baseName('C:\\a b\\NOTES.md')).toBe('NOTES.md');
    expect(baseName('/home/me/app/')).toBe('app');
    expect(isTextFile('/x/NOTES.MD')).toBe(true);
    expect(isTextFile('/x/run.log')).toBe(true);
    expect(isTextFile('/x/setup.exe')).toBe(false);
    expect(isTextFile('/x/config.json')).toBe(false);
  });
});
