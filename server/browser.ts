import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// The agents' test browser: the Playwright MCP server pinned in package.json, started with node from the installed
// package (no npx, no npm registry, no surprise browser download at session start), driving the installed Google
// Chrome the README asks for.

export interface McpCommand {
  command: string;
  args: string[];
}

/** The pinned Playwright MCP's CLI script, resolved from cubefarm's own dependencies; null when it isn't installed. */
export function playwrightMcpCli(): string | null {
  try {
    const pkgFile = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
    const bin = (JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { bin?: Record<string, string> }).bin?.['playwright-mcp'] ?? 'cli.js';
    return path.join(path.dirname(pkgFile), bin);
  } catch {
    return null;
  }
}

/**
 * The MCP server command: node on the CLI script, each path its own argument (no shell, so spaces need no quoting).
 * browser-init.js keeps pages from taking the real mouse with pointer lock (headless Chrome does on Windows).
 * `outputDir` gets snapshots and unnamed screenshots (the terminal runtime collects them from there).
 *
 * With `configFile` the browser keeps a profile on disk and opens a loopback CDP port, so the office can watch the
 * agent's own browser (#16). Without one it stays in-memory (`--isolated`), exactly as before.
 */
export function playwrightMcpCommand(cli: string, initScript: string, outputDir?: string, node = process.execPath, configFile?: string): McpCommand {
  const profile = configFile ? ['--config', configFile] : ['--isolated'];
  return { command: node, args: [cli, '--headless', ...profile, ...(outputDir ? ['--output-dir', outputDir] : []), '--init-script', initScript] };
}

/** The office's Playwright MCP server for a session, or null when the pinned package can't be found. */
export function playwrightMcp(outputDir?: string, configFile?: string): McpCommand | null {
  const cli = playwrightMcpCli();
  return cli ? playwrightMcpCommand(cli, path.join(import.meta.dirname, 'browser-init.js'), outputDir, process.execPath, configFile) : null;
}

/**
 * The MCP's browser config for a session whose browser the office watches (#16): a profile folder of its own (removed
 * with the session) and a loopback-only CDP port Chrome picks itself and records in the profile's DevToolsActivePort.
 * Playwright still launches and owns the browser; the office only attaches over CDP to screencast it, read-only.
 */
export function browserWatchingConfig(profileDir: string): Record<string, unknown> {
  return { browser: { isolated: false, userDataDir: profileDir, launchOptions: { args: ['--remote-debugging-port=0'] } } };
}

/** Writes that config beside the session and returns its path, for `playwrightMcp`. */
export function writeBrowserWatchingConfig(dir: string, profileDir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'playwright-watch.json');
  fs.writeFileSync(file, JSON.stringify(browserWatchingConfig(profileDir), null, 2));
  return file;
}

/**
 * playwright-core as the pinned MCP itself uses it, so the office's CDP attach matches the MCP's browser exactly.
 * Resolved from @playwright/mcp's own folder (its direct dependency), whatever npm did with hoisting; null when the
 * package or playwright-core isn't installed.
 */
export function playwrightCore(): typeof import('playwright-core') | null {
  try {
    const pkg = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
    return createRequire(pkg)('playwright-core') as typeof import('playwright-core');
  } catch {
    return null;
  }
}

/** Where Playwright's "chrome" channel looks for Google Chrome (bin/cubefarm.js doctor checks the same places). */
export function chromePaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  if (platform === 'win32') {
    return [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter((d): d is string => !!d).map((d) => path.win32.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app', path.posix.join(home, 'Applications', 'Google Chrome.app')];
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

export const hasChrome = () => chromePaths().some((p) => fs.existsSync(p));

/** The one line a session's log shows when browser testing can't work on this machine, or null when it can. */
export function browserProblem(mcp: McpCommand | null, chrome = hasChrome()): string | null {
  if (!mcp) return '⚠ The browser tool (@playwright/mcp) is not installed with cubefarm: reinstall it, or run npx cubefarm doctor';
  if (!chrome) return '⚠ Google Chrome not found, so this session cannot test in a browser: install it, or run npx cubefarm doctor';
  return null;
}
