import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { run } from './exec.ts';
import type { AgentCli, AgentRole, CliView, EffortLevel } from '../shared/types.ts';

// The coding-agent CLIs an agent can run in its terminal, how to find them on this machine, and how to start one on
// a task. Claude Code is fully wired in: its hooks report every tool call to the office.
// The others start on the same prompt and report only when a turn ends (Codex's notify program, an OpenCode plugin);
// the office shows their task instead of their tool calls.

export interface CliDef {
  id: AgentCli;
  label: string;
  command: string;
  integrated: boolean;
}

export const CLIS: CliDef[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', integrated: true },
  { id: 'codex', label: 'Codex', command: 'codex', integrated: false },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', integrated: false },
];

export const isCli = (v: unknown): v is AgentCli => CLIS.some((c) => c.id === v);
export const cliLabel = (id: AgentCli) => CLIS.find((c) => c.id === id)?.label ?? id;

// ---------- finding a CLI ----------

const WIN = process.platform === 'win32';

/** The executable for a command name on PATH: on Windows only .exe/.cmd/.bat/.com, never an extensionless sh shim. */
export function resolveCommand(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  const exts = WIN ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => /^\.(exe|cmd|bat|com)$/i.test(e)) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try {
        const st = fs.statSync(file);
        if (st.isFile() && (WIN || (st.mode & 0o111) !== 0)) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * A shim that runs one program by an absolute path, which is what a CLI's own Windows installer writes (Codex's does),
 * as opposed to npm's `node "%dp0%\…"`. The program is quoted, so: the first quoted absolute path, then whatever
 * arguments follow it. null when the line doesn't look like that at all.
 */
function unwrapAbsoluteShim(line: string): { file: string; args: string[] } | null {
  const program = line.match(/"([A-Za-z]:\\[^"]+\.(?:exe|cmd|bat|com|js))"/i);
  if (!program) return null;
  // Everything after the path: the shim's own fixed arguments, minus cmd's %*/%1 placeholders, which only forward ours.
  const args = line
    .slice(program.index! + program[0].length)
    .trim()
    .split(/\s+/)
    .filter((a) => a && !/^%\*?$|^%\d$/.test(a));
  return { file: program[1], args };
}

/**
 * npm installs Windows CLIs as .cmd shims. Running one puts every argument through cmd.exe, which expands %VARS% and
 * breaks on a multi-line argument: cmd.exe hands the CLI only the first line, so a prompt whose text starts on its
 * second line arrives empty. Run what the shim runs instead — the program it points at.
 *
 * Both shapes are handled: npm's `node "%dp0%\…\cli.js"`, and the absolute path a CLI's own installer writes.
 */
export function unwrapCmdShim(shimPath: string, text: string): { file: string; args: string[] } | null {
  const dir = path.dirname(shimPath);
  // The command line, not the `@echo off` preamble: it is the line that forwards its arguments (%*).
  const line = text.split(/\r?\n/).find((l) => /[^%]%\*\s*$/.test(l.trim()) && !l.trim().startsWith('@'));
  if (!line) return null;
  const targets = [...line.matchAll(/"%dp0%\\([^"]+)"/g)].map((m) => path.join(dir, m[1]));
  const target = targets[targets.length - 1];
  // A program run by its absolute path: the installer's own shim.
  if (!target) return unwrapAbsoluteShim(line);
  if (/\.exe$/i.test(target)) return { file: target, args: [] };
  if (!/\.[cm]?js$/i.test(target)) return null;
  const between = line.slice(line.indexOf('"%_prog%"') + '"%_prog%"'.length, line.lastIndexOf(`"%dp0%\\`));
  const nodeFlags = line.includes('"%_prog%"') ? between.trim().split(/\s+/).filter((f) => f.startsWith('--')) : [];
  const localNode = path.join(dir, 'node.exe');
  return { file: fs.existsSync(localNode) ? localNode : process.execPath, args: [...nodeFlags, target] };
}

/**
 * The Claude Code the Agent SDK ships as a per-platform package (the one `cubefarm login` signs in with), so the
 * terminal runtime works without Claude Code installed, on the version the office was tested with. Same lookup as
 * the SDK's own and bin/cubefarm.js.
 */
