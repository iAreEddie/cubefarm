import { describe, expect, it } from 'vitest';
import { askedFor, ceoJobPrompt, ceoSystemPrompt, NOT_ASKED } from './ceo.ts';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// Only the manager decides on new work: the CEO files issues only in a job the manager started by asking for work
// (a plan from their brief, or their message), never in its own reviews, onboarding or triage.
type Internals = {
  ensureCeo(interrupted: unknown[]): void;
  fileIssue(x: { floor: number; title: string; body: string }): Promise<string>;
  ceoAsked: boolean;
  state: { ceo: { queue: { kind: string; repoId?: string }[] } };
};

describe('who asks for new work', () => {
  it("is the manager: their plans and messages, not the CEO's own jobs", () => {
    expect(askedFor({ kind: 'plan' })).toBe(true);
    expect(askedFor({ kind: 'chat' })).toBe(true);
    for (const kind of ['review', 'onboard', 'triage'] as const) expect(askedFor({ kind })).toBe(false);
  });

  it('is in the prompts: reviews and onboarding suggest work instead of filing it', () => {
    const system = ceoSystemPrompt({ name: 'Luna', company: 'Acme', manager: 'Sam', notesFile: 'notes.md', sessionLimit: 0, maxAgents: 10, scaling: 'approve' });
    expect(system).toContain('Never decide on new work yourself.');
    const review = ceoJobPrompt({ kind: 'review', at: 0 }, null);
    expect(review).not.toContain('plan the next milestone');
    expect(review).toContain('file no issues');
    const floor = { floor: 2, fullName: 'acme/app', clone: '/clones/app', mission: 'Add voice messages', backlog: 0 };
    const onboard = ceoJobPrompt({ kind: 'onboard', repoId: 'r1', at: 0 }, floor);
    expect(onboard).toContain('File no issues');
    expect(onboard).not.toContain('plan the first milestone');
    expect(ceoJobPrompt({ kind: 'onboard', repoId: 'r1', at: 0 }, { ...floor, mission: '', backlog: 3 })).toContain('file no new ones');
  });
});

describe("the CEO's file_issue", () => {
  async function office(mission?: string) {
    const swarm = new Swarm(createDemoBackend());
    await swarm.connectRepo('demo-co/pixel-todo', { mission });
    const internals = swarm as unknown as Internals;
    internals.ensureCeo([]);
    return { swarm, internals };
  }

  it("is refused in a job the manager didn't ask for", async () => {
    const { internals } = await office();
    internals.ceoAsked = false;
    await expect(internals.fileIssue({ floor: 1, title: 'Add a dark mode', body: 'Nobody asked.' })).rejects.toThrow(NOT_ASKED);
  });

  it('files work the manager asked for', async () => {
    const { internals } = await office();
    internals.ceoAsked = true;
    await expect(internals.fileIssue({ floor: 1, title: 'Add a dark mode', body: 'The manager asked.' })).resolves.toMatch(/^Filed #\d+ on floor 1: Add a dark mode\.$/);
  });

  it('plans a brief given when the project moves in, as a job of its own after onboarding', async () => {
    expect((await office('A cozy island bakery')).internals.state.ceo.queue.map((j) => j.kind)).toEqual(['onboard', 'plan']);
    expect((await office()).internals.state.ceo.queue.map((j) => j.kind)).toEqual(['onboard']);
  });
});

describe('the CEO job queue', () => {
  type QueueInternals = {
    state: { ceo: { queue: { kind: string; repoId?: string; text?: string }[]; job: { kind: string } | null } };
    enqueueCeo(job: { kind: string; at: number; repoId?: string; text?: string }): void;
  };
  const fresh = () => new Swarm(createDemoBackend()) as unknown as QueueInternals;

  it('keeps only one review, so a burst of callers cannot stack up reviews of an unchanged company', () => {
    // The heartbeat and the quiet-session reports both reach for a review, and the dedupe only looked at the queue, so a
    // caller firing while one was in flight queued another: the CEO then answered "keep six agents, no changes needed"
    // back to back while the manager's messages waited behind it.
    const s = fresh();
    s.enqueueCeo({ kind: 'review', at: 1 });
    s.enqueueCeo({ kind: 'review', at: 2 });
    expect(s.state.ceo.queue.map((j) => j.kind)).toEqual(['review']);

    // A second report while one is already running adds nothing, however many are lined up behind it.
    s.state.ceo.job = { kind: 'review' };
    s.enqueueCeo({ kind: 'review', at: 3 });
    expect(s.state.ceo.queue.filter((j) => j.kind === 'review')).toHaveLength(1);

    // With nothing running and nothing queued, one still gets through.
    const t = fresh();
    t.enqueueCeo({ kind: 'review', at: 1 });
    expect(t.state.ceo.queue.map((j) => j.kind)).toEqual(['review']);
  });

  it('still queues the work the manager asked for, and merges consecutive chats into one job', () => {
    const s = fresh();
    s.enqueueCeo({ kind: 'plan', repoId: 'r1', at: 1 });
    s.enqueueCeo({ kind: 'chat', text: 'first', at: 2 });
    s.enqueueCeo({ kind: 'chat', text: 'second', at: 3 });
    expect(s.state.ceo.queue.map((j) => j.kind)).toEqual(['plan', 'chat']);
    expect(s.state.ceo.queue[1].text).toBe('first\nsecond');
  });
});
