import { describe, expect, it } from 'vitest';
import { cliFinished, lostConversation, resumableSession } from './cliRunner.ts';

describe('resumableSession', () => {
  const onDisk = (files: string[]) => (file: string) => files.includes(file);
  const hook = { hook_event_name: 'PreToolUse', session_id: 'abc', transcript_path: 'abc.jsonl' };

  it("keeps the session once Claude Code's conversation file exists", () => {
    expect(resumableSession(hook, onDisk(['abc.jsonl']))).toBe('abc');
  });

  it("doesn't keep it while the file isn't written yet (SessionStart, UserPromptSubmit)", () => {
    expect(resumableSession({ ...hook, hook_event_name: 'UserPromptSubmit' }, onDisk([]))).toBeNull();
  });

  it("doesn't keep it from a call with no transcript path (the status line) or no session", () => {
    expect(resumableSession({ hook_event_name: 'StatusLine', session_id: 'abc' }, () => true)).toBeNull();
    expect(resumableSession({ hook_event_name: 'Stop', transcript_path: 'abc.jsonl' }, () => true)).toBeNull();
  });
});

describe('lostConversation', () => {
  it("spots Claude Code's message for a resume with nothing to resume", () => {
    expect(lostConversation('\n No conversation found with session ID: 6cc74c7e-0c81-4bff-a140-cc8307c1d11b\n')).toBe(true);
  });

  it('ignores other screens', () => {
    expect(lostConversation('Claude Code v2.1.280\n❯ ')).toBe(false);
  });
});

describe('cliFinished', () => {
  const exit = (over: Partial<Parameters<typeof cliFinished>[0]> = {}) =>
    cliFinished({ cli: 'opencode', exitCode: 0, turnDone: false, turnError: null, lastText: '', elapsedMs: 5000, ...over });

  it("treats OpenCode's clean exit after a turn as finished, even if the plugin's report lost the race", () => {
    expect(exit()).toBe(true);
  });

  it('treats a reported OpenCode turn as finished even with no final text', () => {
    expect(exit({ turnDone: true })).toBe(true);
  });

  it('treats OpenCode with a captured final message as finished', () => {
    expect(exit({ lastText: 'Opened the pull request.' })).toBe(true);
  });

  it('keeps an OpenCode session that dies mid-turn an error', () => {
    expect(exit({ exitCode: 1 })).toBe(false);
  });

  it('keeps an OpenCode session that never authenticated (a non-zero exit) an error', () => {
    expect(exit({ exitCode: 1, elapsedMs: 1200 })).toBe(false);
  });

  it('keeps an OpenCode turn the plugin reported as failed an error', () => {
    expect(exit({ turnDone: true, turnError: 'OpenCode: unauthorized' })).toBe(false);
  });

  it('a reported turn is still an error when the process exits non-zero', () => {
    expect(exit({ exitCode: 2, turnDone: true, lastText: 'text' })).toBe(false);
  });

  it("finishes a Claude Code turn only when it captured text", () => {
    expect(exit({ cli: 'claude', lastText: 'Done.' })).toBe(true);
    expect(exit({ cli: 'claude' })).toBe(false);
  });

  it('gives Codex a clean exit after a long run, but not a quick one', () => {
    expect(exit({ cli: 'codex', elapsedMs: 60_000 })).toBe(true);
    expect(exit({ cli: 'codex', elapsedMs: 3000 })).toBe(false);
  });
});
