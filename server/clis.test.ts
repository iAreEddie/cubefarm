import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CODEX_HOOK_EVENTS, codexHookCommand, CROSS_TURN_TOOLS, hookReviewKey, interruptions, launchArgs, OFFICE_MCP_SOURCE, officeMcpEnv, officeMcpNodePath, oneAtATime, opencodeMajor, opencodePermission, opencodeUsesAuto, parseOpencodeModels, trustKey, unwrapCmdShim, type LaunchContext } from './clis.ts';
import { describeOfficeTool, describeTool, newScreenshots, screenshotFile, summariseResult } from './agentRunner.ts';

const nodeRequire = createRequire(import.meta.url);

const dir = path.join(os.tmpdir(), 'npm-global');

describe('unwrapCmdShim', () => {
  it('runs node on the script a node shim points at, keeping its node flags', () => {
    const shim = [
      '@ECHO off',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings=DEP0040 "%dp0%\\node_modules\\@acme\\cli\\bin\\cli.js" %*',
    ].join('\r\n');
    expect(unwrapCmdShim(path.join(dir, 'cli.cmd'), shim)).toEqual({ file: process.execPath, args: ['--no-warnings=DEP0040', path.join(dir, 'node_modules\\@acme\\cli\\bin\\cli.js')] });
  });

  it('runs the executable an exe shim points at', () => {
    const shim = '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
    expect(unwrapCmdShim(path.join(dir, 'opencode.cmd'), shim)).toEqual({ file: path.join(dir, 'node_modules\\opencode-ai\\bin\\opencode.exe'), args: [] });
  });

  it('gives up on shims it does not recognise', () => {
    expect(unwrapCmdShim(path.join(dir, 'x.cmd'), '@echo off\r\necho hi\r\n')).toBeNull();
  });
});

describe('trustKey', () => {
  it("moves Claude Code's trust question off its default \"No, exit\", then confirms \"Yes\"", () => {
    const question = (selected: 'no' | 'yes') =>
      [
        'Accessing workspace:',
        'C:\\Users\\me\\.cubefarm\\workspaces\\me__app\\desks\\ada-01df',
        'Quick safety check: Is this a project you created or one you trust?',
        "Claude Code'll be able to read, edit, and execute files here.",
        selected === 'no' ? '❯ No, exit' : '  No, exit',
        selected === 'yes' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder',
        'Enter to confirm · Esc to cancel',
      ].join('\n');
    expect(trustKey(question('no'))).toBe('down');
    expect(trustKey(question('yes'))).toBe('enter');
  });

  it("confirms Codex's trust question, whose first option is yes", () => {
    const screen = ['> You are in C:\\desk', '  Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit'].join('\n');
    expect(trustKey(screen)).toBe('enter');
  });

  it('leaves every other screen alone', () => {
    expect(trustKey('❯ Try "refactor <filepath>"')).toBeNull();
  });
});

describe('hookReviewKey', () => {
  const review = (selected: 1 | 3) =>
    ['  Hooks need review', '  5 hooks are new or changed.', `${selected === 1 ? '›' : ' '} 1. Review hooks`, '  2. Trust all and continue', `${selected === 3 ? '›' : ' '} 3. Continue without trusting (hooks won't run)`].join('\n');

  it("goes on without the office's hooks, leaving trust to the manager", () => {
    expect(hookReviewKey(review(1))).toBe('down');
    expect(hookReviewKey(review(3))).toBe('enter');
    expect(hookReviewKey('› Ask Codex to do anything')).toBeNull();
  });
});

describe('interruptions', () => {
  it('counts the lines where a CLI says it interrupted a turn', () => {
    expect(interruptions(['● Bash(sleep 4)', '  ⎿  Interrupted · What should Claude do instead?', '❯ '].join('\n'))).toBe(1);
    expect(interruptions('■ Conversation interrupted - tell the model what to do differently.\n› ')).toBe(1);
    expect(interruptions('● done\n❯ ')).toBe(0);
  });
});

