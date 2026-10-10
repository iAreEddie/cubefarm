// "Show in folder" for paths in the office's messages, and the phone's read-only viewer of text files.
// Any caller may be remote (a phone through Tailscale Serve also looks like loopback), so this only ever reveals an
// item in the PC's file manager or reads a plain text file: it never opens or runs anything, and only inside the
// office's roots (SWARM_HOME, which holds the agents' machines, and the floors' checkouts).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './httpError.ts';

/** The files the phone's viewer shows. */
export const TEXT_TYPES = ['.md', '.txt', '.log'];
/** Never served by the viewer, whatever their type. */
export const NEVER_SERVED = ['secrets.json', 'push.json', 'state.json', 'demo-secrets.json'];
/** The viewer reads at most this much of a file. */
export const TEXT_MAX_BYTES = 512 * 1024;

type PathApi = typeof path.posix;
const caseless = process.platform === 'win32' || process.platform === 'darwin';
const isUnc = (p: string) => /^[\\/]{2}/.test(p);

/**
 * The path as written (a plain path or a file:// URL) made absolute and normalised, or an HttpError: UNC paths,
 * relative paths and `..` segments are refused before anything touches the disk.
 */
export function plainPath(raw: unknown, platformPath: PathApi = path): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'path is required');
  let p = raw.trim();
  if (p.length > 1024 || p.includes('\0')) throw new HttpError(400, 'Not a usable path');
  if (/^file:/i.test(p)) {
    let url: URL;
    try {
      url = new URL(p);
    } catch {
      throw new HttpError(400, 'Not a usable file:// link');
    }
    if (url.host && url.host !== 'localhost') throw new HttpError(403, 'Network paths are not shown');
    url.host = '';
    try {
      p = fileURLToPath(url, { windows: platformPath === path.win32 });
    } catch {
      throw new HttpError(400, 'Not a usable file:// link');
    }
  }
  if (isUnc(p)) throw new HttpError(403, 'Network paths are not shown');
  if (!platformPath.isAbsolute(p) || (platformPath === path.win32 && !/^[A-Za-z]:[\\/]/.test(p))) throw new HttpError(400, 'Only absolute paths can be shown');
  if (p.split(/[\\/]/).includes('..')) throw new HttpError(403, 'Paths with .. are not shown');
  return platformPath.resolve(p);
}

/** `child` is `root` or inside it. */
export function within(child: string, root: string, platformPath: PathApi = path, ignoreCase = caseless): boolean {
  const norm = (p: string) => (ignoreCase ? p.toLowerCase() : p);
  const rel = platformPath.relative(norm(root), norm(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${platformPath.sep}`) && !platformPath.isAbsolute(rel));
}

type RealPath = (p: string) => Promise<string>;
const realpath: RealPath = (p) => fs.realpath(p);

/**
 * The real path (symlinks and junctions followed) of `raw` when it exists inside one of `roots`, else an HttpError.
 * The real path is what's checked, so a link inside a root that points out of it is refused.
 */
export async function allowedPath(raw: unknown, roots: string[], real: RealPath = realpath): Promise<string> {
  const p = plainPath(raw);
  let target: string;
  try {
    target = await real(p);
  } catch {
    throw new HttpError(404, `Not found: ${p}`);
  }
  const realRoots = (await Promise.all(roots.map((r) => real(path.resolve(r)).catch(() => null)))).filter((r): r is string => !!r);
  if (isUnc(target) || !realRoots.some((r) => within(target, r))) throw new HttpError(403, 'Only files in the office (its home folder, the agents’ machines and the floors’ checkouts) can be shown');
  return target;
}

/**
 * The request comes from the office's own page, not another site in the same browser (CSRF). Browsers say so in
 * Sec-Fetch-Site; older ones only send Origin, checked against the host the page was served from (Tailscale Serve
 * passes it on as X-Forwarded-Host). Requests from outside a browser carry neither and are let through.
 */
export function sameOrigin(headers: Record<string, string | string[] | undefined>): boolean {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase();
  const site = one(headers['sec-fetch-site']);
  if (site) return site === 'same-origin';
  const origin = one(headers.origin);
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return [one(headers.host), one(headers['x-forwarded-host'])].includes(host);
}

/** Why the viewer won't show this file, or null when it will: only plain text types, never the office's secrets. */
export function textFileProblem(p: string): string | null {
  const name = path.basename(p).toLowerCase();
  if (NEVER_SERVED.includes(name)) return `${path.basename(p)} is never shown`;
  if (!TEXT_TYPES.includes(path.extname(name))) return `Only ${TEXT_TYPES.join(', ')} files can be read here`;
  return null;
}

/**
 * The file manager's command that shows `p` selected (or, on Linux, opens its folder). None of them open or run `p`
 * itself. Explorer takes `/select,` and the path as two arguments, so a path with spaces is quoted on its own.
 */
export function revealCommand(platform: NodeJS.Platform, p: string, platformPath: PathApi = path): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'explorer.exe', args: ['/select,', p] };
  if (platform === 'darwin') return { file: 'open', args: ['-R', p] };
  return { file: 'xdg-open', args: [platformPath.dirname(p)] };
}