let bundled: string | null | undefined;

function bundledClaude(): string | null {
  if (bundled !== undefined) return bundled;
  bundled = null;
  let sdk: string;
  try {
    sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    return null;
  }
  const { platform, arch } = process;
  // Only Linux needs the report (glibc or musl). On Windows it walks every native handle, and with pseudo-consoles
  // closing on other threads that takes the whole office down.
  const report = platform === 'linux' ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined) : undefined;
  const musl = platform === 'linux' && !report?.header?.glibcVersionRuntime;
  const targets = platform === 'linux' ? (musl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`]) : [`${platform}-${arch}`];
  for (const target of targets) {
    try {
      bundled = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${target}/claude${WIN ? '.exe' : ''}`);
      return bundled;
    } catch {
      // not installed for this target
    }
  }
  return null;
}

/** How to start a CLI: the program and the arguments that come before the office's own. */
export function commandFor(id: AgentCli): { file: string; args: string[] } | null {
  const bundled = id === 'claude' ? bundledClaude() : null;
  if (bundled) return { file: bundled, args: [] };
  const def = CLIS.find((c) => c.id === id);
  const found = def && resolveCommand(def.command);
  if (!found) return null;
  if (WIN && /\.(cmd|bat)$/i.test(found)) {
    try {
      return unwrapCmdShim(found, fs.readFileSync(found, 'utf8')) ?? { file: found, args: [] };
    } catch {
      return { file: found, args: [] };
    }
  }
  return { file: found, args: [] };
}

// ---------- OpenCode: two command lines ----------

/**
 * Whether this OpenCode is the 2.x line. Two things changed between it and 1.x that the office has to get right: the
 * bare command became the interactive TUI (the message-taking form is the `run` subcommand), and the flag that
 * auto-approves permissions went from `--dangerously-skip-permissions` to `--auto`. A machine can have both — a WinGet
 * 1.x build and an npm 2.x one — and PATH decides which the office finds, so it asks this one.
 */
let opencodeAuto: boolean | undefined;

/** The major version in what an OpenCode prints for `--version`: 'opencode v2.0.26' and '1.4.10' alike. */
export function opencodeMajor(printed: string): number | null {
  const major = printed.match(/v?(\d+)\.\d+\.\d+/)?.[1];
  return major === undefined ? null : Number(major);
}

/**
 * Asks one OpenCode binary which line it is: `--version` only, so nothing is spent on a model. Unreadable, missing or
 * silent counts as 1.x, whose flag exists in both lines.
 */
export function opencodeUsesAuto(file: string): boolean {
  if (opencodeAuto !== undefined) return opencodeAuto;
  opencodeAuto = false;
  try {
    const out = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const major = opencodeMajor(`${out.stdout ?? ''}${out.stderr ?? ''}`);
    if (major !== null) opencodeAuto = major >= 2;
  } catch {
    // Keep the conservative answer.
  }
  return opencodeAuto;
}

/**
 * The models OpenCode says it can run: its own `models` subcommand, which lists the providers it is signed in to and
 * contacts them, so it is given a longer timeout and any failure is just an empty list. Only OpenCode can be asked:
 * Claude Code's models are the ones the office ships, and Codex validates `--model` itself (shared/models.ts).
 */