describe('launchArgs', () => {
  const ctx = (patch: Partial<LaunchContext> = {}): LaunchContext => ({
    prompt: '--looks like a flag',
    systemAppend: 'You are Ada.',
    model: '',
    effort: 'medium',
    sessionId: '11111111-1111-1111-1111-111111111111',
    name: 'Ada · #1',
    role: 'agent',
    additionalDirectories: [],
    files: { settings: 'settings.json', mcp: null, system: 'instructions.md' },
    notify: { script: 'notify.cjs', url: 'http://127.0.0.1:1/api/hooks/t' },
    codexHook: 'codex-hook.cjs',
    plugin: 'file:///plugin.mjs',
    browser: null,
    office: null,
    ...patch,
  });
  it('starts Claude Code on a chosen session id, with the prompt after --', () => {
    const { args } = launchArgs('claude', ctx());
    expect(args.slice(0, 2)).toEqual(['--session-id', '11111111-1111-1111-1111-111111111111']);
    expect(args.slice(-2)).toEqual(['--', '--looks like a flag']);
    // the manager's own setup loads: no limiting its setting sources or MCP servers
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it("resumes Claude Code sessions and keeps the CEO's hands off the shell", () => {
    const { args } = launchArgs('claude', ctx({ resumeId: 'abc', role: 'ceo', files: { settings: 's', mcp: 'mcp.json', system: 'i' } }));
    expect(args.slice(0, 2)).toEqual(['--resume', 'abc']);
    expect(args).toContain('--mcp-config');
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...CROSS_TURN_TOOLS, 'Bash', 'PowerShell', 'NotebookEdit']);
  });

  it('keeps tools that wait across turns away from Claude Code, but not background shells', () => {
    const { args } = launchArgs('claude', ctx());
    expect(CROSS_TURN_TOOLS).toEqual(['Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']);
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...CROSS_TURN_TOOLS]);
    for (const cli of ['codex', 'opencode'] as const) expect(launchArgs(cli, ctx()).args.some((a) => a.includes('Monitor') || a.includes('ScheduleWakeup'))).toBe(false);
  });

  it("runs Codex without its sandbox or approvals, and resumes Codex's thread", () => {
    const fresh = launchArgs('codex', ctx()).args;
    expect(fresh).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(fresh).not.toContain('--sandbox');
    expect(fresh.slice(-2)).toEqual(['--', '--looks like a flag']);
    const resumed = launchArgs('codex', ctx({ resumeId: 'thread-1' })).args;
    expect(resumed[0]).toBe('resume');
    expect(resumed.slice(-2)).toEqual(['thread-1', '--looks like a flag']);
    expect(resumed).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it("gives Codex the office's hooks, with the office's address in its environment", () => {
    const { args, env } = launchArgs('codex', ctx());
    const hooks = args.filter((a) => a.startsWith('hooks.'));
    expect(hooks.map((h) => h.slice(6, h.indexOf('=')))).toEqual(CODEX_HOOK_EVENTS);
    expect(hooks[0]).toContain('type="command"');
    expect(env.CUBEFARM_HOOK_URL).toBe('http://127.0.0.1:1/api/hooks/t');
  });

  it('runs the hook program with a command that never starts with a quote on Windows', () => {
    expect(codexHookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\A B\\.cubefarm\\bin\\codex-hook.cjs', true)).toBe('node "C:\\Users\\A B\\.cubefarm\\bin\\codex-hook.cjs"');
    expect(codexHookCommand('/usr/bin/node', "/home/o'neil/.cubefarm/bin/codex-hook.cjs", false)).toBe(`'/usr/bin/node' '/home/o'"'"'neil/.cubefarm/bin/codex-hook.cjs'`);
  });

  it("lets OpenCode run without stopping to ask, and without updating itself", () => {
    const config = (patch: Partial<LaunchContext>) => JSON.parse(launchArgs('opencode', ctx(patch)).env.OPENCODE_CONFIG_CONTENT);
    for (const role of ['agent'] as const) expect(config({ role }).permission).toEqual({ edit: 'allow', bash: 'allow', webfetch: 'allow' });
    expect(config({}).autoupdate).toBe(false);
  });

  it("gives the office's tools to the CLIs that start their own MCP servers", () => {
    const office = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\A B\\.cubefarm\\bin\\office-mcp.cjs', 'http://127.0.0.1:4317/api/mcp/tok'], nodePath: 'C:\\cubefarm\\node_modules' };
    const codex = launchArgs('codex', ctx({ role: 'ceo', office })).args.find((a) => a.startsWith('mcp_servers.office='))!;
    expect(codex).toBe(`mcp_servers.office={command=${JSON.stringify(office.command)},args=[${office.args.map((a) => JSON.stringify(a)).join(',')}]}`);
    const opencode = JSON.parse(launchArgs('opencode', ctx({ role: 'ceo', office })).env.OPENCODE_CONFIG_CONTENT);
    // environment: the bridge is deployed outside cubefarm, so it must be told where the SDK it needs lives.
    expect(opencode.mcp.office).toEqual({ type: 'local', command: [office.command, ...office.args], enabled: true, environment: { NODE_PATH: office.nodePath } });
    // Claude Code reads the office's own server from the MCP config file the office writes, so it gets nothing extra.
    const claude = launchArgs('claude', ctx({ role: 'ceo', office, files: { settings: 's', mcp: 'mcp.json', system: 'i' } })).args;
    expect(claude.some((a) => a.includes('office-mcp'))).toBe(false);
  });

  it("leaves the office's tools out for an agent, and when there is no office server", () => {
    const office = { command: 'node', args: ['office-mcp.cjs', 'http://127.0.0.1:1/api/mcp/t'], nodePath: '/cubefarm/node_modules' };
    expect(launchArgs('codex', ctx({ role: 'agent', office })).args.some((a) => a.startsWith('mcp_servers.office='))).toBe(false);
    expect(launchArgs('opencode', ctx({ role: 'agent', office })).env.OPENCODE_CONFIG_CONTENT).not.toContain('office-mcp');
    expect(launchArgs('codex', ctx({ role: 'ceo' })).args.some((a) => a.startsWith('mcp_servers.office='))).toBe(false);
  });

  it("keeps the CEO's hands off the shell in OpenCode too", () => {
    // Whatever auto-approves permissions still leaves an explicit deny standing, so the CEO keeps no shell there.
    const ceo = opencodePermission('ceo');
    expect(ceo).toMatchObject({ bash: 'deny', edit: 'deny', webfetch: 'deny' });
    expect(opencodePermission('agent')).toEqual({ edit: 'allow', bash: 'allow', webfetch: 'allow' });
    const config = JSON.parse(launchArgs('opencode', ctx({ role: 'ceo' })).env.OPENCODE_CONFIG_CONTENT);
    expect(config.permission).toEqual(ceo);
  });

  it('starts OpenCode with `run`, the subcommand that takes a message', () => {
    // The bare command is OpenCode's interactive TUI: it takes neither --model nor a message, so the office got its
    // help text back and exit 1 instead of an agent working. `run` takes the message and exits at the end of the turn.
    const { args } = launchArgs('opencode', ctx({ model: 'deepseek/deepseek-flash' }));
    expect(args[0]).toBe('run');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek/deepseek-flash');
    expect(args).not.toContain('--prompt');
    // The message ends the command line as a plain argument, after every flag.
    expect(args[args.length - 1]).toBe('--looks like a flag');
    expect(args.filter((a) => a === '--looks like a flag')).toHaveLength(1);
  });

  it('auto-approves permissions with a flag the OpenCode being run actually has', () => {
    // 1.x spells it --dangerously-skip-permissions; 2.x renamed it --auto. Sending the wrong one costs the whole
    // session: OpenCode answers an unknown flag with its help text and exit 1.
    const legacy = launchArgs('opencode', ctx()).args;
    expect(legacy).toContain('--dangerously-skip-permissions');
    expect(legacy).not.toContain('--auto');
    const modern = launchArgs('opencode', ctx({ opencodeAuto: true })).args;
    expect(modern).toContain('--auto');
    expect(modern).not.toContain('--dangerously-skip-permissions');
    for (const args of [legacy, modern]) expect(args[0]).toBe('run');
  });

  it('resumes an OpenCode session with the same subcommand', () => {
    const { args } = launchArgs('opencode', ctx({ resumeId: 'ses_abc123' }));
    expect(args[0]).toBe('run');
    expect(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2)).toEqual(['--session', 'ses_abc123']);
    expect(args[args.length - 1]).toBe('--looks like a flag');
  });
});

