import { describe, expect, it } from 'vitest';
import { fixGoesTo, pickTester, PREP_HOLD_MS, prepFailure, prepHeld, SELF_QA_WAIT_MS, type FixAuthor } from './handOut.ts';

const author = (o: Partial<FixAuthor> = {}): FixAuthor => ({ status: 'done', branch: 'swarm/issue-192-barbara', prNumber: 198, ...o });
const HEAD = 'swarm/issue-192-barbara';

describe('fixGoesTo', () => {
  it('waits for an author still working on the issue whose PR QA failed (#198)', () => {
    // Barbara opened PR #198 mid-session: still on task 'issue', no PR number recorded yet, desk on the branch.
    expect(fixGoesTo(author({ status: 'working', prNumber: null }), false, 198, HEAD)).toBe('wait');
    expect(fixGoesTo(author({ status: 'preparing', prNumber: null }), false, 198, HEAD)).toBe('wait');
    expect(fixGoesTo(author({ status: 'working', branch: 'elsewhere' }), false, 198, null)).toBe('wait');
  });

  it('goes to the author when they are free', () => {
    expect(fixGoesTo(author(), true, 198, HEAD)).toBe('author');
    expect(fixGoesTo(author({ status: 'error' }), true, 198, HEAD)).toBe('author'); // their cooldown is over
  });

  it('goes to anyone free when the author is gone, errored or busy with other work', () => {
    expect(fixGoesTo(null, false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'error' }), false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'stopped' }), false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'working', branch: 'swarm/issue-200-barbara', prNumber: null }), false, 198, HEAD)).toBe('anyone');
    expect(fixGoesTo(author({ status: 'working', branch: 'qa/pr-201-barbara', prNumber: 201 }), false, 198, HEAD)).toBe('anyone');
  });
});

describe('prepFailure', () => {
  const now = 1_000_000;

  it('hands the PR out again after one failed desk, and the budget is untouched', () => {
    const step = prepFailure(undefined, 0, 2, now);
    expect(step).toEqual({ strikes: { failures: 1, holdUntil: 0 }, next: 'retry', sessionFailures: 0 });
    expect(prepHeld(step.strikes, now)).toBe(false);
  });

  it('holds the PR after a second failure in a row, which costs one failed session', () => {
    const first = prepFailure(undefined, 0, 2, now);
    const second = prepFailure(first.strikes, 0, 2, now + 5_000);
    expect(second).toEqual({ strikes: { failures: 0, holdUntil: now + 5_000 + PREP_HOLD_MS }, next: 'hold', sessionFailures: 1 });
    expect(prepHeld(second.strikes, now + 6_000)).toBe(true);
    expect(prepHeld(second.strikes, now + 5_000 + PREP_HOLD_MS)).toBe(false);
  });

  it('sends it to the manager once the budget is spent, so it never loops', () => {
    let strikes = prepFailure(undefined, 1, 2, now).strikes;
    const step = prepFailure(strikes, 1, 2, now);
    expect(step.next).toBe('needs-human');
    expect(step.sessionFailures).toBe(2);
    // From a fresh PR: two holds at most, four failed desks in all.
    let failures = 0;
    const outcomes: string[] = [];
    strikes = { failures: 0, holdUntil: 0 };
    for (let i = 0; i < 4; i++) {
      const s = prepFailure(strikes, failures, 2, now);
      strikes = s.strikes;
      failures = s.sessionFailures;
      outcomes.push(s.next);
    }
    expect(outcomes).toEqual(['retry', 'hold', 'retry', 'needs-human']);
  });

  it('is not held without strikes', () => {
    expect(prepHeld(undefined, now)).toBe(false);
  });
});

describe('pickTester', () => {
  const ada = { id: 'ada', desk: 0 };
  const linus = { id: 'linus', desk: 1 };
  const grace = { id: 'grace', desk: 2 };
  // No pairing to differ from: everyone ranks the same, as before #8.
  const noPairing = () => ({ cli: 'claude' as const, model: 'claude-sonnet-5' });

  it("picks anyone but the PR's author, by desk", () => {
    expect(pickTester([ada, linus, grace], 'ada', noPairing, null, new Set(), true, 0)).toBe(linus);
    expect(pickTester([grace, linus], null, noPairing, null, new Set(), true, 0)).toBe(linus);
  });

  it('keeps agents whose failed PRs wait for them for last', () => {
    expect(pickTester([ada, linus, grace], 'ada', noPairing, null, new Set(['linus']), true, 0)).toBe(grace);
    expect(pickTester([ada, linus], 'ada', noPairing, null, new Set(['linus']), true, 0)).toBe(linus);
  });

  it('leaves the PR for someone else to come free, rather than have its author test it', () => {
    // Agents finishing one by one: each PR's author is the only one free when it enters QA (as seen in the demo).
    expect(pickTester([ada], 'ada', noPairing, null, new Set(), true, 0)).toBeNull();
    expect(pickTester([ada], 'ada', noPairing, null, new Set(), true, SELF_QA_WAIT_MS - 1)).toBeNull();
  });

  it('lets the author test it when nobody else can, or nobody else came free for a while', () => {
    expect(pickTester([ada], 'ada', noPairing, null, new Set(), false, 0)).toBe(ada); // a one-agent floor never stalls
    expect(pickTester([ada], 'ada', noPairing, null, new Set(), true, SELF_QA_WAIT_MS)).toBe(ada);
  });

  it('has nobody to pick from an empty floor', () => {
    expect(pickTester([], 'ada', noPairing, null, new Set(), false, SELF_QA_WAIT_MS)).toBeNull();
  });

  describe('with resolved coding agents and models (#8)', () => {
    const deepseek = { id: 'deepseek', desk: 0 };
    const claude = { id: 'claude', desk: 1 };
    const claudePro = { id: 'claude-pro', desk: 2 };
    const pairing: Record<string, { cli: 'claude' | 'opencode' | 'codex'; model: string }> = {
      deepseek: { cli: 'opencode', model: '' },
      claude: { cli: 'claude', model: 'claude-sonnet-5' },
      'claude-pro': { cli: 'claude', model: 'claude-opus-5' },
    };

    it("prefers a tester whose coding agent differs from the author's, before desk order", () => {
      // The DeepSeek (OpenCode) agent's PR is checked by the Claude agent, not the lower-desk OpenCode teammate.
      expect(pickTester([deepseek, claude], 'deepseek', (a) => pairing[a.id], pairing.deepseek, new Set(), true, 0)).toBe(claude);
    });

    it("then prefers a different model when the coding agent is the same", () => {
      // Only Claude agents are free: the one on a different model tests it.
      expect(pickTester([claudePro, claude], 'claude', (a) => pairing[a.id], pairing.claude, new Set(), true, 0)).toBe(claudePro);
    });

    it('falls back to the same pairing when nothing differs, never the author', () => {
      const another = { id: 'deepseek-2', desk: 5 };
      const same: Record<string, { cli: 'claude' | 'opencode' | 'codex'; model: string }> = { ...pairing, 'deepseek-2': { cli: 'opencode', model: '' } };
      // Only a same-pairing teammate is free: they test it rather than the author.
      expect(pickTester([deepseek, another], 'deepseek', (a) => same[a.id], same.deepseek, new Set(), true, 0)).toBe(another);
    });

    it('still never picks the PR author, even when their coding agent differs from everyone', () => {
      expect(pickTester([claude, deepseek], 'deepseek', (a) => pairing[a.id], pairing.deepseek, new Set(), false, 0)).toBe(claude);
    });
  });
});