export function parseOpencodeModels(printed: string): string[] {
  return [...new Set(
    printed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[\w.-]+\/[\w.:#-]+$/.test(l)),
  )].slice(0, 60);
}

/** Which CLIs this machine has, with their versions and, where the CLI can say, the models it can run. */
export async function detectClis(): Promise<CliView[]> {
  return Promise.all(
    CLIS.map(async (c) => {
      const cmd = commandFor(c.id);
      const version = cmd ? await run(cmd.file, [...cmd.args, '--version'], { timeoutMs: 20_000 }).catch(() => null) : null;
      const models = cmd && c.id === 'opencode' ? parseOpencodeModels(await run(cmd.file, [...cmd.args, 'models'], { timeoutMs: 60_000 }).catch(() => '')) : [];
      return { id: c.id, label: c.label, installed: !!cmd, version: version?.split(/\r?\n/)[0].trim().slice(0, 60) || null, integrated: c.integrated, models };
    }),
  );
}

// ---------- starting one on a task ----------

export interface LaunchContext {
  prompt: string;
  systemAppend: string;
  model: string; // '' = the CLI's own default
  effort: EffortLevel | '';
  resumeId?: string;
  sessionId: string; // the id the office gives a new Claude Code session
  name: string; // shown in Claude Code's prompt box and the terminal title
  role: 'agent' | 'ceo';
  additionalDirectories: string[];
  /** Files the office wrote for this session (settings, MCP config, instructions). */
  files: { settings: string; mcp: string | null; system: string };
  /** Where the CLI's turn-complete signal goes (Codex notify, the OpenCode plugin). */
  notify: { script: string; url: string };
  /** Codex's hook program: forwards each hook to the office (notify.url). */
  codexHook: string;
  plugin: string; // file URL of the OpenCode plugin
  /** The Playwright MCP server, when the floor tests in a browser. Claude Code gets it through its MCP config file. */
  browser: { command: string; args: string[] } | null;
  /**
   * The office MCP server (the CEO's tools), for the CLIs that start their own: the bridge script, the office URL it
   * dials and its environment. Claude Code gets the same tools from the office over its own MCP config file.
   */
  office: OfficeMcp | null;
  /**
   * OpenCode only: this install auto-approves permissions with --auto (2.x) rather than --dangerously-skip-permissions
   * (1.x). Left out in tests and by any other caller: the flag that exists in both lines.
   */
  opencodeAuto?: boolean;
  /**
   * Codex only: the session's own CODEX_HOME, holding the config.toml that gives it the office's MCP tools. Codex
   * cannot be handed an MCP server through `-c` (see codexConfigToml), so it reads this folder instead.
   */
  codexHome?: string;
}

export interface Launch {
  args: string[];
  env: Record<string, string>;
}

const EFFORT_CODEX: Record<EffortLevel, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

/** The office MCP server as a CLI starts it: the bridge script, the office URL it dials, and the environment it needs. */
export interface OfficeMcp {
  command: string;
  args: string[];
  /**
   * The SDK the bridge itself needs. It runs from the office's own folder, outside cubefarm, so `require` from there
   * would not find cubefarm's node_modules: the office says where they are. '' when they can't be worked out.
   */
  nodePath: string;
}

/** The node_modules cubefarm's own dependencies are in, as the bridge (which sits elsewhere) should look them up. */
export function officeMcpNodePath(resolve: (id: string) => string = (id) => createRequire(import.meta.url).resolve(id)): string {
  try {
    const pkg = resolve('@modelcontextprotocol/sdk/package.json');
    // Either separator, rather than path.sep: tests on one platform describe paths of the other.
    const rest = pkg.replaceAll('\\', '/');
    const at = rest.lastIndexOf('/node_modules/');
    return at < 0 ? '' : pkg.slice(0, at) + pkg.slice(at, at + '/node_modules'.length);
  } catch {
    return '';
  }
}

/** What an MCP server the office launches needs in its environment: where to find the SDK, when that is known. */
export function officeMcpEnv(nodePath: string): Record<string, string> {
  return nodePath ? { NODE_PATH: nodePath } : {};
}

/**
 * Codex saying it cannot find the session it was asked to resume, which exits it. Codex keeps sessions inside its own
 * CODEX_HOME, so one the office remembers may simply not be there any more — the office forgets the id and lets the
 * next session start fresh, rather than failing the same way on every job.
 */
export function lostCodexSession(screen: string): boolean {
  return /No saved session found with ID/i.test(screen);
}

/**
 * The config.toml that gives a Codex session the office's MCP tools.
 *
 * Codex cannot be told about an MCP server on the command line: a `-c` value is parsed as TOML, and every table-shaped
 * value arrives as a string ("invalid type: string …, expected struct RawMcpServerConfig"), which fails the whole
 * bootstrap config and leaves the session with no MCP servers at all. So a per-session CODEX_HOME carries it instead,
 * which also keeps the manager's own Codex config untouched.
 *
 * JSON.stringify doubles backslashes, which is exactly what a TOML basic string wants for a Windows path.
 */
export function codexConfigToml(office: { command: string; args: string[] }): string {
  return `[mcp_servers.office]\ncommand = ${JSON.stringify(office.command)}\nargs = [${office.args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
}

/**
 * OpenCode's permissions. An agent can't stop to ask (the office runs it with --auto), so everything is allowed; the
 * CEO is the exception: it reads repositories and acts through the office's tools, and never runs commands or edits
 * files. OpenCode still enforces an explicit "deny" under --auto, so that holds whatever the model decides to try.
 */
export function opencodePermission(role: AgentRole): Record<string, string> {
  return role === 'ceo' ? { bash: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny' } : { edit: 'allow', bash: 'allow', webfetch: 'allow' };
}

/** The CEO's own tools, and only the CEO's: no worker ever reaches the office's issue-and-team tools. */
function ceoOffice(ctx: LaunchContext): ctx is LaunchContext & { office: OfficeMcp } {
  return ctx.role === 'ceo' && !!ctx.office;
}

/** Codex hooks the office listens to: its steps, and Esc interrupting a turn. Turn endings come from notify. */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Interrupt'];

/**
 * The command Codex runs for each hook. It never changes (the office's address travels in CUBEFARM_HOOK_URL), so the
 * manager trusts the hooks once in Codex's /hooks and that holds for every session. On Windows, Codex runs it through
 * PowerShell or cmd depending on its version, and a command starting with a quote fails in both: plain `node` (on the
 * PATH the office gave it) and the script in double quotes work in either. Elsewhere it goes through the shell.
 */
export function codexHookCommand(node: string, script: string, win = WIN): string {
  return win ? `node "${script}"` : [node, script].map((s) => `'${s.replaceAll("'", `'"'"'`)}'`).join(' ');
}