describe('which OpenCode line the office is running', () => {
  it('reads the major version the CLI prints', () => {
    // The office asks the OpenCode it found to print its version, and two lines disagree on the flag that
    // auto-approves permissions. Sending the wrong one costs the whole session: it answers with its help and exit 1.
    expect(opencodeMajor('opencode v2.0.26')).toBe(2);
    expect(opencodeMajor('1.4.10')).toBe(1);
    expect(opencodeMajor('opencode v2.0.26 (something)')).toBe(2);
    expect(opencodeMajor('')).toBeNull();
    expect(opencodeMajor('command not found')).toBeNull();
  });

  it('answers 1.x when the CLI cannot be asked, whose flag exists in both lines', () => {
    expect(opencodeUsesAuto(path.join(os.tmpdir(), 'definitely-not-here', 'opencode.exe'))).toBe(false);
  });
});

describe("the models a CLI says it can run", () => {
  it('reads the model names out of what OpenCode prints, ignoring anything else', () => {
    // `opencode models` lists the providers it is signed in to, a model a line, so a DeepSeek-only machine offers
    // DeepSeek's models in the office's model fields instead of the office's guess at Anthropic's.
    const printed = ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro', 'ollama/gemma4:e4b', '', 'warning: something', '  opencode/big-pickle  '].join('\n');
    expect(parseOpencodeModels(printed)).toEqual(['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro', 'ollama/gemma4:e4b', 'opencode/big-pickle']);
  });

  it('drops duplicates and caps a very long list, and is empty for nothing', () => {
    expect(parseOpencodeModels('a/b\na/b\nc/d')).toEqual(['a/b', 'c/d']);
    expect(parseOpencodeModels(Array.from({ length: 200 }, (_, i) => `p/m${i}`).join('\n'))).toHaveLength(60);
    expect(parseOpencodeModels('')).toEqual([]);
    expect(parseOpencodeModels('no models here')).toEqual([]);
  });
});

