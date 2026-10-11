import { describe, expect, it } from 'vitest';
import {
  BLOCKED_AFTER_MS,
  BOTTLENECK_HOLD_MS,
  buildSnapshot,
  CHECK_MS,
  classifyWorker,
  compactContinuity,
  continuityEqual,
  continuityId,
  deferReason,
  detectSignals,
  dueAgenda,
  emptyContinuity,
  ERROR_ALERT_MS,
  healthFrom,
  hourlyReport,
  HOUR_MS,
  managerCheckPrompt,
  managerSetup,
  managerSystemPrompt,
  mergeContinuity,
  parseContinuity,
  planCadence,
  reconcile,
  recoveryReport,
  serializeContinuity,
  shouldWakeCeo,
  STALL_AFTER_MS,
  truncate,
  type CapacityInput,
  type ContinuityDoc,
  type Incident,
  type SnapshotInput,
  type WorkerInput,
} from './floorManager.ts';

const NOW = 20_000_000_000;
const MIN = 60_000;

const capacity = (over: Partial<CapacityInput> = {}): CapacityInput => ({
  team: 3,
  free: 1,
  busy: 2,
  idle: 1,
  errors: 0,
  ready: 0,
  blocked: 0,
  building: 1,
  inQa: 0,
  fixing: 0,
  toMerge: 0,
  needsYou: 0,
  triage: 0,
  mergesHour: 0,
  mergesToday: 0,
  ...over,
});

const worker = (over: Partial<WorkerInput> = {}): WorkerInput => ({
  id: 'a1',
  name: 'Ada',
  status: 'working',
  task: 'issue',
  issueNumber: 12,
  prNumber: null,
  startedAt: NOW - 30 * MIN,
  endedAt: null,
  activeAt: NOW - MIN,
  work: 'open',
  ...over,
});

const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  repoId: 'o/r',
  fullName: 'o/r',
  floor: 1,
  workers: [worker()],
  qa: [],
  doctor: [],
  capacity: capacity(),
  holds: { usage: 'normal', sessionLimit: 0, sessionsRunning: 0 },
  ...over,
});

describe('planCadence', () => {
  it('runs a check only once five minutes have passed', () => {
    const base = { enabled: true, lastCheckAt: NOW, lastHourlyAt: NOW };
    expect(planCadence(base, NOW + CHECK_MS - 1).run).toBeNull();
    expect(planCadence(base, NOW + CHECK_MS).run).toBe('check');
  });

  it('runs the hourly summary at the hour boundary, and it beats a plain check', () => {
    const base = { enabled: true, lastCheckAt: NOW, lastHourlyAt: NOW };
    expect(planCadence(base, NOW + HOUR_MS).run).toBe('hourly');
    expect(planCadence(base, NOW + HOUR_MS + CHECK_MS).run).toBe('hourly');
  });

  it('counts missed intervals and runs one catch-up, never all of them', () => {
    const base = { enabled: true, lastCheckAt: NOW, lastHourlyAt: NOW };
    const p = planCadence(base, NOW + 4 * CHECK_MS);
    expect(p.run).toBe('check');
    expect(p.overdueChecks).toBe(4);
    expect(p.catchUp).toBe(true);
  });

  it('treats a never-checked manager as due now, and a disabled one as doing nothing', () => {
    expect(planCadence({ enabled: true, lastCheckAt: null, lastHourlyAt: null }, NOW).run).toBe('check');
    expect(planCadence({ enabled: false, lastCheckAt: null, lastHourlyAt: null }, NOW).run).toBeNull();
  });
});

describe('classifyWorker', () => {
  it('distinguishes working, quiet, stopped, failed, idle and unverifiable', () => {
    expect(classifyWorker(worker({ activeAt: NOW - MIN }), NOW)).toBe('working');
    expect(classifyWorker(worker({ activeAt: NOW - 6 * MIN }), NOW)).toBe('quiet');
    expect(classifyWorker(worker({ status: 'stopped' }), NOW)).toBe('stopped');
    expect(classifyWorker(worker({ status: 'error' }), NOW)).toBe('failed');
    expect(classifyWorker(worker({ status: 'idle' }), NOW)).toBe('idle');
    expect(classifyWorker(worker({ activeAt: NaN }), NOW)).toBe('unverifiable');
  });
});

