import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { HttpError } from './httpError.ts';
import { Swarm } from './swarm.ts';

// Floor budgets (#7): the manager caps a floor's reported spend; the office warns at 80% and, at 100%, holds that
// floor's new issues until the cap is raised. Work in flight (running agents, QA, fixes) carries on.
// Fake timers keep the office's scheduler from starting a demo session under the test's feet.

type Internals = {
  budgetBlocks(repo: unknown): boolean;
  startIssueWork(repo: unknown): boolean;
  state: { repos: { id: string; autoAssign: boolean }[] };
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
const busyOn = (swarm: Swarm, repoId: string) => swarm.snapshot().agents.filter((a) => a.repoId === repoId && (a.status === 'preparing' || a.status === 'working')).length;

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
    expect(budgetLines(swarm).filter((m) => m.text.includes('no new issues start'))).toHaveLength(1);

    swarm.simulateBudget(repo.id, 'over'); // still no duplicate
    expect(budgetLines(swarm).filter((m) => m.text.includes('no new issues start'))).toHaveLength(1);
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
    const over = budgetLines(swarm).filter((m) => m.text.includes('no new issues start')).length;
    swarm.updateRepo(repo.id, { budgetUsd: 100 });
    expect(internals.budgetBlocks(floor())).toBe(false);
    expect(budgetLines(swarm).filter((m) => m.text.includes('no new issues start'))).toHaveLength(over);
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