/**
 * Claude Code tools whose result arrives in a later turn. An office session ends with its turn, so nothing would wake
 * the agent. Background shells (run_in_background) stay: agents start dev servers with them.
 */
export const CROSS_TURN_TOOLS = ['Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger'];

export function launchArgs(id: AgentCli, ctx: LaunchContext): Launch {
  switch (id) {
    case 'claude': {
      const disallowed = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...CROSS_TURN_TOOLS, ...(ctx.role === 'ceo' ? ['Bash', 'PowerShell', 'NotebookEdit'] : [])];
      const args = [
        ...(ctx.resumeId ? ['--resume', ctx.resumeId] : ['--session-id', ctx.sessionId]),
        ...(ctx.model ? ['--model', ctx.model] : []),
        ...(ctx.effort ? ['--effort', ctx.effort] : []),
        // The office's PreToolUse hook answers every permission question (allow, or deny with an office rule).
        '--permission-mode',
        'acceptEdits',
        // On top of the manager's own setup (settings, skills, plugins, MCP servers): the office's hooks and servers.
        '--settings',
        ctx.files.settings,
        ...(ctx.files.mcp ? ['--mcp-config', ctx.files.mcp] : []),
        '--append-system-prompt-file',
        ctx.files.system,
        '--name',
        ctx.name,
        ...ctx.additionalDirectories.flatMap((d) => ['--add-dir', d]),
        '--disallowedTools',
        ...disallowed,
        '--',
        ctx.prompt,
      ];
      return { args, env: { DISABLE_AUTOUPDATER: '1' } }; // the office's own copy: agents mustn't each try to update it
    }
    case 'codex': {
      const toml = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string
      // A -c value is parsed as TOML, so an inline table uses `key=value`, never JSON's `"key":value`: with a colon
      // Codex fails the whole config ("invalid type: string …, expected struct RawMcpServerConfig") and the session
      // starts with no MCP servers at all — the CEO had no office tools and could not see a floor.
      const table = (o: Record<string, unknown>) => `{${Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.map(toml).join(',')}]` : toml(String(v))}`).join(',')}}`;
      const args = [
        '--no-alt-screen',
        // Without this, an install whose CLI package doesn't match its executable refuses to start at all: "Error: the
        // CLI package does not match this platform or executable. To work without the background server, rerun the
        // same command with --no-daemon." The office runs one session per agent in its own pty, so it wants no daemon
        // anyway — and a session that dies at startup takes the whole prompt with it (the CEO got an empty message).
        '--no-daemon',
        '-c',
        `notify=[${[process.execPath, ctx.notify.script, ctx.notify.url].map(toml).join(',')}]`,
        '-c',
        `developer_instructions=${toml(ctx.systemAppend)}`,
        ...(ctx.model ? ['-m', ctx.model] : []),
        ...(ctx.effort ? ['-c', `model_reasoning_effort=${toml(EFFORT_CODEX[ctx.effort])}`] : []),
        ...(ctx.browser ? ['-c', `mcp_servers.playwright=${table({ command: ctx.browser.command, args: ctx.browser.args })}`] : []),
        // The office's tools come from the session's CODEX_HOME (codexConfigToml), not from here: -c cannot express
        // an MCP server table, so this line is deliberately absent. See officeMcpEnv for NODE_PATH.
        ...CODEX_HOOK_EVENTS.flatMap((e) => ['-c', `hooks.${e}=[{hooks=[{type="command",command=${toml(codexHookCommand(process.execPath, ctx.codexHook))},timeout=10}]}]`]),
        // Like the manager's own Codex, but it can't stop to ask: no approvals and no sandbox (its sandbox can't reach
        // the credential store, so git and gh fail in it).
        '--dangerously-bypass-approvals-and-sandbox',
      ];
      // `resume` takes its own flags the same way, with the session id and then the prompt.
      // NODE_PATH: Codex inherits the office's environment, and its MCP subprocesses inherit Codex's, so this is how
      // the office tools bridge (officeMcpSource) finds the SDK it needs from outside cubefarm. OpenCode gets the same
      // value through its own config's `environment`.
      const env: Record<string, string> = {
        CUBEFARM_HOOK_URL: ctx.notify.url,
        ...(ctx.codexHome ? { CODEX_HOME: ctx.codexHome } : {}),
        ...(ceoOffice(ctx) ? officeMcpEnv(ctx.office.nodePath) : {}),
      };
      return { args: ctx.resumeId ? ['resume', ...args, ctx.resumeId, ctx.prompt] : [...args, '--', ctx.prompt], env };
    }
    case 'opencode': {
      // The manager's own config is replaced wholesale (OPENCODE_CONFIG_CONTENT), so every server it should have is
      // listed here; the office's 'office' server wins over one of the same name in their config.
      const mcp: Record<string, unknown> = {};
      if (ctx.browser) mcp.playwright = { type: 'local', command: [ctx.browser.command, ...ctx.browser.args], enabled: true };
      if (ceoOffice(ctx)) mcp.office = { type: 'local', command: [ctx.office.command, ...ctx.office.args], enabled: true, environment: officeMcpEnv(ctx.office.nodePath) };
      const config = {
        plugin: [ctx.plugin],
        instructions: [ctx.files.system],
        autoupdate: false, // several agents starting at once must not each reinstall it
        permission: opencodePermission(ctx.role),
        ...(Object.keys(mcp).length ? { mcp } : {}),
      };
      // `run` takes the message and exits at the end of the turn, which is what the office wants from every session.
      // The bare form is OpenCode's interactive TUI: it takes neither a message nor the model flag the office sends,
      // and answers with its help text. `run` and the positional message are the same in 1.x and 2.x; only the flag
      // that auto-approves permissions differs (2.x --auto, 1.x --dangerously-skip-permissions), so the office asks
      // the CLI it found which line it is and sends that one — it also hands the office the CEO's MCP tools unasked.
      // No project argument: it starts in its terminal's folder, and a desk path in its command line would make the
      // desk clean-up take it for a leftover.
      const args = [
        'run',
        ...(ctx.model ? ['--model', ctx.model] : []),
        ...(ctx.resumeId ? ['--session', ctx.resumeId] : []),
        ctx.opencodeAuto ? '--auto' : '--dangerously-skip-permissions',
        ctx.prompt,
      ];
      return { args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), CUBEFARM_NOTIFY_URL: ctx.notify.url } };
    }
  }
}