describe('detectSignals', () => {
  it('flags a stalled session only after the watchdog threshold, not a quiet five minutes', () => {
    expect(detectSignals(input({ workers: [worker({ activeAt: NOW - 2 * MIN })] }), NOW)).toEqual([]);
    const [s] = detectSignals(input({ workers: [worker({ activeAt: NOW - STALL_AFTER_MS })] }), NOW);
    expect(s).toMatchObject({ kind: 'stall', key: 'worker:a1', severity: 'bad' });
  });

  it('does not flag a session the manager stopped', () => {
    expect(detectSignals(input({ workers: [worker({ status: 'stopped', activeAt: 0 })] }), NOW)).toEqual([]);
  });

  it('flags a long error, a blocked QA round, a decision and failing checks', () => {
    const errored = detectSignals(input({ workers: [worker({ status: 'error', endedAt: NOW - ERROR_ALERT_MS })] }), NOW);
    expect(errored.map((s) => s.kind)).toContain('error');
    const qa = [
      { prNumber: 1, title: 'A', status: 'failed' as const, round: 1, updatedAt: NOW - BLOCKED_AFTER_MS, checks: 'passing', mergeable: 'MERGEABLE', stuckWhy: null, mergeNote: null },
      { prNumber: 2, title: 'B', status: 'needs-human' as const, round: 3, updatedAt: NOW, checks: 'passing', mergeable: 'MERGEABLE', stuckWhy: 'qa flaky', mergeNote: null },
    ];
    const kinds = detectSignals(input({ qa }), NOW).map((s) => s.kind);
    expect(kinds).toContain('qa-blocked');
    expect(kinds).toContain('decision');
  });

  it('only reports a capacity bottleneck after it has held', () => {
    const busy = input({ capacity: capacity({ free: 0, busy: 3, ready: 5 }) });
    const [sig] = detectSignals(busy, NOW);
    expect(sig).toMatchObject({ kind: 'bottleneck', reportAfterMs: BOTTLENECK_HOLD_MS });
    const first = reconcile('o/r', [], detectSignals(busy, NOW), NOW);
    expect(first.raised).toEqual([]); // not reportable yet
    const later = reconcile('o/r', first.incidents, detectSignals(busy, NOW + BOTTLENECK_HOLD_MS), NOW + BOTTLENECK_HOLD_MS);
    expect(later.raised.map((i) => i.kind)).toEqual(['bottleneck']);
  });
});

describe('reconcile', () => {
  const signal = detectSignals(input({ workers: [worker({ activeAt: NOW - STALL_AFTER_MS })] }), NOW);

  it('raises an incident once, keeps it while it lasts, and reports recovery once', () => {
    const first = reconcile('o/r', [], signal, NOW);
    expect(first.raised).toHaveLength(1);
    const confirmed = { ...first.incidents[0], reportedAt: NOW };
    const again = reconcile('o/r', [confirmed], signal, NOW + CHECK_MS);
    expect(again.raised).toEqual([]); // ongoing: deduplicated
    expect(again.recovered).toEqual([]);
    const gone = reconcile('o/r', [confirmed], [], NOW + 2 * CHECK_MS);
    expect(gone.incidents).toEqual([]);
    expect(gone.recovered.map((i) => i.id)).toEqual([confirmed.id]);
    expect(recoveryReport(confirmed, NOW + 2 * CHECK_MS).text).toContain('Recovered');
  });

  it('does not call an unreported incident a recovery', () => {
    const first = reconcile('o/r', [], signal, NOW);
    const gone = reconcile('o/r', first.incidents, [], NOW + CHECK_MS);
    expect(gone.recovered).toEqual([]);
  });

  it('keeps `since` stable across ticks', () => {
    const a = reconcile('o/r', [], signal, NOW);
    const b = reconcile('o/r', a.incidents, signal, NOW + CHECK_MS);
    expect(b.incidents[0].since).toBe(a.incidents[0].since);
  });
});

