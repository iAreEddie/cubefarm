import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// One PR, one Claude agent, one OpenCode (DeepSeek) agent: the scheduler must hand the DeepSeek author's PR to the
// Claude agent (#8), not to itself. The office writes state to a folder of its own so other tests' files are left alone.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-qa-pairing-'));
process.env.SWARM_HOME = home;
const { createDemoBackend } = await import('./demo.ts');
const { Swarm } = await import('./swarm.ts');

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

interface Agent {
  id: string;
  repoId: string;
  cli: string;
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
type Internals = {
  state: { agents: Agent[]; repos: Repo[]; qa: QaRec[] };
  startPipelineWork(repo: Repo): boolean;
  runQa: (tester: Agent, repo: Repo, rec: QaRec) => void;
};

const PR = 9999; // a number the demo floor never lists, so it counts as an open PR waiting for QA

/** A floor with a Claude agent and an OpenCode (DeepSeek) agent, one PR by the given author, all free. */
async function pickFor(authorCli: 'claude' | 'opencode') {
  const swarm = new Swarm(createDemoBackend());
  await swarm.connectRepo('demo-co/pixel-todo');
  const internals = swarm as unknown as Internals;
  const repo = internals.state.repos[0];
  const first = internals.state.agents.find((a) => a.repoId === repo.id)!;
  await swarm.hireAgent(repo.id, { cli: 'opencode' });
  const second = internals.state.agents.find((a) => a.repoId === repo.id && a.id !== first.id)!;
  const claudeAgent = authorCli === 'claude' ? first : second;
  const opencode = authorCli === 'opencode' ? first : second;
  const author = authorCli === 'claude' ? claudeAgent : opencode;
  claudeAgent.cli = 'claude';
  opencode.cli = 'opencode';
  for (const a of internals.state.agents) if (a.repoId === repo.id) Object.assign(a, { status: 'idle', task: null });
  const rec: QaRec = { repoId: repo.id, prNumber: PR, status: 'queued', devAgentId: author.id, qaAgentId: null, updatedAt: Date.now() };
  internals.state.qa.push(rec);
  // The real scheduler picks the tester; capturing runQa keeps the session machinery out of this wiring test.
  const runQa = vi.fn();
  internals.runQa = runQa;
  expect(internals.startPipelineWork(repo)).toBe(true);
  await swarm.shutdown().catch(() => undefined);
  return { runQa, claudeAgent, opencode, rec };
}

describe('QA pairing (#8)', () => {
  it("a DeepSeek (OpenCode) agent's PR is tested by the Claude agent", async () => {
    const { runQa, claudeAgent, opencode } = await pickFor('opencode');
    expect(runQa).toHaveBeenCalledTimes(1);
    expect((runQa.mock.calls[0][0] as Agent).id).toBe(claudeAgent.id);
    expect((runQa.mock.calls[0][0] as Agent).id).not.toBe(opencode.id); // QA is never the PR's own author
  });

  it("a Claude agent's PR is tested by the OpenCode agent", async () => {
    const { runQa, claudeAgent, opencode } = await pickFor('claude');
    expect(runQa).toHaveBeenCalledTimes(1);
    expect((runQa.mock.calls[0][0] as Agent).id).toBe(opencode.id);
    expect((runQa.mock.calls[0][0] as Agent).id).not.toBe(claudeAgent.id);
  });
});