describe('where the MCP bridge looks for its SDK', () => {
  it('is the node_modules cubefarm itself is installed in', () => {
    // The bridge is deployed to the office's own folder (SWARM_HOME/bin), outside cubefarm, so `require` from there
    // finds nothing: the CEO silently lost every office tool, and told the manager it had none rather than inventing
    // schemas. The office passes this to the CLI as the MCP server's NODE_PATH.
    const win = officeMcpNodePath(() => 'C:\\cubefarm\\node_modules\\@modelcontextprotocol\\sdk\\package.json');
    expect(win).toBe('C:\\cubefarm\\node_modules');
    const unix = officeMcpNodePath(() => '/opt/cubefarm/node_modules/@modelcontextprotocol/sdk/package.json');
    expect(unix).toBe('/opt/cubefarm/node_modules');
    // Nested (a package manager's store, or npm's own tree): the deepest node_modules is the one that has it.
    const nested = officeMcpNodePath(() => '/home/x/app/node_modules/.pnpm/@modelcontextprotocol+sdk@1/node_modules/@modelcontextprotocol/sdk/package.json');
    expect(nested).toBe('/home/x/app/node_modules/.pnpm/@modelcontextprotocol+sdk@1/node_modules');
  });

  it('is empty, not wrong, when the SDK cannot be found', () => {
    expect(officeMcpNodePath(() => {
      throw new Error('MODULE_NOT_FOUND');
    })).toBe('');
    // Nothing to pass on: the server then inherits the CLI's own environment instead of a path that does not exist.
    expect(officeMcpEnv('')).toEqual({});
    expect(officeMcpEnv('C:\\cubefarm\\node_modules')).toEqual({ NODE_PATH: 'C:\\cubefarm\\node_modules' });
  });

  it('resolves the SDK from this checkout, so the bridge starts where the office runs', () => {
    expect(officeMcpNodePath()).toContain('node_modules');
    expect(fs.existsSync(path.join(officeMcpNodePath(), '@modelcontextprotocol', 'sdk', 'package.json'))).toBe(true);
  });
});

describe('the office MCP bridge', () => {
  it('is a stdio MCP server that forwards the office tools to the office over HTTP', () => {
    // Deployed as a file the CLIs spawn, so it must be plain CommonJS with the office URL in its arguments.
    expect(OFFICE_MCP_SOURCE).toContain('require(');
    expect(OFFICE_MCP_SOURCE).not.toMatch(/^\s*(import|export)\s/m);
    expect(OFFICE_MCP_SOURCE).toContain('process.argv[2]');
    expect(OFFICE_MCP_SOURCE).toContain('StreamableHTTPClientTransport');
    expect(OFFICE_MCP_SOURCE).toContain('StdioServerTransport');
    expect(OFFICE_MCP_SOURCE).toContain('ListToolsRequestSchema');
    expect(OFFICE_MCP_SOURCE).toContain('CallToolRequestSchema');
  });

  it('resolves the SDK parts it requires, so the bridge starts where the office runs', () => {
    for (const mod of ['@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk/client/streamableHttp.js', '@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/stdio.js', '@modelcontextprotocol/sdk/types.js']) {
      expect(nodeRequire.resolve(mod), mod).toBeTruthy();
    }
  });
});

