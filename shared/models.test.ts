import { describe, expect, it } from 'vitest';
import { effectiveModel, isClaudeModel, modelSuggestions } from './models.ts';
import type { CliView } from './types.ts';

const claudeOffice = { defaultCli: 'claude' as const, defaultModel: 'claude-sonnet-5' };
const codexOffice = { defaultCli: 'codex' as const, defaultModel: 'gpt-5.5-codex' };

describe('effectiveModel', () => {
  it("uses the worker's own model when it suits their agent", () => {
    expect(effectiveModel('opus', 'claude', claudeOffice, 'claude-opus-5-5')).toBe('opus');
    expect(effectiveModel('gpt-5.5', 'codex', claudeOffice, 'claude-opus-5-5')).toBe('gpt-5.5');
  });

  it("falls back to the office default only for the office's default agent", () => {
    expect(effectiveModel('', 'claude', claudeOffice, 'claude-opus-5-5')).toBe('claude-sonnet-5');
    expect(effectiveModel('', 'codex', codexOffice, 'claude-opus-5-5')).toBe('gpt-5.5-codex');
    expect(effectiveModel('', 'claude', codexOffice, 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(effectiveModel('', 'opencode', claudeOffice, 'claude-opus-5-5')).toBe('');
  });

  it('never hands a model to an agent that would not understand it', () => {
    expect(effectiveModel('claude-opus-5-5', 'codex', claudeOffice, 'claude-opus-5-5')).toBe('');
    expect(effectiveModel('gpt-5.5', 'claude', claudeOffice, 'claude-opus-5-5')).toBe('claude-sonnet-5');
    expect(effectiveModel('', 'codex', { defaultCli: 'codex', defaultModel: 'claude-opus-5-5' }, 'claude-opus-5-5')).toBe('');
  });

  it("knows Claude Code's names and aliases", () => {
    expect(['claude-fable-5-1', 'Opus', 'sonnet', 'haiku', 'opusplan'].every(isClaudeModel)).toBe(true);
    expect(['gpt-5.5', 'opencode/big-pickle', 'o3', 'opencode/claude-sonnet-5'].some(isClaudeModel)).toBe(false);
  });
});

describe('modelSuggestions', () => {
  const cli = (id: CliView['id'], models: string[]): CliView => ({ id, label: id, installed: true, version: 'x', integrated: id === 'claude', models });

  it('only suggests models the chosen coding agent understands', () => {
    expect(modelSuggestions('claude').every(isClaudeModel)).toBe(true);
    for (const cli of ['codex', 'opencode'] as const) {
      expect(modelSuggestions(cli).length).toBeGreaterThan(0);
      expect(modelSuggestions(cli).some(isClaudeModel)).toBe(false);
    }
  });

  it('offers what the coding agent says it can run, instead of the office guessing', () => {
    // OpenCode answers `models` with every model of the providers it is signed in to, so a DeepSeek-only machine
    // offers DeepSeek's (and, before this, offered Anthropic names it could not run at all).
    const clis: CliView[] = [cli('opencode', ['ollama/gemma4:e4b', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-flash'])];
    expect(modelSuggestions('opencode', clis, 'deepseek/deepseek-flash')).toEqual([
      'deepseek/deepseek-flash', // the office's own model first
      'deepseek/deepseek-v4-pro', // then its provider's
      'ollama/gemma4:e4b',
    ]);
    // Codex cannot be asked (it validates --model itself), so its own list stands, gpt-6.1-sol included.
    expect(modelSuggestions('codex', clis)).toContain('gpt-6.1-sol');
    // An agent on a CLI that answered nothing keeps the office's list.
    expect(modelSuggestions('claude', clis).every(isClaudeModel)).toBe(true);
  });

  it('keeps every model the CLI reported, however many', () => {
    const many = Array.from({ length: 40 }, (_, i) => `deepseek/model-${i}`);
    expect(modelSuggestions('opencode', [cli('opencode', many)], 'deepseek/model-7')).toHaveLength(40);
  });
});
