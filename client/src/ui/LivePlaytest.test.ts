import { describe, expect, it } from 'vitest';
import { liveTaskLabel } from './LivePlaytest';
import type { Agent } from '../store';

const agent = (patch: Partial<Agent>): Agent => ({ id: 'a', name: 'Ada', task: null, issueNumber: null, prNumber: null, ...patch }) as Agent;

describe('liveTaskLabel', () => {
  it('names the task and the issue or PR it belongs to', () => {
    expect(liveTaskLabel(agent({ task: 'issue', issueNumber: 16 }))).toBe('Issue #16');
    expect(liveTaskLabel(agent({ task: 'qa', prNumber: 11 }))).toBe('Testing PR #11');
    expect(liveTaskLabel(agent({ task: 'fix', prNumber: 11 }))).toBe('Fixing PR #11');
    expect(liveTaskLabel(agent({}))).toBe('Nothing assigned');
  });
});
