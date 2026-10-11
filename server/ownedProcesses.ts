// What cubefarm started, so nothing it owns outlives it and the office can tell the CEO about anything left behind.
//
// The office already knows the processes it spawns itself: the terminal keeper and each agent's CLI arrive with a pid
// (the keeper reports `spawned`), and the floor and PR previews are its own children. Problem: it cannot see what an
// AGENT spawns inside its session -- a demo server started from the agent's own shell is nobody's child. One such
// server is invisible to cleanup: it is not on the agent's reserved port and its command line holds no worktree path,
// so it is never stopped and never dies with its parent. Forty of them piled up on one machine, the oldest ten hours
// old, with dead parents, holding 1.7 GB and a share of the CPU.
//
// This module is the bookkeeping that was missing: what is running, who it belongs to, and which of those are now
// orphaned because their owner has gone. Keeping it pure makes the judgement testable; the office supplies the facts.

/** What kind of thing it is. `cli` and `keeper` are the office's own; the rest belong to a task. */
export type OwnedKind = 'keeper' | 'cli' | 'preview' | 'pr-preview' | 'demo' | 'other';

/** One process the office believes cubefarm is responsible for. */
export interface OwnedProcess {
  pid: number;
  kind: OwnedKind;
  /** The agent it belongs to, when it belongs to one. */
  agentId: string | null;
  /** The agent's name, for a message a human reads. */
  agentName: string | null;
  /** What the agent was doing, so an orphan can be understood without the process table. */
  task: string | null;
  prNumber: number | null;
  issueNumber: number | null;
  /** When the office first saw it, and a short command line to identify it by. */
  firstSeen: number;
  cmdline: string;
}

/** What the owner's liveness looks like to the office, for deciding whether a process is orphaned. */
export interface OwnerState {
  /** The agent still exists and is not stopped/errored. */
  live: boolean;
  /** The agent's current task, so a process from an older task is recognised as left behind. */
  task: string | null;
}

export type Disposition =
  | { state: 'owned' } // the owner is still around and still on this task
  | { state: 'orphaned'; why: string }; // nobody is coming back for it

/**
 * Whether a process still has an owner. Orphaned means the office should stop it: its agent has gone, or has moved on
 * to something else, and nothing is going to close it. A process with no agent at all (the keeper, a floor preview) is
 * never orphaned -- it belongs to the office, which stops it on shutdown.
 */
export function disposition(p: OwnedProcess, owner: OwnerState | null): Disposition {
  if (!p.agentId) return { state: 'owned' };
  if (!owner) return { state: 'orphaned', why: 'its agent is gone' };
  if (!owner.live) return { state: 'orphaned', why: 'its agent is stopped' };
  if (p.task !== owner.task) return { state: 'orphaned', why: `its agent has moved on to ${owner.task ?? 'nothing'}` };
  return { state: 'owned' };
}

/** Everything orphaned right now, with the reason, ready to stop or to report. */
export function orphans(procs: readonly OwnedProcess[], owners: ReadonlyMap<string, OwnerState>): { proc: OwnedProcess; why: string }[] {
  const out: { proc: OwnedProcess; why: string }[] = [];
  for (const p of procs) {
    const d = disposition(p, p.agentId ? (owners.get(p.agentId) ?? null) : null);
    if (d.state === 'orphaned') out.push({ proc: p, why: d.why });
  }
  return out;
}

/**
 * Record a process, or refresh one already known (a task's repeated sweeps find the same servers). Returns the new list.
 * A pid that reappears under a different owner replaces the old entry: Windows reuses pids, and the later sighting is
 * the one the office can act on.
 */
export function track(list: readonly OwnedProcess[], proc: OwnedProcess): OwnedProcess[] {
  const same = list.findIndex((p) => p.pid === proc.pid);
  if (same < 0) return [...list, proc];
  const next = [...list];
  next[same] = { ...proc, firstSeen: list[same].firstSeen }; // keep when we first saw it
  return next;
}

/** Forget processes that are no longer running, so an exited pid never appears as an orphan. */
export function forget(list: readonly OwnedProcess[], alive: ReadonlySet<number>): OwnedProcess[] {
  return list.filter((p) => alive.has(p.pid));
}

/** The one line the CEO and the manager read: how many are tracked, and how many are orphaned. */
export function processSummary(procs: readonly OwnedProcess[], owners: ReadonlyMap<string, OwnerState>): { tracked: number; orphaned: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  for (const p of procs) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  return { tracked: procs.length, orphaned: orphans(procs, owners).length, byKind };
}
