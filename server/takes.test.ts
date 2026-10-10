import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// An agent's Takes (#2) in the scheduler: QA-only agents never get an issue or a fix, build-only agents are never
// picked to test, and a floor where everyone takes anything is scheduled as before.
interface Agent {
  id: string;
  desk: number;
  takes: string;
  repoId: string;
}
interface Repo {
  id: string;
}
type Internals = {
  state: { agents: Agent[]; repos: Repo[]; qa: Record<string, unknown>[] };
  repoRt: Map<string, { issues: { number: number }[]; pulls: { number: number; state: string; headRefName: string }[] }>;
  startIssueWork(repo: Repo): boolean;
  startPipelineWork(repo: Repo): boolean;
  assign: (agentId: string, issue: number) => Promise<unknown>;
  runQa: (a: Agent, repo: Repo, rec: unknown) => Promise<void>;
  runFix: (a: Agent, repo: Repo, rec: unknown) => Promise<void>;
  opsNow(): { alarms: { id: string; kind: string; text: string }[] };
};

/** A floor of three idle agents (desks 0, 1, 2) with their Takes, and the hand-outs recorded instead of run. */
async function office(takes: string[]) {
  const swarm = new Swarm(createDemoBackend());
  const repo = await swarm.connectRepo('demo-co/pixel-todo', { autoAssign: true });
  while (swarm.snapshot().agents.filter((a) => a.repoId === repo.id).length < takes.length) swarm.hireAgent(repo.id, {});
  const o = swarm as unknown as Internals;
  const team = o.state.agents.filter((a) => a.repoId === repo.id).sort((x, y) => x.desk - y.desk);
  team.forEach((a, i) => swarm.updateAgent(a.id, { takes: takes[i] }));
  const r = o.state.repos.find((x) => x.id === repo.id)!;
  const handed: [string, number][] = [];
  o.assign = async (agentId) => void handed.push(['issue', team.findIndex((a) => a.id === agentId)]);
  o.runQa = async (a) => void handed.push(['qa', a.desk]);
  o.runFix = async (a) => void handed.push(['fix', a.desk]);
  const rt = o.repoRt.get(repo.id)!;
  rt.pulls = [{ number: 50, state: 'OPEN', headRefName: 'swarm/issue-1-ada' } as never];
  const pr = (status: string, author: number) =>
    o.state.qa.push({ repoId: repo.id, prNumber: 50, status, devAgentId: team[author].id, updatedAt: Date.now(), round: 1 } as never);
  return { swarm, o, r, team, handed, pr };
}

describe('Takes in the scheduler', () => {
  it('gives issues to builders, never to a QA-only agent', async () => {
    const { o, r, handed } = await office(['qa', 'build', 'any']);
    expect(o.repoRt.get(r.id)!.issues.length).toBeGreaterThan(0);
    o.startIssueWork(r);
    expect(handed).toEqual([['issue', 1]]);
  });

  it('starts no issue when only QA-only agents are free', async () => {
    const { o, r, handed } = await office(['qa', 'qa', 'qa']);
    expect(o.startIssueWork(r)).toBe(false);
    expect(handed).toEqual([]);
  });

  it("sends a PR's QA to the QA-only agent, past free builders", async () => {
    const { o, r, handed, pr } = await office(['build', 'build', 'qa']);
    pr('queued', 0);
    o.startPipelineWork(r);
    expect(handed).toEqual([['qa', 2]]);
  });

  it('never picks a build-only agent to test, even after the self-QA wait', async () => {
    const { o, r, handed, pr } = await office(['build', 'build', 'build']);
    pr('queued', 0);
    (o.state.qa[0] as { updatedAt: number }).updatedAt = 0; // queued for ages
    expect(o.startPipelineWork(r)).toBe(false);
    expect(handed).toEqual([]);
  });

  it("gives a failed PR's fix to its author when they build, otherwise to a builder, never to a QA-only agent", async () => {
    const own = await office(['qa', 'any', 'build']);
    own.pr('failed', 1);
    own.o.startPipelineWork(own.r);
    expect(own.handed).toEqual([['fix', 1]]);

    const other = await office(['qa', 'qa', 'build']);
    other.pr('failed', 1); // its author has since been set to QA only
    other.o.startPipelineWork(other.r);
    expect(other.handed).toEqual([['fix', 2]]);

    const none = await office(['qa', 'qa', 'qa']);
    none.pr('failed', 1);
    expect(none.o.startPipelineWork(none.r)).toBe(false);
    expect(none.handed).toEqual([]);
  });

  it('schedules a floor on Anything as before: issues by desk, QA to anyone but the author', async () => {
    const { o, r, handed, pr } = await office(['any', 'any', 'any']);
    o.startIssueWork(r);
    pr('queued', 0);
    o.startPipelineWork(r);
    expect(handed).toEqual([
      ['issue', 0],
      ['qa', 1],
    ]);
  });

  it('refuses hand-assigning work an agent does not take', async () => {
    const { swarm, o, r, team } = await office(['qa', 'build', 'any']);
    o.repoRt.get(r.id)!.pulls = [{ number: 50, state: 'OPEN', headRefName: 'swarm/issue-1-ada' } as never]; // after any sync
    await expect(Swarm.prototype.assign.call(swarm, team[0].id, 1)).rejects.toThrow(/QA only/); // the real one, not the recorder
    await expect(swarm.sendToQa(r.id, 50, team[1].id)).rejects.toThrow(/building and fixes only/);
    expect(() => swarm.updateAgent(team[2].id, { takes: 'reviewer' })).toThrow(/takes must be/);
  });

  it('raises an alarm on mission control while nobody on a floor can test', async () => {
    const { swarm, o, team } = await office(['build', 'build', 'any']);
    expect(o.opsNow().alarms.filter((a) => a.kind === 'team')).toEqual([]);
    swarm.updateAgent(team[2].id, { takes: 'build' });
    expect(o.opsNow().alarms.filter((a) => a.kind === 'team').map((a) => a.text)).toEqual(['Nobody on this floor can test']);
    expect(swarm.snapshot().agents.find((a) => a.id === team[2].id)?.takes).toBe('build');
  });
});