// ---------- Codex's saved threads ----------

/** Runs each key's steps one after another; one that fails doesn't hold up the next. */
export function oneAtATime() {
  const tails = new Map<string, Promise<void>>();
  return (key: string, step: () => Promise<unknown>): Promise<void> => {
    const next = (tails.get(key) ?? Promise.resolve()).then(step).then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, next);
    void next.then(() => tails.get(key) === next && tails.delete(key));
    return next;
  };
}

const threadSteps = oneAtATime();

/**
 * Codex saves every terminal session where the manager's own Codex and ChatGPT apps list it with their chats. The
 * office archives its threads there once their CLI is gone (`after`), and unarchives one before resuming it: Codex
 * won't resume an archived thread. A thread's steps run in order; one with nothing to do (already archived) fails.
 */
export function codexThread(action: 'archive' | 'unarchive', id: string, after?: Promise<unknown>): Promise<void> {
  return threadSteps(id, async () => {
    await after;
    const cmd = commandFor('codex');
    if (cmd) await run(cmd.file, [...cmd.args, action, id], { timeoutMs: 30_000 });
  });
}

// ---------- prompts the office answers ----------

const TRUST_PROMPT = /Quick safety check|Do you trust the (files|contents) (in|of) this|trust this folder|allow Codex to work in this folder/i;