describe('continuity', () => {
  it('round-trips through its file format', () => {
    const now = NOW;
    let doc: ContinuityDoc = emptyContinuity();
    doc = mergeContinuity(doc, now, [{ kind: 'blocker', text: 'PR #4 stuck on Vercel' }, { kind: 'decision', text: 'Grew floor 1 to 4' }]).doc;
    const text = serializeContinuity('o/r', doc);
    const back = parseContinuity(text);
    expect(continuityEqual(doc, back)).toBe(true);
    expect(back.entries.map((e) => e.kind).sort()).toEqual(['blocker', 'decision']);
  });

  it('adds only meaningful new facts and says when nothing changed', () => {
    const a = mergeContinuity(emptyContinuity(), NOW, [{ kind: 'fact', text: 'Uses Vite' }]);
    expect(a.changed).toBe(true);
    const id = continuityId('fact', 'Uses Vite');
    const b = mergeContinuity(a.doc, NOW + MIN, [{ kind: 'fact', text: 'Uses Vite' }]);
    expect(b.changed).toBe(false);
    expect(b.doc.entries.map((e) => e.id)).toEqual([id]);
  });

  it('resolves entries and re-adds a resolved one as a fresh entry', () => {
    const a = mergeContinuity(emptyContinuity(), NOW, [{ kind: 'blocker', text: 'PR #4 stuck' }]);
    const id = a.doc.entries[0].id;
    const b = mergeContinuity(a.doc, NOW + MIN, [], [id]);
    expect(b.changed).toBe(true);
    expect(b.removed).toBe(1);
    expect(b.doc.entries).toEqual([]);
  });

  it('compacts to a bound, keeping blockers', () => {
    let doc = emptyContinuity();
    const add = Array.from({ length: 60 }, (_, i) => ({ kind: (i === 0 ? 'blocker' : 'fact') as 'blocker' | 'fact', text: `fact ${i}` }));
    doc = mergeContinuity(doc, NOW, add).doc;
    const small = compactContinuity(doc, 10);
    expect(small.entries).toHaveLength(10);
    expect(small.entries.some((e) => e.kind === 'blocker')).toBe(true);
  });
});

describe('buildSnapshot', () => {
  it('marks quiet as not proof of a hang and bounds the output', () => {
    const { text } = buildSnapshot(input({ workers: [worker({ activeAt: NOW - 6 * MIN })] }), NOW);
    expect(text).toContain('not proof of a hang');
    const big = input({ workers: Array.from({ length: 500 }, (_, i) => worker({ id: `a${i}` })) });
    expect(buildSnapshot(big, NOW).truncated).toBe(true);
  });

  it('marks unavailable telemetry as unverifiable', () => {
    const { text } = buildSnapshot(input({ workers: [worker({ activeAt: NaN })] }), NOW);
    expect(text).toContain('unverifiable');
  });
});

describe('hourlyReport', () => {
  it('summarises a quiet floor honestly and marks missed intervals', () => {
    const report = hourlyReport(input(), [], { now: NOW, missedChecks: 3, downtimeMs: 40 * MIN });
    expect(report.kind).toBe('hourly');
    expect(report.text).toContain('no unresolved incidents');
    expect(report.text).toContain('3 intervals missed');
    expect(report.text).toContain('downtime');
  });
});

describe('fresh-session prompt and setup', () => {
  it('resolves the office default setup, low effort unless overridden', () => {
    const office = { cli: 'claude' as const, model: 'claude-opus-5-5', effort: 'medium' as const };
    expect(managerSetup({ cli: '', model: '', effort: '' }, office)).toEqual({ cli: 'claude', model: 'claude-opus-5-5', effort: 'low' });
    expect(managerSetup({ cli: 'codex', model: 'gpt-6', effort: 'high' }, office)).toEqual({ cli: 'codex', model: 'gpt-6', effort: 'high' });
    expect(managerSetup({ cli: 'codex', model: '', effort: '' }, office)).toEqual({ cli: 'codex', model: '', effort: 'low' });
  });

  it('tells the session it is fresh, must read continuity, and not explore the repo', () => {
    const text = managerSystemPrompt({ name: 'Iris', repo: 'o/r', floor: 2, continuityPath: '/home/continuity.md' });
    expect(text).toMatch(/no memory between checks|no memory of earlier checks/i);
    expect(text).toContain('read_continuity');
    expect(text).toContain('do not explore the repository');
  });

  it('builds a bounded check prompt with the snapshot, continuity and delta context', () => {
    const prompt = managerCheckPrompt({
      snapshot: 'Floor 1 · o/r',
      continuity: '- (e1) uses Vite',
      signals: [{ key: 'x', kind: 'stall', severity: 'bad', text: 'Ada is quiet', evidence: '', action: '' }],
      hourly: true,
      missedChecks: 3,
      agenda: [{ text: 'check PR 4', dueAt: NOW }],
      now: NOW,
    });
    expect(prompt).toContain('hourly summary');
    expect(prompt).toContain('uses Vite');
    expect(prompt).toContain('Ada is quiet');
    expect(prompt).toContain('check PR 4');
    expect(prompt).toContain('3 five-minute intervals were missed');
  });

  it('marks truncation of bounded text', () => {
    expect(truncate('abcdef', 10).truncated).toBe(false);
    expect(truncate('a'.repeat(100), 20).text).toContain('truncated');
  });
});

