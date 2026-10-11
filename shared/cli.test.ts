import { describe, expect, it } from 'vitest';
import { chosenCli, LEGACY_CEO_CLI, resolveCli, SDK_CLI } from './cli.ts';

// Which coding agent someone runs. The CEO used to be pinned to Claude Code and its stored value ignored; it now follows
// the office default like every other agent, so an office whose default is DeepSeek gets a DeepSeek CEO.

const settings = (patch: Partial<{ runtime: 'terminal' | 'sdk'; defaultCli: 'claude' | 'codex' | 'opencode' }> = {}) =>
  ({ runtime: 'terminal' as const, defaultCli: 'claude' as const, ...patch });

describe('chosenCli', () => {
  it('is an agent own pick', () => {
    expect(chosenCli('agent', 'codex')).toBe('codex');
    expect(chosenCli('agent', '')).toBe('');
    expect(chosenCli('agent', undefined)).toBe('');
  });

  it("treats the CEO's stored Claude Code as no pick at all", () => {
    // The office hardcoded Claude Code for the CEO and never read this back, so 'claude' is what it wrote, not a choice.
    expect(LEGACY_CEO_CLI).toBe('claude');
    expect(chosenCli('ceo', 'claude')).toBe('');
    expect(chosenCli('ceo', undefined)).toBe('');
  });

  it('respects a coding agent the manager really picked for the CEO', () => {
    expect(chosenCli('ceo', 'opencode')).toBe('opencode');
    expect(chosenCli('ceo', 'codex')).toBe('codex');
  });
});

describe('resolveCli', () => {
  it('gives an agent the office default when they have no pick', () => {
    expect(resolveCli({ role: 'agent', cli: '' }, settings({ defaultCli: 'opencode' }))).toBe('opencode');
    expect(resolveCli({ role: 'agent', cli: 'codex' }, settings({ defaultCli: 'opencode' }))).toBe('codex');
  });

  it('gives the CEO the office default, so it can run DeepSeek like the employees', () => {
    expect(resolveCli({ role: 'ceo', cli: 'claude' }, settings({ defaultCli: 'opencode' }))).toBe('opencode');
    expect(resolveCli({ role: 'ceo', cli: '' }, settings({ defaultCli: 'opencode' }))).toBe('opencode');
  });

  it('keeps the CEO on Claude Code when that is the office default, as before', () => {
    expect(resolveCli({ role: 'ceo', cli: 'claude' }, settings())).toBe('claude');
    expect(resolveCli({ role: 'ceo', cli: '' }, settings())).toBe('claude');
  });

  it('lets an explicit pick override the office default for the CEO too', () => {
    expect(resolveCli({ role: 'ceo', cli: 'codex' }, settings({ defaultCli: 'opencode' }))).toBe('codex');
  });

  it('is Claude Code for everyone in the Agent SDK runtime, which runs nothing else', () => {
    expect(resolveCli({ role: 'ceo', cli: 'opencode' }, settings({ runtime: 'sdk', defaultCli: 'opencode' }))).toBe(SDK_CLI);
    expect(resolveCli({ role: 'agent', cli: 'opencode' }, settings({ runtime: 'sdk', defaultCli: 'opencode' }))).toBe(SDK_CLI);
  });
});