/**
 * The key that moves a CLI's folder-trust question toward trusting the office's own worktree: Enter when the
 * selected option says yes, Down when it says no (Claude Code selects "No, exit" first), null when there's no such
 * question on screen.
 */
export function trustKey(screen: string): 'enter' | 'down' | null {
  if (!TRUST_PROMPT.test(screen)) return null;
  const selected = screen.match(/^\s*[❯›]\s*(?:\d+\.\s*)?(.+)$/m)?.[1] ?? '';
  if (/^(yes|trust|continue|proceed)\b/i.test(selected.trim())) return 'enter';
  if (/^(no|exit|quit|cancel)\b/i.test(selected.trim())) return 'down';
  return null;
}

/**
 * Codex asks to review new hooks before it starts. They only show the office Codex's steps, so trusting them is the
 * manager's call (once, in /hooks): the office moves to "Continue without trusting" (Down) and takes it (Enter).
 */
export function hookReviewKey(screen: string): 'enter' | 'down' | null {
  if (!/Hooks need review/i.test(screen)) return null;
  const selected = screen.match(/^\s*[❯›]\s*(?:\d+\.\s*)?(.+)$/m)?.[1] ?? '';
  return /^continue without trusting/i.test(selected.trim()) ? 'enter' : 'down';
}

/**
 * Lines on screen where a CLI says it interrupted a turn (Claude Code: "Interrupted · What should Claude do
 * instead?", Codex: "Conversation interrupted"). Esc fires no hook in Claude Code, so a new one is how the office
 * knows the manager stopped the turn from the terminal.
 */
export function interruptions(screen: string): number {
  return screen.split('\n').filter((l) => /\binterrupted\b/i.test(l)).length;
}

// ---------- helper scripts the CLIs run ----------

/** Claude Code's status line: posts its data (cost, usage limits) to the office and shows the office's line. */
export const STATUSLINE_SOURCE = String.raw`// cubefarm: Claude Code's status line. Forwards the session's status to the office and prints the office's line.
const url = process.argv[2];
let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', async () => {
  try {
    const status = JSON.parse(body);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'StatusLine', session_id: status.session_id, cost: status.cost, rate_limits: status.rate_limits }),
      signal: AbortSignal.timeout(2000),
    });
    const out = await res.json();
    process.stdout.write(String(out.statusLine ?? ''));
  } catch {
    process.stdout.write('cubefarm');
  }
});
`;

/** Codex's notify program: Codex runs it with a JSON argument when a turn completes. */
export const NOTIFY_SOURCE = String.raw`// cubefarm: Codex's notify program. Tells the office a turn is complete.
const [url, payload] = process.argv.slice(2);
let event = {};
try {
  event = JSON.parse(payload ?? '{}');
} catch {}
if (event.type === 'agent-turn-complete') {
  const input = String((event['input-messages'] ?? [])[0] ?? '').slice(0, 300);
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'TurnComplete', session_id: event['thread-id'] ?? null, last_assistant_message: event['last-assistant-message'] ?? '', input }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
`;

