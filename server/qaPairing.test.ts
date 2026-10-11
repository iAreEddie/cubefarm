import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// QA pairing at runtime (#8): the scheduler must hand a PR to an agent whose coding agent (then model) really differs
// from the author's, which depends on the runtime the reviewer's fresh session actually runs: the agent's own CLI in a
// terminal, but always Claude Code through the SDK or when the terminals are unavailable. The office writes state to a
// folder of its own so other tests' files are left alone.
const originalHome = process.env.SWARM_HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-qa-pairing-'));
process.env.SWARM_HOME = home;
const { createDemoBackend } = await import('./demo.ts');
const { Swarm } = await import('./swarm.ts');

afterAll(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

interface Agent {
  id: string;
  repoId: string;
  cli: string;
  model: string;
  status: string;
  task: string | null;
  desk: number;
}
interface Repo {
  id: string;
}
interface QaRec {
  repoId: string;
  prNumber: number;
  status: string;
  devAgentId: string | null;
  qaAgentId: string | null;
  updatedAt: number;
}
interface Settings {
  runtime: 'terminal' | 'sdk';
  defaultCli: 'claude' | 'codex' | 'opencode';
}
interface Pairing {
  cli: string;
  model: string;
}
type Internals = {
  state: { agents: Agent[]; repos: Repo[]; qa: QaRec[]; settings: Settings };
  startPipelineWork(repo: Repo): boolean;
  runQa: (tester: Agent, repo: Repo, rec: QaRec) => void;
  pairingOf(a: Agent): Pairing;
};

const PR = 9999; // a number the demo floor never lists, so it counts as an open PR waiting for QA

interface Pick {
  runQa: ReturnType<typeof vi.fn>;
  internals: Internals;
  repo: Repo;
  /** The floor's agents, by desk. */
  floor: Agent[];
}

/**
 * A demo floor with one agent per entry, one queued PR by `authorIndex`, and the tester the real scheduler picks. The
 * runtime can be forced so the pairing is checked against what the reviewer's fresh session actually runs.
 */
async function pickFor(
  agents: { cli: 'claude' | 'opencode' | ''; model?: string }[],
  authorIndex: number,
  opts: { runtime?: 'terminal' | 'sdk'; terminals?: boolean; defaultCli?: 'claude' | 'opencode' } = {},
): Promise<Pick> {
  const backend = createDemoBackend();
  if (opts.terminals !== undefined) backend.terminals = opts.terminals;
  const swarm = new Swarm(backend);
  await swarm.connectRepo('demo-co/pixel-todo');
  const internals = swarm as unknown as Internals;
  const repo = internals.state.repos[0];
  if (opts.runtime) internals.state.settings.runtime = opts.runtime;
  if (opts.defaultCli) internals.state.settings.defaultCli = opts.defaultCli;
  const onFloor = () => internals.state.agents.filter((a) => a.repoId === repo.id).sort((a, b) => a.desk - b.desk);
  while (onFloor().length < agents.length) await swarm.hireAgent(repo.id, {});
  const floor = onFloor();
  floor.forEach((a, i) => Object.assign(a, { cli: agents[i].cli, model: agents[i].model ?? '', status: 'idle', task: null }));
  const rec: QaRec = { repoId: repo.id, prNumber: PR, status: 'queued', devAgentId: floor[authorIndex].id, qaAgentId: null, updatedAt: Date.now() };
  internals.state.qa.push(rec);
  // The real scheduler picks the tester; capturing runQa keeps the session machinery out of this wiring test.
  const runQa = vi.fn();
  internals.runQa = runQa;
  expect(internals.startPipelineWork(repo)).toBe(true);
  await swarm.shutdown().catch(() => undefined);
  return { runQa, internals, repo, floor };
}

const testerOf = (p: Pick) => (p.runQa.mock.calls[0][0] as Agent).id;

describe('QA pairing at runtime (#8)', () => {
  it("a DeepSeek (OpenCode) agent's PR is tested by the Claude agent in the terminal runtime", async () => {
    const p = await pickFor([{ cli: 'claude' }, { cli: 'opencode' }], 1);
    expect(p.runQa).toHaveBeenCalledTimes(1);
    expect(testerOf(p)).toBe(p.floor[0].id); // the Claude agent
    expect(testerOf(p)).not.toBe(p.floor[1].id); // QA is never the PR's own author
  });

  it("a Claude agent's PR is tested by the OpenCode agent in the terminal runtime", async () => {
    const p = await pickFor([{ cli: 'claude' }, { cli: 'opencode' }], 0);
    expect(p.runQa).toHaveBeenCalledTimes(1);
    expect(testerOf(p)).toBe(p.floor[1].id); // the OpenCode agent
  });

  it('an agent with no coding agent of its own uses the office default', async () => {
    // The office default is OpenCode, so the author without one is an OpenCode author and the Claude agent reviews it.
    const p = await pickFor([{ cli: 'claude' }, { cli: '' }], 1, { defaultCli: 'opencode' });
    expect(p.internals.pairingOf(p.floor[1]).cli).toBe('opencode');
    expect(p.internals.pairingOf(p.floor[1]).model).toBe('');
    expect(testerOf(p)).toBe(p.floor[0].id); // the Claude agent
  });

  it('still prefers a same-engine reviewer with nobody else free (the fallback)', async () => {
    // Both agents are OpenCode: the other one reviews it rather than the author, even though the pairing is the same.
    const p = await pickFor([{ cli: 'opencode' }, { cli: 'opencode' }], 0);
    expect(testerOf(p)).toBe(p.floor[1].id);
  });

  it('one-agent floor: its author QAs it in a fresh session rather than stall', async () => {
    const p = await pickFor([{ cli: 'claude' }], 0);
    expect(p.runQa).toHaveBeenCalledTimes(1);
    expect(testerOf(p)).toBe(p.floor[0].id); // nobody else can: self-QA, like main has always done
  });

  it('prefers a different model within the same coding agent in the terminal runtime', async () => {
    // All three run Claude Code; the author and the lower-desk reviewer share a model (a per-agent override), so the
    // higher-desk agent on a different model must be preferred, not just the lowest-desk agent.
    const p = await pickFor(
      [
        { cli: 'claude', model: 'claude-opus-5-5' },
        { cli: 'claude', model: 'claude-opus-5-5' },
        { cli: 'claude', model: 'claude-sonnet-5' },
      ],
      0,
      { runtime: 'terminal' },
    );
    expect(p.internals.pairingOf(p.floor[0])).toEqual({ cli: 'claude', model: 'claude-opus-5-5' });
    expect(testerOf(p)).toBe(p.floor[2].id); // the different model, not desk order or the author
  });

  describe('the SDK runtime runs Claude Code no matter what the agent asked for', () => {
    it('pairs by Claude model, not the agent CLI', async () => {
      // Author (OpenCode, no model) and the first reviewer (Claude, no model) both resolve to the office's Claude model;
      // the third agent runs a different Claude model, so it must be preferred over desk order.
      const p = await pickFor(
        [{ cli: 'opencode' }, { cli: 'claude' }, { cli: 'claude', model: 'claude-sonnet-5' }],
        0,
        { runtime: 'sdk' },
      );
      expect(p.internals.pairingOf(p.floor[0])).toEqual({ cli: 'claude', model: p.internals.pairingOf(p.floor[1]).model });
      expect(testerOf(p)).toBe(p.floor[2].id); // the different Claude model, not the lower-desk same model
    });

    it('runs the same pairing under the unavailable-terminal fallback', async () => {
      // The terminal keeper couldn't start: the runtime falls back to the SDK, so the pairing must too.
      const p = await pickFor(
        [{ cli: 'opencode' }, { cli: 'claude' }, { cli: 'claude', model: 'claude-sonnet-5' }],
        0,
        { runtime: 'terminal', terminals: false },
      );
      expect(p.internals.pairingOf(p.floor[0]).cli).toBe('claude');
      expect(testerOf(p)).toBe(p.floor[2].id);
    });

    it('the same floor picks the different engine on terminals and the different model on the SDK', async () => {
      const agents = [{ cli: 'opencode' as const }, { cli: 'claude' as const }, { cli: 'claude' as const, model: 'claude-sonnet-5' }];
      const terminal = await pickFor(agents, 0, { runtime: 'terminal' });
      expect(testerOf(terminal)).toBe(terminal.floor[1].id); // a different coding agent, whatever the model
      const sdk = await pickFor(agents, 0, { runtime: 'sdk' });
      expect(testerOf(sdk)).toBe(sdk.floor[2].id); // all Claude now, so the different model wins
    });
  });
});