describe('oneAtATime', () => {
  it("runs a thread's archive and unarchive in order, other threads alongside, past a step that fails", async () => {
    const steps = oneAtATime();
    const done: string[] = [];
    let release!: () => void;
    const exited = new Promise<void>((r) => (release = r));
    const archive = steps('a', async () => {
      await exited;
      done.push('archive a');
      throw new Error('already archived');
    });
    const unarchive = steps('a', async () => void done.push('unarchive a'));
    await steps('b', async () => void done.push('archive b'));
    expect(done).toEqual(['archive b']);
    release();
    await expect(archive).resolves.toBeUndefined();
    await unarchive;
    expect(done).toEqual(['archive b', 'archive a', 'unarchive a']);
  });
});

describe('screenshotFile', () => {
  it("reads a Playwright screenshot that was saved to a file instead of returned inline", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shot-'));
    fs.mkdirSync(path.join(cwd, '.playwright-mcp'));
    fs.writeFileSync(path.join(cwd, '.playwright-mcp', 'pr16-375.png'), 'png-bytes');
    const shot = screenshotFile(cwd, '### Result\n- [Screenshot of viewport](.playwright-mcp/pr16-375.png)');
    expect(shot?.mime).toBe('image/png');
    expect(shot?.data.toString()).toBe('png-bytes');
    expect(screenshotFile(cwd, '### Result\n- no link here')).toBeNull();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("Codex's file edits in the log", () => {
  it('names the files an apply_patch touches, and says when it worked', () => {
    const patch = '*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch';
    expect(describeTool(dir, 'apply_patch', { command: patch })).toBe('Edit add notes.txt, src/app.ts');
    expect(summariseResult(dir, 'apply_patch', 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA notes.txt')).toEqual([{ kind: 'result', text: '  ⎿ Updated' }]);
    expect(summariseResult(dir, 'apply_patch', 'error: patch did not apply')[0].text).toContain('patch did not apply');
  });
});

describe("the CEO's office tools in the log", () => {
  it('says what each one asks for', () => {
    expect(describeOfficeTool('scale_team', { floor: 2, size: 5, reason: 'Six issues ready, two agents free' })).toBe('📈 scale_team floor 2 → 5: Six issues ready, two agents free');
    expect(describeOfficeTool('configure_agent', { agent_id: 'ada', cli: 'codex', model: '' })).toBe('⚙️ configure_agent ada: codex');
    expect(describeOfficeTool('set_dependencies', { floor: 1, number: 7, depends_on: [3, 4] })).toBe('🔗 set_dependencies #7 → floor 1 · depends on #3, #4');
    expect(describeOfficeTool('set_dependencies', { floor: 1, number: 7, depends_on: [] })).toBe('🔗 set_dependencies #7 → floor 1 · depends on nothing');
    expect(describeOfficeTool('file_issue', { floor: 1, title: 'Dark mode', body: 'x' })).toBe('📝 file_issue "Dark mode" → floor 1');
  });
});

describe('newScreenshots', () => {
  it("picks up the images a browser saved, oldest first, once they're written and only once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-'));
    const later = Date.now() + 5000;
    for (const f of ['page-2026-09-29T10-00-02-000Z.jpeg', 'page-2026-09-29T10-00-01-000Z.png', 'page-2026-09-29T10-00-00-000Z.yml']) fs.writeFileSync(path.join(dir, f), 'x');
    const seen = new Set<string>();
    expect(newScreenshots(dir, seen)).toEqual([]); // just written: may still be in progress
    const found = newScreenshots(dir, seen, later);
    expect(found.map((s) => [s.name, s.mime])).toEqual([
      ['page-2026-09-29T10-00-01-000Z.png', 'image/png'],
      ['page-2026-09-29T10-00-02-000Z.jpeg', 'image/jpeg'],
    ]);
    seen.add(found[0].name);
    expect(newScreenshots(dir, seen, later).map((s) => s.name)).toEqual(['page-2026-09-29T10-00-02-000Z.jpeg']);
    expect(newScreenshots(path.join(dir, 'missing'), seen, later)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