/** Codex's hook program: passes what Codex tells a hook on to the office and answers nothing, so Codex carries on as usual. */
export const CODEX_HOOK_SOURCE = String.raw`// cubefarm: Codex's hooks. Tells the office what Codex is doing; never changes what it does.
const url = process.env.CUBEFARM_HOOK_URL;
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    if (url) await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(5000) });
  } catch {}
  process.stdout.write('{}');
});
`;

/** OpenCode plugin: reports its session and when it goes idle (a turn is complete). No imports: loaded from a file. */
export const OPENCODE_PLUGIN_SOURCE = String.raw`// cubefarm: tells the office when OpenCode's session goes idle.
export default async function CubefarmPlugin({ client } = {}) {
  const url = process.env.CUBEFARM_NOTIFY_URL;
  if (!url) return {};
  let root;
  const post = (body) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }).catch(() => {});
  const lastReply = async (id) => {
    try {
      const res = await client.session.messages({ path: { id } });
      const reply = (res?.data ?? []).filter((m) => m?.info?.role === 'assistant').pop();
      return (reply?.parts ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim();
    } catch {
      return '';
    }
  };
  return {
    event: async ({ event }) => {
      const props = event?.properties ?? {};
      if (event?.type === 'session.created' && !props.info?.parentID && !root) root = props.info?.id;
      const sessionID = props.sessionID ?? props.info?.id;
      if (event?.type === 'session.idle' && (!root || sessionID === root)) {
        post({ hook_event_name: 'TurnComplete', session_id: sessionID ?? null, last_assistant_message: sessionID ? await lastReply(sessionID) : '' });
      }
      if (event?.type === 'session.error') post({ hook_event_name: 'TurnError', session_id: sessionID ?? null, error: String(props.error?.data?.message ?? props.error?.name ?? 'error') });
    },
  };
}
`;

/**
 * The office's MCP tools for the CLIs that start their own MCP servers (Codex, OpenCode): a small stdio MCP server that
 * forwards every request to the office's HTTP endpoint, whose URL carries the session's token. Claude Code reaches the
 * same tools directly through the office's own MCP server, so the CEO's tools are identical whichever it runs.
 * Deployed as: node office-mcp.cjs <office mcp url>
 */
export const OFFICE_MCP_SOURCE = String.raw`// cubefarm: the office's tools (mcp__office__*) for a CLI that starts its own MCP servers.
// This file is deployed OUTSIDE cubefarm (the office's bin folder), so it cannot resolve the MCP SDK by walking up from
// itself, and it cannot rely on NODE_PATH either: Codex spawns its MCP servers with an environment of its own, without
// what the office set for the session — measured, not assumed. The SDK's folder is written into the file instead.
const SDK_DIR = '__SDK_DIR__';
if (SDK_DIR) module.paths.unshift(SDK_DIR);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error('the office URL is missing');
  const office = new Client({ name: 'cubefarm-office', version: '1.0.0' }, { capabilities: {} });
  try {
    await office.connect(new StreamableHTTPClientTransport(new URL(url)));
  } catch (err) {
    throw new Error("the office isn't reachable at " + url.split('/api/')[0] + ' (' + (err && err.message ? err.message : err) + ')');
  }
  // The office's own tool list, passed through: no second copy of the schemas to drift out of date.
  const bridge = new Server({ name: 'office', version: '1.0.0' }, { capabilities: { tools: {} } });
  bridge.setRequestHandler(ListToolsRequestSchema, () => office.listTools());
  bridge.setRequestHandler(CallToolRequestSchema, (req) => office.callTool(req.params));
  bridge.onerror = () => {};
  await bridge.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stderr is the agent's terminal; stdout is the protocol and must stay clean.
  process.stderr.write('cubefarm: the office tools are not available: ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
`;

/**
 * The bridge as it is deployed: the same source with the SDK's folder filled in. Without it the bridge starts, cannot
 * require the SDK, and exits — leaving a CEO that answers but has no office tools at all.
 */
export function officeMcpSource(sdkDir: string, source = OFFICE_MCP_SOURCE): string {
  // A JSON string is a safe JS string literal; only the one placeholder is replaced.
  return source.replace("'__SDK_DIR__'", JSON.stringify(sdkDir));
}
