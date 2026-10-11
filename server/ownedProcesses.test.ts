import { describe, expect, it } from 'vitest';
import { disposition, forget, orphans, processSummary, track, type OwnedProcess, type OwnerState } from './ownedProcesses.ts';

const proc = (o: Partial<OwnedProcess> = {}): OwnedProcess => ({
  pid: 100,
  kind: 'demo',
  agentId: 'a1',
  agentName: 'Grace',
  task: 'qa',
  prNumber: 28,
  issueNumber: 26,
  firstSeen: 1000,
  cmdline: 'node server/index.ts --demo',
  ...o,
});

const owner = (o: Partial<OwnerState> = {}): OwnerState => ({ live: true, task: 'qa', ...o });

describe('disposition', () => {
  it('owns a process whose agent is still on that task', () => {
    expect(disposition(proc(), owner())).toEqual({ state: 'owned' });
  });

  it('orphans one whose agent has gone or stopped', () => {
    // The leak this exists for: a demo server outliving the session that started it, with no way to find it.
    expect(disposition(proc(), null)).toEqual({ state: 'orphaned', why: 'its agent is gone' });
    expect(disposition(proc(), owner({ live: false }))).toEqual({ state: 'orphaned', why: 'its agent is stopped' });
  });

  it('orphans one left behind when the agent moved on to other work', () => {
    expect(disposition(proc({ task: 'qa' }), owner({ task: 'fix' }))).toEqual({ state: 'orphaned', why: 'its agent has moved on to fix' });
    expect(disposition(proc({ task: 'qa' }), owner({ task: null }))).toEqual({ state: 'orphaned', why: 'its agent has moved on to nothing' });
  });

  it('never orphans the office\u2019s own processes: it stops those itself', () => {
    // The keeper and a floor preview have no agent; they are the office's, and shutdown closes them.
    expect(disposition(proc({ agentId: null, kind: 'keeper', task: null }), null)).toEqual({ state: 'owned' });
    expect(disposition(proc({ agentId: null, kind: 'preview' }), null)).toEqual({ state: 'owned' });
  });
});

describe('orphans', () => {
  it('lists only what has lost its owner, with a reason each', () => {
    const procs = [
      proc({ pid: 1, agentId: 'a1', task: 'qa' }),
      proc({ pid: 2, agentId: 'a2', task: 'qa' }),
      proc({ pid: 3, agentId: 'gone', task: 'qa' }),
      proc({ pid: 4, agentId: null, kind: 'keeper', task: null }),
    ];
    const owners = new Map<string, OwnerState>([
      ['a1', owner({ task: 'qa' })],
      ['a2', owner({ task: 'fix' })],
    ]);
    const out = orphans(procs, owners);
    expect(out.map((o) => o.proc.pid)).toEqual([2, 3]);
    expect(out[0].why).toBe('its agent has moved on to fix');
    expect(out[1].why).toBe('its agent is gone');
  });

  it('finds nothing when every owner is present and still on task', () => {
    const owners = new Map<string, OwnerState>([['a1', owner()]]);
    expect(orphans([proc()], owners)).toEqual([]);
  });
});

describe('track and forget', () => {
  it('adds a new pid, and refreshes a known one without losing when it was first seen', () => {
    const list = track([], proc({ pid: 7, firstSeen: 500 }));
    expect(list).toHaveLength(1);
    const again = track(list, proc({ pid: 7, firstSeen: 9999, cmdline: 'node server/index.ts --demo --port 5649' }));
    expect(again).toHaveLength(1);
    expect(again[0].firstSeen).toBe(500); // the original sighting
    expect(again[0].cmdline).toContain('--port 5649'); // the newest detail
  });

  it('lets a reused pid belong to whoever is running it now', () => {
    const list = track([], proc({ pid: 7, agentId: 'a1' }));
    const reused = track(list, proc({ pid: 7, agentId: 'a2', agentName: 'Ada' }));
    expect(reused).toHaveLength(1);
    expect(reused[0].agentId).toBe('a2');
  });

  it('drops pids that are no longer running, so an exited one is never called an orphan', () => {
    const list = [proc({ pid: 1 }), proc({ pid: 2 })];
    expect(forget(list, new Set([2])).map((p) => p.pid)).toEqual([2]);
    expect(forget(list, new Set())).toEqual([]);
  });
});

describe('processSummary', () => {
  it('counts what is tracked, what is orphaned, and what kinds they are', () => {
    const procs = [
      proc({ pid: 1, kind: 'demo', agentId: 'a1', task: 'qa' }),
      proc({ pid: 2, kind: 'demo', agentId: 'gone', task: 'qa' }),
      proc({ pid: 3, kind: 'keeper', agentId: null, task: null }),
    ];
    const owners = new Map<string, OwnerState>([['a1', owner()]]);
    expect(processSummary(procs, owners)).toEqual({ tracked: 3, orphaned: 1, byKind: { demo: 2, keeper: 1 } });
  });
});
