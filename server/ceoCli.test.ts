import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';
import { LEGACY_CEO_CLI } from '../shared/cli.ts';

// The CEO runs the office's default coding agent, like every other agent, so an office set up for DeepSeek through
// OpenCode gets a DeepSeek CEO. It used to be pinned to Claude Code, and that pin was stored but never read.

type Internals = {
  ensureCeo(interrupted: unknown[]): void;
  agentSetup(a: { role: string; cli: string; model: string; effort: string }): { codingAgent: string; model: string; effort: string };
  sessionRuntime(a: { role: string; cli: string; sessionCli: string | null }, resume?: string): { cli?: string; resumeSessionId?: string };
  state: { agents: { id: string; role: string; cli: string; model: string; effort: string; sessionId: string | null; sessionCli: string | null }[] };
};

const ceoOf = (swarm: Swarm) => (swarm as unknown as Internals).state.agents.find((a) => a.id === 'ceo')!;

describe("the CEO's coding agent", () => {
  it('is the office default, so a DeepSeek office gets a DeepSeek CEO', () => {
    const swarm = new Swarm(createDemoBackend());
    swarm.updateSettings({ defaultCli: 'opencode', defaultModel: 'deepseek/deepseek-flash' });
    (swarm as unknown as Internals).ensureCeo([]);
    expect((swarm as unknown as Internals).agentSetup(ceoOf(swarm))).toEqual({ codingAgent: 'opencode', model: 'deepseek/deepseek-flash', effort: 'xhigh' });
  });

  it('stays Claude Code on an office whose default is Claude Code', () => {
    const swarm = new Swarm(createDemoBackend());
    (swarm as unknown as Internals).ensureCeo([]);
    const setup = (swarm as unknown as Internals).agentSetup(ceoOf(swarm));
    expect(setup.codingAgent).toBe('claude');
    expect(setup.model).toBe('claude-opus-5-5');
  });

  it('honours a coding agent the manager picks for the CEO instead', () => {
    const swarm = new Swarm(createDemoBackend());
    swarm.updateSettings({ defaultCli: 'opencode', defaultModel: 'deepseek/deepseek-flash' });
    (swarm as unknown as Internals).ensureCeo([]);
    swarm.updateAgent('ceo', { cli: 'codex', model: 'gpt-5.5-codex' });
    expect((swarm as unknown as Internals).agentSetup(ceoOf(swarm))).toEqual({ codingAgent: 'codex', model: 'gpt-5.5-codex', effort: 'xhigh' });
  });

  it('clears the pin an older office left on the CEO, once', () => {
    const swarm = new Swarm(createDemoBackend());
    swarm.updateSettings({ defaultCli: 'opencode', defaultModel: 'deepseek/deepseek-flash' });
    (swarm as unknown as Internals).ensureCeo([]);
    // What an office that pinned the CEO to Claude Code left behind in its state.
    Object.assign(ceoOf(swarm), { cli: LEGACY_CEO_CLI, model: 'claude-opus-5-5' });
    (swarm as unknown as Internals).ensureCeo([]);
    expect(ceoOf(swarm).cli).toBe('');
    expect(ceoOf(swarm).model).toBe('');
    expect((swarm as unknown as Internals).agentSetup(ceoOf(swarm)).codingAgent).toBe('opencode');
  });

  it('starts a new session instead of resuming the old coding agent one', () => {
    // The company ran before the office was moved to OpenCode: its CEO chat was made by Claude Code, which there is no
    // DeepSeek to resume in. A chat used to carry on from that session, so every job handed it back to Claude Code.
    const swarm = new Swarm(createDemoBackend());
    swarm.updateSettings({ defaultCli: 'opencode', defaultModel: 'deepseek/deepseek-flash' });
    (swarm as unknown as Internals).ensureCeo([]);
    Object.assign(ceoOf(swarm), { sessionId: 'a-claude-session', sessionCli: 'claude' });

    const how = (swarm as unknown as Internals).sessionRuntime(ceoOf(swarm), 'a-claude-session');
    expect(how.cli).toBe('opencode');
    expect(how.resumeSessionId).toBeUndefined();
    expect(ceoOf(swarm).sessionId).toBeNull();
    expect(ceoOf(swarm).sessionCli).toBeNull();
  });

  it('still resumes a session its own coding agent made', () => {
    const swarm = new Swarm(createDemoBackend());
    swarm.updateSettings({ defaultCli: 'opencode', defaultModel: 'deepseek/deepseek-flash' });
    (swarm as unknown as Internals).ensureCeo([]);
    Object.assign(ceoOf(swarm), { sessionId: 'a-deepseek-session', sessionCli: 'opencode' });

    const how = (swarm as unknown as Internals).sessionRuntime(ceoOf(swarm), 'a-deepseek-session');
    expect(how.cli).toBe('opencode');
    expect(how.resumeSessionId).toBe('a-deepseek-session');
  });
});