describe('deferral and CEO wake-ups', () => {
  it('defers a check while paused, draining or full, and never queues a backlog', () => {
    expect(deferReason({ usagePaused: false, draining: false, slotsFull: false })).toBeNull();
    expect(deferReason({ usagePaused: true, draining: false, slotsFull: false })).toContain('paused');
    expect(deferReason({ usagePaused: false, draining: true, slotsFull: false })).toContain('draining');
    expect(deferReason({ usagePaused: false, draining: false, slotsFull: true })).toContain('slots');
  });

  it('wakes the CEO on an unacked report, but never a second reports job at once', () => {
    expect(shouldWakeCeo({ unacked: 0, jobKind: null, queuedKinds: [] })).toBe(false);
    expect(shouldWakeCeo({ unacked: 3, jobKind: null, queuedKinds: [] })).toBe(true);
    expect(shouldWakeCeo({ unacked: 3, jobKind: 'reports', queuedKinds: [] })).toBe(false);
    expect(shouldWakeCeo({ unacked: 3, jobKind: null, queuedKinds: ['reports'] })).toBe(false);
    expect(shouldWakeCeo({ unacked: 3, jobKind: 'chat', queuedKinds: [] })).toBe(true);
  });
});

describe('multiple floors', () => {
  it('keeps each floor\'s incidents apart', () => {
    const one = reconcile('o/a', [], detectSignals(input({ repoId: 'o/a', workers: [worker({ activeAt: NOW - STALL_AFTER_MS })] }), NOW), NOW);
    const two = reconcile('o/b', [], detectSignals(input({ repoId: 'o/b', capacity: capacity({ free: 0, busy: 3, ready: 9 }) }), NOW), NOW);
    expect(one.incidents[0].id.startsWith('o/a:')).toBe(true);
    expect(two.incidents[0].id.startsWith('o/b:')).toBe(true);
  });
});

describe('agenda and health', () => {
  it('surfaces due agenda items and clear them', () => {
    const items = [
      { id: 'a', text: 'check PR', dueAt: NOW - 1, createdAt: NOW - 100, createdBy: 'ceo' as const, doneAt: null },
      { id: 'b', text: 'later', dueAt: NOW + HOUR_MS, createdAt: NOW, createdBy: 'ceo' as const, doneAt: null },
    ];
    expect(dueAgenda(items, NOW).map((i) => i.id)).toEqual(['a']);
  });

  it('reports failed and stalled before healthy', () => {
    const incident = { reportedAt: NOW, text: 'stuck' } as unknown as Incident;
    expect(healthFrom([incident], { enabled: true, running: true, failure: null, deferred: false, recoveredUntil: null, now: NOW }).health).toBe('stalled');
    expect(healthFrom([], { enabled: true, running: true, failure: 'boom', deferred: false, recoveredUntil: null, now: NOW }).health).toBe('failed');
    expect(healthFrom([], { enabled: true, running: false, failure: null, deferred: true, recoveredUntil: null, now: NOW }).health).toBe('deferred');
    expect(healthFrom([], { enabled: true, running: false, failure: null, deferred: false, recoveredUntil: null, now: NOW }).health).toBe('healthy');
    expect(healthFrom([], { enabled: false, running: false, failure: null, deferred: false, recoveredUntil: null, now: NOW }).health).toBe('disabled');
  });
});
