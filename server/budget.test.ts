import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { HttpError } from './httpError.ts';
import { Swarm } from './swarm.ts';
import type { PullInfo } from '../shared/types.ts';

// Floor budgets (#7): the manager caps a floor's reported spend; the office warns at 80% and, at 100%, holds that
// floor's new issues until the cap is raised. Work in flight (running agents, QA, fixes) carries on.
// Fake timers keep the office's scheduler from starting a demo session under the test's feet.

type Internals = {
  budgetBlocks(repo: unknown): boolean;
  startIssueWork(repo: unknown): boolean;
  startPipelineWork(repo: unknown): boolean;
  state: {
    repos: { id: string; autoAssign: boolean; budgetUsd: number }[];
    qa: { repoId: string; prNumber: number; status: string; devAgentId: string | null; qaAgentId: string | null; updatedAt: number }[];
  };
  repoRt: Map<string, { pulls: PullInfo[] }>;
  writeState(): Promise<void>;
  init(): Promise<void>;
};

async function office() {
  const swarm = new Swarm(createDemoBackend());
  const repo = await swarm.connectRepo('demo-co/pixel-todo');
  await swarm.syncRepo(repo.id);
  swarm.updateRepo(repo.id, { autoAssign: true });
  const internals = swarm as unknown as Internals;
  return {
    swarm,
    repo,
    internals,
    view: () => swarm.snapshot().repos.find((r) => r.id === repo.id)!,
    floor: () => internals.state.repos.find((r) => r.id === repo.id)!,
  };
}

const budgetLines = (swarm: Swarm) => swarm.snapshot().messages.filter((m) => m.from === 'office' && m.text.includes('budget'));
const overLines = (swarm: Swarm) => budgetLines(swarm).filter((m) => m.text.includes('no new issues start'));
const busyOn = (swarm: Swarm, repoId: string) => swarm.snapshot().agents.filter((a) => a.repoId === repoId && (a.status === 'preparing' || a.status === 'working')).length;

