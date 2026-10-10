import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedPath, plainPath, revealCommand, sameOrigin, textFileProblem, within } from './reveal.ts';

describe('plainPath', () => {
  it('refuses UNC paths, relative paths and .. segments', () => {
    for (const bad of ['\\\\server\\share\\notes.md', '//server/share/notes.md', 'file://server/share/notes.md', 'notes.md', './x', '', 42]) {
      expect(() => plainPath(bad, path.win32), String(bad)).toThrow();
      expect(() => plainPath(bad, path.posix), String(bad)).toThrow();
    }
    expect(() => plainPath('C:\\office\\..\\Windows\\win.ini', path.win32)).toThrow(/\.\./);
    expect(() => plainPath('/home/me/office/../.ssh/id_rsa', path.posix)).toThrow(/\.\./);
    expect(() => plainPath('\\home\\me', path.win32)).toThrow(/absolute/);
  });

  it('normalises Windows and POSIX paths and file:// links', () => {
    expect(plainPath('C:/My Projects/app/README.md', path.win32)).toBe('C:\\My Projects\\app\\README.md');
    expect(plainPath('  /home/me/app/notes.md ', path.posix)).toBe('/home/me/app/notes.md');
    expect(plainPath('file:///C:/My%20Projects/app/README.md', path.win32)).toBe('C:\\My Projects\\app\\README.md');
    expect(plainPath('file://localhost/home/me/a%20b.md', path.posix)).toBe('/home/me/a b.md');
  });
});

describe('within', () => {
  it('compares whole segments, and ignores case where the disk does', () => {
    expect(within('C:\\home\\.cubefarm\\machines\\m1', 'C:\\home\\.cubefarm', path.win32, true)).toBe(true);
    expect(within('C:\\home\\.cubefarm', 'C:\\home\\.cubefarm', path.win32, true)).toBe(true);
    expect(within('c:\\HOME\\.cubefarm\\x', 'C:\\home\\.cubefarm', path.win32, true)).toBe(true);
    expect(within('C:\\home\\.cubefarm-evil\\x', 'C:\\home\\.cubefarm', path.win32, true)).toBe(false);
    expect(within('D:\\home\\.cubefarm', 'C:\\home\\.cubefarm', path.win32, true)).toBe(false);
    expect(within('/srv/Office/x', '/srv/office', path.posix, false)).toBe(false);
    expect(within('/srv/office/..x/y', '/srv/office', path.posix, false)).toBe(true);
  });
});

describe('allowedPath', () => {
  let tmp: string;
  let home: string;
  let floor: string;
  let outside: string;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reveal-')));
    home = path.join(tmp, 'swarm home');
    floor = path.join(tmp, 'projects', 'app');
    outside = path.join(tmp, 'elsewhere');
    for (const d of [path.join(home, 'machines', 'm1'), floor, outside]) await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(home, 'machines', 'm1', 'run log.txt'), 'hi');
    await fs.writeFile(path.join(floor, 'README.md'), '# app');
    await fs.writeFile(path.join(outside, 'secret.md'), 'no');
    // A junction on Windows (no admin rights needed), a symlink elsewhere: inside a root, pointing out of it.
    await fs.symlink(outside, path.join(home, 'escape'), 'junction');
  });
  afterAll(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }));

  it('allows files and folders inside the roots, spaces and all', async () => {
    const roots = [home, floor];
    expect(await allowedPath(path.join(home, 'machines', 'm1', 'run log.txt'), roots)).toBe(path.join(home, 'machines', 'm1', 'run log.txt'));
    expect(await allowedPath(path.join(floor, 'README.md'), roots)).toBe(path.join(floor, 'README.md'));
    expect(await allowedPath(home, roots)).toBe(home);
  });

  it('refuses paths outside the roots, .. tricks, links out of a root and missing files', async () => {
    const roots = [home, floor];
    await expect(allowedPath(path.join(outside, 'secret.md'), roots)).rejects.toMatchObject({ status: 403 });
    await expect(allowedPath(`${floor}${path.sep}..${path.sep}..${path.sep}elsewhere${path.sep}secret.md`, roots)).rejects.toMatchObject({ status: 403 });
    await expect(allowedPath(path.join(home, 'escape', 'secret.md'), roots)).rejects.toMatchObject({ status: 403 });
    await expect(allowedPath(path.join(home, 'nope.md'), roots)).rejects.toMatchObject({ status: 404 });
    await expect(allowedPath('\\\\server\\share\\x.md', roots)).rejects.toMatchObject({ status: 403 });
    await expect(allowedPath(path.join(floor, 'README.md'), [])).rejects.toMatchObject({ status: 403 });
  });
});

describe('textFileProblem', () => {
  it('shows only .md, .txt and .log files', () => {
    expect(textFileProblem(path.join('x', 'NOTES.md'))).toBeNull();
    expect(textFileProblem(path.join('x', 'build.LOG'))).toBeNull();
    expect(textFileProblem(path.join('x', 'a.txt'))).toBeNull();
    for (const bad of ['setup.exe', 'run.bat', 'go.ps1', 'report.docx', 'page.html', 'Makefile', 'notes.md.exe']) expect(textFileProblem(path.join('x', bad)), bad).not.toBeNull();
  });

  it('never shows the office secrets and state', () => {
    for (const name of ['secrets.json', 'push.json', 'state.json', 'demo-secrets.json', 'SECRETS.JSON']) expect(textFileProblem(path.join('home', name)), name).toMatch(/never|only/i);
    expect(textFileProblem(path.join('home', 'secrets.json'))).toMatch(/never shown/);
  });
});

describe('revealCommand', () => {
  it('selects the item and never opens it', () => {
    expect(revealCommand('win32', 'C:\\My Projects\\a.exe', path.win32)).toEqual({ file: 'explorer.exe', args: ['/select,', 'C:\\My Projects\\a.exe'] });
    expect(revealCommand('darwin', '/Users/me/a.sh', path.posix)).toEqual({ file: 'open', args: ['-R', '/Users/me/a.sh'] });
    expect(revealCommand('linux', '/home/me/a.sh', path.posix)).toEqual({ file: 'xdg-open', args: ['/home/me'] });
  });
});

describe('sameOrigin', () => {
  it('lets the office page through and refuses other sites', () => {
    expect(sameOrigin({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:4317', host: 'localhost:4317' })).toBe(true);
    expect(sameOrigin({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: 'localhost:4317' })).toBe(false);
    expect(sameOrigin({ 'sec-fetch-site': 'same-site', host: 'localhost:4317' })).toBe(false);
    expect(sameOrigin({ origin: 'http://localhost:4317', host: 'localhost:4317' })).toBe(true);
    expect(sameOrigin({ origin: 'https://pc.tail.ts.net', host: '127.0.0.1:4317', 'x-forwarded-host': 'pc.tail.ts.net' })).toBe(true);
    expect(sameOrigin({ origin: 'https://evil.example', host: 'localhost:4317' })).toBe(false);
    expect(sameOrigin({ origin: 'null', host: 'localhost:4317' })).toBe(false);
    expect(sameOrigin({ host: 'localhost:4317' })).toBe(true);
  });
});