const openPr = (n: number): PullInfo => ({
  number: n,
  title: `PR ${n}`,
  body: `Closes #${n}`,
  url: `https://github.com/demo-co/pixel-todo/pull/${n}`,
  headRefName: `swarm/issue-${n}-ada`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  closesIssues: [n],
  createdAt: new Date(0).toISOString(),
  mergedAt: null,
  additions: 1,
  deletions: 0,
  checks: 'passing',
  headSha: 'abc123',
  mergeState: 'CLEAN',
  failedChecks: [],
  pendingChecks: [],
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('floor budget', () => {
  it('shows spend against the cap and alerts at 80% then 100%, each once', async () => {
    const { swarm, repo, internals, view, floor } = await office();
    expect(view().budget).toMatchObject({ budgetUsd: 0, spentUsd: null, level: 'none' });

    swarm.updateRepo(repo.id, { budgetUsd: 10 });
    expect(view().budget).toMatchObject({ budgetUsd: 10, spentUsd: null, pct: null, level: 'ok' });
    expect(internals.budgetBlocks(floor())).toBe(false); // nothing reported never blocks on its own

    swarm.simulateBudget(repo.id, 'warning');
    expect(view().budget).toMatchObject({ spentUsd: 8.5, pct: 85, level: 'warning' });
    expect(budgetLines(swarm).filter((m) => m.text.includes('over 80%'))).toHaveLength(1);

    swarm.simulateBudget(repo.id, 'warning'); // the same crossing: no second alert
    expect(budgetLines(swarm).filter((m) => m.text.includes('over 80%'))).toHaveLength(1);

    swarm.simulateBudget(repo.id, 'over');
    expect(view().budget).toMatchObject({ spentUsd: 10.5, pct: 105, level: 'over' });
    expect(overLines(swarm)).toHaveLength(1);

    swarm.simulateBudget(repo.id, 'over'); // still no duplicate
    expect(overLines(swarm)).toHaveLength(1);
  });

  it('holds new issues at 100% and resumes when the manager raises the cap', async () => {
    const { swarm, repo, internals, floor } = await office();
    expect(busyOn(swarm, repo.id)).toBe(0);
    swarm.updateRepo(repo.id, { budgetUsd: 5 });
    swarm.simulateBudget(repo.id, 'over');
    expect(internals.budgetBlocks(floor())).toBe(true);

    // A ready issue is not started: the scheduler's new-issue pass is held and nobody leaves idle.
    expect(internals.startIssueWork(floor())).toBe(false);
    expect(busyOn(swarm, repo.id)).toBe(0);

    // Raising the cap re-arms and lets new work start again, without a second 100% alert.
    const over = overLines(swarm).length;
    swarm.updateRepo(repo.id, { budgetUsd: 100 });
    expect(internals.budgetBlocks(floor())).toBe(false);
    expect(overLines(swarm)).toHaveLength(over);
  });

  it('alerts again when a raised cap is crossed a second time', async () => {
    const { swarm, repo, floor } = await office();
    swarm.updateRepo(repo.id, { budgetUsd: 10 });
    swarm.simulateBudget(repo.id, 'warning');
    expect(budgetLines(swarm).filter((m) => m.text.includes('over 80%'))).toHaveLength(1);

    // The manager raises the cap well past what's been spent: the floor is fine again, and the warning re-arms.
    swarm.updateRepo(repo.id, { budgetUsd: 100 });
    expect(floor().budgetUsd).toBe(100);
    expect(swarm.snapshot().repos.find((r) => r.id === repo.id)!.budget.level).toBe('ok');

    swarm.simulateBudget(repo.id, 'warning');
    expect(budgetLines(swarm).filter((m) => m.text.includes('over 80%'))).toHaveLength(2);
  });

  it('keeps QA and fixes running when the cap is hit', async () => {
    const { swarm, repo, internals, floor } = await office();
    swarm.hireAgent(repo.id, {}); // a second free agent
    const rt = internals.repoRt.get(repo.id)!;
    rt.pulls.push(openPr(99), openPr(100));
    await swarm.sendToQa(repo.id, 99);
    await swarm.sendToQa(repo.id, 100);
    const fixRec = internals.state.qa.find((q) => q.prNumber === 100)!;
    Object.assign(fixRec, { status: 'failed', devAgentId: null, qaAgentId: null, updatedAt: Date.now() - 60_000 });

    swarm.updateRepo(repo.id, { budgetUsd: 5 });
    swarm.simulateBudget(repo.id, 'over');
    expect(internals.budgetBlocks(floor())).toBe(true);

    // QA and fixes go through startPipelineWork, which the budget never gates.
    expect(internals.startPipelineWork(floor())).toBe(true);
    expect(swarm.snapshot().qa.find((q) => q.prNumber === 99)?.status).toBe('testing');
    expect(internals.startPipelineWork(floor())).toBe(true);
    expect(swarm.snapshot().qa.find((q) => q.prNumber === 100)?.status).toBe('fixing');
    expect(busyOn(swarm, repo.id)).toBe(2);
  });

  it('keeps the budget and its crossings across a restart', async () => {
    const first = new Swarm(createDemoBackend());
    const repo = await first.connectRepo('demo-co/pixel-todo');
    first.updateRepo(repo.id, { budgetUsd: 10 });
    first.simulateBudget(repo.id, 'over');
    await (first as unknown as Internals).writeState();

    const second = new Swarm(createDemoBackend());
    const init = (second as unknown as Internals).init();
    await vi.advanceTimersByTimeAsync(5_000);
    await init;

    const view = second.snapshot().repos.find((r) => r.id === repo.id)!;
    expect(view.budget).toMatchObject({ budgetUsd: 10, spentUsd: 10.5, pct: 105, level: 'over' });
    // Still held, and no second 100% alert on the way back up.
    expect((second as unknown as Internals).budgetBlocks((second as unknown as Internals).state.repos.find((r) => r.id === repo.id)!)).toBe(true);
    expect(overLines(second)).toHaveLength(1);
  });

  it('only simulates spend in the demo, and only with a cap set', async () => {
    const real = new Swarm({ ...createDemoBackend(), demo: false });
    expect(() => real.simulateBudget('demo-co/pixel-todo', 'warning')).toThrow(HttpError);
    const demo = new Swarm(createDemoBackend());
    await demo.connectRepo('demo-co/pixel-todo');
    expect(() => demo.simulateBudget('demo-co/pixel-todo', 'warning')).toThrow(/Set a budget/);
    expect(() => demo.simulateBudget('demo-co/pixel-todo', 'nonsense')).toThrow(/kind/);
  });
});
