// The AI floor manager (#18): one identifiable supervisor per connected repository, separate from the interchangeable
// builders and QA. Every five minutes it collects a bounded, floor-only snapshot of the office's own signals, starts a
// fresh low-effort session that reads a per-repo continuity file and assesses what it sees, and reports only material
// events to the CEO; every hour it also sends a summary even when quiet. This module is the pure part: cadence,
// snapshot building, deterministic incident checks, incident reconciliation, continuity, reports, agenda and prompts.
// The swarm owns the sessions, the files and the persistence; nothing here touches the network or disk.

import type { AgentCli, AgentStatus, EffortLevel, QaStatus } from '../shared/types.ts';

export const CHECK_MS = 5 * 60_000;
export const HOUR_MS = 60 * 60_000;
/** A session with no output or tool activity this long is stalled (the watchdog's own threshold). */
export const STALL_AFTER_MS = 20 * 60_000;
/** A failed session the manager hears about after this long. */
export const ERROR_ALERT_MS = 10 * 60_000;
/** A PR stuck in QA, checks or merge this long is a material incident. */
export const BLOCKED_AFTER_MS = 30 * 60_000;
/** A capacity bottleneck must hold this long before it is worth a report (sustained, not a spike). */
export const BOTTLENECK_HOLD_MS = 15 * 60_000;
/** A five-minute interval with no output is not proof of a hang: only after STALL_AFTER_MS is it an incident. */
export const QUIET_AFTER_MS = 5 * 60_000;

export const SNAPSHOT_MAX = 6000;
export const CONTINUITY_MAX = 4000;
export const CONTINUITY_ENTRIES = 40;
export const REPORT_TEXT_MAX = 1200;
export const REPORT_EVIDENCE_MAX = 600;
export const INBOX_MAX = 100;
export const AGENDA_MAX = 20;
export const MAX_REPORT_AGE_MS = 7 * 24 * HOUR_MS;
/** The model/effort a check uses unless the manager overrides: cheap and frequent. */
export const DEFAULT_CHECK_EFFORT: EffortLevel = 'low';

/** Cut text to a bound, marking that it was cut and how much. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const marker = `\n…[truncated ${text.length - max} chars]`;
  return { text: text.slice(0, Math.max(0, max - marker.length)) + marker, truncated: true };
}

// ---------- cadence ----------

export interface CadenceState {
  enabled: boolean;
  lastCheckAt: number | null;
  lastHourlyAt: number | null;
}

export interface CadencePlan {
  /** The one session to start now (checks and the hourly summary coalesce; busy ticks defer, never queue up). */
  run: 'check' | 'hourly' | null;
  nextCheckAt: number;
  nextHourlyAt: number;
  /** How many five-minute checks were missed (0 = on time, 1 = due now, 2+ = a resume). */
  overdueChecks: number;
  /** A restart/resume that missed intervals: run one catch-up, never all of them. */
  catchUp: boolean;
}

/**
 * What to run now. A disabled manager does nothing. The hourly summary wins over a plain check (it carries the
 * summary anyway). lastCheckAt null counts as "due now" so a manager added before this existed starts at once.
 */
export function planCadence(c: CadenceState, now: number): CadencePlan {
  const baseCheck = c.lastCheckAt ?? now - CHECK_MS;
  const overdueChecks = Math.max(0, Math.floor((now - baseCheck) / CHECK_MS));
  const nextCheckAt = baseCheck + CHECK_MS;
  const nextHourlyAt = (c.lastHourlyAt ?? now) + HOUR_MS;
  if (!c.enabled) return { run: null, nextCheckAt, nextHourlyAt, overdueChecks, catchUp: overdueChecks >= 2 };
  if (c.lastHourlyAt != null && now >= c.lastHourlyAt + HOUR_MS) return { run: 'hourly', nextCheckAt, nextHourlyAt, overdueChecks, catchUp: overdueChecks >= 2 };
  if (now >= nextCheckAt) return { run: 'check', nextCheckAt, nextHourlyAt, overdueChecks, catchUp: overdueChecks >= 2 };
  return { run: null, nextCheckAt, nextHourlyAt, overdueChecks, catchUp: overdueChecks >= 2 };
}

/**
 * Why a check can't start right now: the office is paused at Claude's usage limit, draining for an update, or every
 * session slot is full. A deferred check coalesces and retries; it is never queued up as a backlog of missed checks.
 */
export function deferReason(o: { usagePaused: boolean; draining: boolean; slotsFull: boolean }): string | null {
  if (o.usagePaused) return 'Claude usage is paused; the check is deferred';
  if (o.draining) return 'the office is draining for an update; the check is deferred';
  if (o.slotsFull) return 'all session slots are full; the check is deferred';
  return null;
}

/**
 * Whether a material report should wake the CEO now. One reports job at a time: while the CEO is on a reports job or
 * one is already queued, further reports coalesce into it, so there is never a second concurrent CEO session.
 */
export function shouldWakeCeo(o: { unacked: number; jobKind: string | null; queuedKinds: readonly string[] }): boolean {
  return o.unacked > 0 && o.jobKind !== 'reports' && !o.queuedKinds.includes('reports');
}

// ---------- continuity ----------

export type ContinuityKind = 'fact' | 'blocker' | 'decision' | 'follow-up';

export interface ContinuityEntry {
  id: string;
  kind: ContinuityKind;
  text: string;
  at: number;
}

export interface ContinuityDoc {
  entries: ContinuityEntry[];
}

const KINDS: ContinuityKind[] = ['blocker', 'follow-up', 'decision', 'fact'];
const KIND_LABEL: Record<ContinuityKind, string> = { fact: 'Facts', blocker: 'Unresolved blockers', decision: 'Decisions', 'follow-up': 'Follow-ups' };

export function emptyContinuity(): ContinuityDoc {
  return { entries: [] };
}

/** A stable id for a continuity entry, so the same fact repeated does not pile up. */
export function continuityId(kind: ContinuityKind, text: string): string {
  let h = 5381;
  const s = `${kind}:${text.trim().toLowerCase()}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `e${h.toString(36)}`;
}

const CONT_LINE = /^-\s*\(([^)]+)\)\s*(.*)$/;

/** Parse a continuity file: a title, per-kind headings, and one `- (id) text` line each. */
export function parseContinuity(text: string): ContinuityDoc {
  const entries: ContinuityEntry[] = [];
  let kind: ContinuityKind = 'fact';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = KINDS.find((k) => KIND_LABEL[k].toLowerCase() === line.replace(/^#+\s*/, '').toLowerCase());
    if (heading) {
      kind = heading;
      continue;
    }
    const m = CONT_LINE.exec(line);
    if (m && !entries.some((e) => e.id === m[1])) entries.push({ id: m[1], kind, text: m[2].trim(), at: 0 });
  }
  return { entries };
}

export function serializeContinuity(repoId: string, doc: ContinuityDoc): string {
  const lines = [`# Floor manager continuity — ${repoId}`, ''];
  for (const kind of KINDS) {
    const group = doc.entries.filter((e) => e.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${KIND_LABEL[kind]}`);
    for (const e of group) lines.push(`- (${e.id}) ${e.text}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** True when two docs hold the same entries (id, kind, text), so a rewrite would say nothing new. */
export function continuityEqual(a: ContinuityDoc, b: ContinuityDoc): boolean {
  if (a.entries.length !== b.entries.length) return false;
  const key = (e: ContinuityEntry) => `${e.id}\u0000${e.kind}\u0000${e.text}`;
  const as = [...a.entries].map(key).sort();
  const bs = [...b.entries].map(key).sort();
  return as.every((x, i) => x === bs[i]);
}

/**
 * Apply an assessment's continuity update: resolve ids, then add/replace new entries (replacing an id updates it and
 * refreshes `at`). `changed` is false when the doc is identical, so the caller can leave the file alone.
 */
export function mergeContinuity(doc: ContinuityDoc, now: number, add: { id?: string; kind: ContinuityKind; text: string }[], resolve: string[] = []): { doc: ContinuityDoc; changed: boolean; added: number; removed: number } {
  const resolved = new Set(resolve.map((r) => r.trim()).filter(Boolean));
  const kept = doc.entries.filter((e) => !resolved.has(e.id));
  const removed = doc.entries.length - kept.length;
  const byId = new Map(kept.map((e) => [e.id, e] as const));
  let added = 0;
  for (const a of add) {
    const kind = KINDS.includes(a.kind) ? a.kind : 'fact';
    const text = String(a.text ?? '').trim().slice(0, 400);
    if (!text) continue;
    const id = (a.id ?? continuityId(kind, text)).trim() || continuityId(kind, text);
    const prev = byId.get(id);
    if (prev && prev.kind === kind && prev.text === text) continue;
    byId.set(id, { id, kind, text, at: now });
    added++;
  }
  const next: ContinuityDoc = { entries: [...byId.values()] };
  return { doc: next, changed: added > 0 || removed > 0, added, removed };
}

/** Keep the file compact: drop the oldest resolved/obsolete entries, keeping blockers and recent items first. */
export function compactContinuity(doc: ContinuityDoc, max = CONTINUITY_ENTRIES): ContinuityDoc {
  if (doc.entries.length <= max) return doc;
  const rank: Record<ContinuityKind, number> = { blocker: 0, 'follow-up': 1, decision: 2, fact: 3 };
  const keep = [...doc.entries].sort((a, b) => rank[a.kind] - rank[b.kind] || b.at - a.at).slice(0, max);
  return { entries: keep.sort((a, b) => a.at - b.at) };
}

// ---------- the floor snapshot ----------

export type WorkerObservation = 'working' | 'quiet' | 'stopped' | 'failed' | 'idle' | 'unverifiable';

export interface WorkerInput {
  id: string;
  name: string;
  status: AgentStatus;
  task: 'issue' | 'qa' | 'fix' | null;
  issueNumber: number | null;
  prNumber: number | null;
  startedAt: number | null;
  endedAt: number | null;
  activeAt: number;
  work: 'open' | 'closed' | 'merged' | 'unknown';
}

export interface QaInput {
  prNumber: number;
  title: string;
  status: QaStatus;
  round: number;
  updatedAt: number;
  checks: string;
  mergeable: string;
  stuckWhy: string | null;
  mergeNote: string | null;
}

export interface DoctorInput {
  id: string;
  kind: string;
  text: string;
  since: number;
}

export interface CapacityInput {
  team: number;
  free: number;
  busy: number;
  idle: number;
  errors: number;
  ready: number;
  blocked: number;
  building: number;
  inQa: number;
  fixing: number;
  toMerge: number;
  needsYou: number;
  triage: number;
  mergesHour: number;
  mergesToday: number;
}

export interface HoldsInput {
  usage: 'normal' | 'pacing' | 'paused';
  sessionLimit: number;
  sessionsRunning: number;
}

export interface SnapshotInput {
  repoId: string;
  fullName: string;
  floor: number;
  workers: WorkerInput[];
  qa: QaInput[];
  doctor: DoctorInput[];
  capacity: CapacityInput;
  holds: HoldsInput;
}

/**
 * How the snapshot reads a worker. working vs quiet vs stopped-by-the-human vs failed vs unverifiable are kept
 * distinct: a quiet five-minute interval is not proof of a hang, and a stopped session is the manager's own doing.
 */
export function classifyWorker(w: WorkerInput, now: number): WorkerObservation {
  if (w.status === 'stopped') return 'stopped';
  if (w.status === 'error') return 'failed';
  if (w.status !== 'working' && w.status !== 'preparing') return 'idle';
  if (!Number.isFinite(w.activeAt)) return 'unverifiable';
  if (now - w.activeAt >= QUIET_AFTER_MS) return 'quiet';
  return 'working';
}

const mins = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))}m`;
const observeWords: Record<WorkerObservation, string> = {
  working: 'working',
  quiet: 'quiet (no output; not proof of a hang)',
  stopped: 'stopped by the manager',
  failed: 'failed',
  idle: 'idle',
  unverifiable: 'unverifiable (no telemetry)',
};

/** Build the bounded, floor-only text a check session reads, with freshness/truncation markers. */
export function buildSnapshot(input: SnapshotInput, now: number): { text: string; truncated: boolean } {
  const lines: string[] = [
    `Floor ${input.floor} · ${input.fullName} · snapshot ${new Date(now).toISOString()}`,
    `Holds: usage ${input.holds.usage}` +
      (input.holds.sessionLimit ? ` · session limit ${input.holds.sessionLimit}, ${input.holds.sessionsRunning} running` : '') +
      ' · (deterministic checks; AI assessment is separate)',
    '',
    'Workers:',
  ];
  const workers = [...input.workers].sort((a, b) => a.id.localeCompare(b.id));
  if (!workers.length) lines.push('  (none)');
  for (const w of workers) {
    const obs = classifyWorker(w, now);
    const what = w.task === 'qa' ? `QA PR #${w.prNumber}` : w.task === 'fix' ? `fix PR #${w.prNumber}` : w.task === 'issue' ? `issue #${w.issueNumber}` : 'no task';
    const beat = w.status === 'working' || w.status === 'preparing' ? ` · last activity ${mins(now - w.activeAt)} ago` : '';
    const elapsed = w.startedAt ? ` · ${mins(now - w.startedAt)} in` : '';
    lines.push(`  - ${w.name} [${w.id}] ${what} · ${obs} · ${observeWords[obs]}${beat}${elapsed} · work ${w.work}`);
  }
  lines.push('', 'Pull requests and QA:');
  if (!input.qa.length) lines.push('  (none)');
  for (const q of [...input.qa].sort((a, b) => a.prNumber - b.prNumber)) {
    const held = `QA ${q.status} round ${q.round} · ${mins(now - q.updatedAt)} since update · checks ${q.checks} · mergeable ${q.mergeable}`;
    lines.push(`  - PR #${q.prNumber} "${q.title}" · ${held}${q.stuckWhy ? ` · why: ${q.stuckWhy}` : ''}${q.mergeNote ? ` · merge: ${q.mergeNote}` : ''}`);
  }
  const c = input.capacity;
  lines.push(
    '',
    'Capacity:',
    `  team ${c.team} (${c.free} free, ${c.busy} busy, ${c.idle} idle, ${c.errors} in error)`,
    `  backlog ready ${c.ready}, dependency-blocked ${c.blocked}; building ${c.building}, in QA ${c.inQa}, fixing ${c.fixing}, to merge ${c.toMerge}, needs-you ${c.needsYou}, triage ${c.triage}`,
    `  merged last hour ${c.mergesHour}, today ${c.mergesToday}`,
  );
  if (input.doctor.length) {
    lines.push('', 'Doctor findings:');
    for (const d of input.doctor) lines.push(`  - [${d.kind}] ${d.text} (${mins(now - d.since)})`);
  }
  return truncate(lines.join('\n'), SNAPSHOT_MAX);
}

// ---------- deterministic incident checks ----------

export type IncidentKind = 'stall' | 'error' | 'qa-blocked' | 'checks-blocked' | 'merge-blocked' | 'bottleneck' | 'decision';
export const INCIDENT_KINDS: IncidentKind[] = ['stall', 'error', 'qa-blocked', 'checks-blocked', 'merge-blocked', 'bottleneck', 'decision'];

export interface ManagerSignal {
  key: string;
  kind: IncidentKind;
  severity: 'info' | 'warn' | 'bad';
  text: string;
  evidence: string;
  action: string;
  /** Only report once the condition has held this long (sustained problems only). */
  reportAfterMs?: number;
}

/** The floor's deterministic checks: what is stuck or blocked beyond a threshold right now. */
export function detectSignals(input: SnapshotInput, now: number): ManagerSignal[] {
  const out: ManagerSignal[] = [];
  for (const w of input.workers) {
    if (w.status === 'working' && now - w.activeAt >= STALL_AFTER_MS) {
      const what = w.task === 'qa' ? `QA on PR #${w.prNumber}` : w.task === 'fix' ? `the fix on PR #${w.prNumber}` : `issue #${w.issueNumber}`;
      out.push({
        key: `worker:${w.id}`,
        kind: 'stall',
        severity: 'bad',
        text: `${w.name} has been quiet for ${mins(now - w.activeAt)} on ${what}.`,
        evidence: `last activity ${new Date(w.activeAt).toISOString()}`,
        action: 'Consider letting the watchdog put the work back in line, or check whether the session needs help.',
      });
    } else if (w.status === 'error' && now - (w.endedAt ?? w.startedAt ?? now) >= ERROR_ALERT_MS) {
      out.push({
        key: `worker:${w.id}`,
        kind: 'error',
        severity: 'bad',
        text: `${w.name} has been in an error for ${mins(now - (w.endedAt ?? w.startedAt ?? now))}.`,
        evidence: `${w.name} [${w.id}] status error${w.task ? ` on ${w.task}` : ''}`,
        action: 'Its work may need reassigning once the session is cleared.',
      });
    }
  }
  for (const q of input.qa) {
    if (q.status === 'needs-human') {
      out.push({
        key: `pr:${q.prNumber}`,
        kind: 'decision',
        severity: 'warn',
        text: `PR #${q.prNumber} "${q.title}" needs a human decision.`,
        evidence: q.stuckWhy ?? `needs-human (round ${q.round})`,
        action: 'The CEO should triage it through the existing triage path before it reaches you.',
        reportAfterMs: 0,
      });
      continue;
    }
    if ((q.status === 'failed' || q.status === 'queued' || q.status === 'testing' || q.status === 'fixing') && now - q.updatedAt >= BLOCKED_AFTER_MS) {
      out.push({
        key: `pr:${q.prNumber}`,
        kind: 'qa-blocked',
        severity: 'warn',
        text: `PR #${q.prNumber} "${q.title}" has sat in QA (${q.status}) for ${mins(now - q.updatedAt)}.`,
        evidence: `round ${q.round} · checks ${q.checks}`,
        action: 'Check whether a free agent can pick it up; if it keeps stalling, queue it through triage.',
      });
      continue;
    }
    if (q.checks === 'failing' && now - q.updatedAt >= BLOCKED_AFTER_MS) {
      out.push({
        key: `pr:${q.prNumber}`,
        kind: 'checks-blocked',
        severity: 'warn',
        text: `PR #${q.prNumber} "${q.title}" has had failing checks for ${mins(now - q.updatedAt)}.`,
        evidence: `mergeable ${q.mergeable}`,
        action: 'Queue it through triage (rerun or a fix) if it looks stuck.',
      });
      continue;
    }
    if (q.status === 'passed' && q.mergeNote && now - q.updatedAt >= BLOCKED_AFTER_MS) {
      out.push({
        key: `pr:${q.prNumber}`,
        kind: 'merge-blocked',
        severity: 'warn',
        text: `PR #${q.prNumber} "${q.title}" passed QA but is stuck at merge: ${q.mergeNote}.`,
        evidence: `checks ${q.checks} · mergeable ${q.mergeable}`,
        action: 'It may need a human (or a retry) to merge.',
      });
    }
  }
  const c = input.capacity;
  if (c.ready > 0 && c.free === 0 && c.ready >= Math.max(1, c.team)) {
    out.push({
      key: 'capacity:ready',
      kind: 'bottleneck',
      severity: 'warn',
      text: `${c.ready} issues are ready to start with no free agent on the floor.`,
      evidence: `team ${c.team}, all busy; ${c.inQa} in QA, ${c.toMerge} to merge`,
      action: 'Consider growing the team, or reprioritising the backlog.',
      reportAfterMs: BOTTLENECK_HOLD_MS,
    });
  }
  return out;
}

export interface Incident {
  id: string;
  repoId: string;
  kind: IncidentKind;
  key: string;
  severity: 'info' | 'warn' | 'bad';
  text: string;
  evidence: string;
  action: string;
  since: number;
  lastSeen: number;
  reportAfterMs: number;
  reportedAt: number | null;
}

export const incidentId = (repoId: string, s: Pick<ManagerSignal, 'kind' | 'key'>) => `${repoId}:${s.kind}:${s.key}`;

export interface ReconcileResult {
  incidents: Incident[];
  /** Reportable now and not reported before: send one report each. */
  raised: Incident[];
  /** Were unresolved and are gone now: send one recovery each. */
  recovered: Incident[];
  /** ids of resolved entries, for continuity compaction. */
  resolved: string[];
}

/**
 * Fold this tick's signals into the floor's incident list: keep `since` across ticks, mark newly-reportable ones, and
 * surface ones that have gone as recoveries (reported once).
 */
export function reconcile(repoId: string, prev: readonly Incident[], signals: readonly ManagerSignal[], now: number): ReconcileResult {
  const before = new Map(prev.map((i) => [i.id, i] as const));
  const next: Incident[] = [];
  const raised: Incident[] = [];
  for (const s of signals) {
    const id = incidentId(repoId, s);
    const old = before.get(id);
    const incident: Incident = {
      id,
      repoId,
      kind: s.kind,
      key: s.key,
      severity: s.severity,
      text: s.text.slice(0, 300),
      evidence: s.evidence.slice(0, REPORT_EVIDENCE_MAX),
      action: s.action.slice(0, 300),
      since: old?.since ?? now,
      lastSeen: now,
      reportAfterMs: s.reportAfterMs ?? 0,
      reportedAt: old?.reportedAt ?? null,
    };
    next.push(incident);
    if (incident.reportedAt == null && now - incident.since >= incident.reportAfterMs) raised.push(incident);
  }
  const recovered: Incident[] = [];
  const ids = new Set(next.map((i) => i.id));
  for (const i of prev) if (!ids.has(i.id) && i.reportedAt != null) recovered.push(i);
  return { incidents: next, raised, recovered, resolved: recovered.map((i) => i.id) };
}

// ---------- reports ----------

export interface ReportDraft {
  kind: 'incident' | 'recovery' | 'completion' | 'bottleneck' | 'decision' | 'hourly';
  severity: 'info' | 'warn' | 'bad';
  text: string;
  evidence: string;
  action: string;
}

export function incidentReport(i: Incident): ReportDraft {
  return { kind: i.kind === 'bottleneck' ? 'bottleneck' : i.kind === 'decision' ? 'decision' : 'incident', severity: i.severity, text: i.text, evidence: i.evidence, action: i.action };
}

export function recoveryReport(i: Incident, now: number): ReportDraft {
  return {
    kind: 'recovery',
    severity: 'info',
    text: `Recovered: ${i.text}`,
    evidence: `open ${mins(now - i.since)} · ${i.evidence}`,
    action: '',
  };
}

/** The hourly summary, sent even when the floor is quiet; unavailable data is marked, not invented. */
export function hourlyReport(input: SnapshotInput, incidents: readonly Incident[], opts: { now: number; missedChecks: number; downtimeMs: number | null }): ReportDraft {
  const c = input.capacity;
  const parts = [
    `Hourly: floor ${input.floor} ${input.fullName}`,
    `${c.team} agents (${c.free} free, ${c.busy} busy${c.errors ? `, ${c.errors} in error` : ''})`,
    `${c.ready} ready / ${c.blocked} blocked issues, ${c.building} building, ${c.inQa} in QA, ${c.fixing} fixing, ${c.toMerge} to merge`,
    `merged this hour ${c.mergesHour}`,
  ];
  const ongoing = incidents.filter((i) => i.reportedAt != null).length;
  const quiet = incidents.length === 0 ? 'no unresolved incidents' : `${incidents.length} unresolved incident${incidents.length === 1 ? '' : 's'} (${ongoing} already reported)`;
  const holds = input.holds.usage === 'normal' ? '' : `holds: Claude usage ${input.holds.usage}`;
  const notes: string[] = [];
  if (opts.missedChecks > 1) notes.push(`the office was not checking for a while (${opts.missedChecks} intervals missed; one catch-up ran)`);
  if (opts.downtimeMs) notes.push(`office downtime ~${mins(opts.downtimeMs)}`);
  const unknown = input.holds.sessionLimit && !input.holds.sessionsRunning ? 'running sessions unknown' : '';
  return {
    kind: 'hourly',
    severity: 'info',
    text: [parts.join(' · '), quiet, holds, unknown, ...notes].filter(Boolean).join(' · '),
    evidence: `snapshot at ${new Date(opts.now).toISOString()}`,
    action: '',
  };
}

// ---------- agenda ----------

export interface AgendaItem {
  id: string;
  text: string;
  dueAt: number | null;
  createdAt: number;
  createdBy: 'ceo' | 'manager';
  doneAt: number | null;
}

export function openAgenda(items: readonly AgendaItem[]): AgendaItem[] {
  return items.filter((i) => i.doneAt == null).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
}

/** Agenda items due now, or carried into the next hourly review (no dueAt). */
export function dueAgenda(items: readonly AgendaItem[], now: number): AgendaItem[] {
  return openAgenda(items).filter((i) => i.dueAt == null || i.dueAt <= now);
}

export function compactAgenda(items: readonly AgendaItem[], max = AGENDA_MAX): AgendaItem[] {
  const open = openAgenda(items);
  const done = items.filter((i) => i.doneAt != null).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 10);
  return [...open.slice(0, max), ...done];
}

export function clearAgenda(items: readonly AgendaItem[], id: string, now: number): AgendaItem[] {
  return items.map((i) => (i.id === id ? { ...i, doneAt: now } : i));
}

// ---------- health ----------

export function healthFrom(incidents: readonly Incident[], o: { enabled: boolean; running: boolean; failure: string | null; deferred: boolean; recoveredUntil: number | null; now: number }): { health: 'healthy' | 'quiet' | 'stalled' | 'recovered' | 'deferred' | 'failed' | 'disabled'; detail: string | null } {
  if (!o.enabled) return { health: 'disabled', detail: null };
  if (o.failure) return { health: 'failed', detail: o.failure };
  if (o.deferred) return { health: 'deferred', detail: 'checks deferred while the office is busy, limited or draining' };
  const active = incidents.filter((i) => i.reportedAt != null);
  if (active.length) return { health: 'stalled', detail: active[0].text };
  if (o.recoveredUntil != null && o.now < o.recoveredUntil) return { health: 'recovered', detail: 'an incident just cleared' };
  return { health: 'healthy', detail: null };
}

// ---------- prompts ----------

export function managerSystemPrompt(o: { name: string; repo: string; floor: number; continuityPath: string }): string {
  return [
    `You are ${o.name}, the floor manager for floor ${o.floor} (${o.repo}) in the cubefarm office. You supervise the interchangeable builder agents on this one floor; you never write code, edit the repository, run shell commands, create work, change staffing, or approve/merge QA.`,
    'You are woken fresh for each check: you have no memory of earlier checks. Everything you remember must come from your continuity file, which you read with mcp__office__read_continuity and update with mcp__office__update_continuity. Do not resume or replay any earlier conversation.',
    `The office collects a bounded snapshot of the floor for you; you may also ask for narrow extra evidence once via a short follow-up, but do not explore the repository.`,
    'Each check: read the continuity, assess the snapshot against it, and report ONLY material events with mcp__office__send_report — a new or recovered stall or error, blocked QA/checks/merge, a meaningful completion, a sustained capacity bottleneck, or a decision that needs the CEO. Do not report routine all-clears; the office reports the hourly summary itself.',
    `Keep continuity compact and meaningful: add only new facts, unresolved blockers, decisions and follow-ups, and resolve entries by id once they are obsolete. Never write "nothing changed". Your continuity file is ${o.continuityPath}.`,
    'End your turn with one short sentence: your honest assessment of the floor (or "no material change"). Never claim more than the snapshot shows; mark missing telemetry as unknown.',
  ].join('\n');
}

export interface CheckPromptInput {
  snapshot: string;
  continuity: string;
  signals: readonly ManagerSignal[];
  hourly: boolean;
  missedChecks: number;
  agenda: readonly { text: string; dueAt: number | null }[];
  now: number;
}

export function managerCheckPrompt(i: CheckPromptInput): string {
  const lines = [
    i.hourly ? `It is time for the hourly summary for this floor.` : `Five-minute floor check.`,
    '',
    'Continuity (read it, then update it if something meaningful changed):',
    '```',
    i.continuity.trim() || '(empty: nothing recorded yet)',
    '```',
    '',
    'Snapshot:',
    '```',
    i.snapshot,
    '```',
  ];
  if (i.signals.length) {
    lines.push('', 'The office also detected, by its own thresholds:');
    for (const s of i.signals) lines.push(`- [${s.kind}] ${s.text}`);
  }
  if (i.missedChecks > 1) lines.push('', `Note: ${i.missedChecks} five-minute intervals were missed (the office was not running); this is one catch-up, not all of them.`);
  if (i.agenda.length) {
    lines.push('', 'Agenda items due for consideration now:');
    for (const a of i.agenda) lines.push(`- ${a.text}${a.dueAt != null ? ` (due ${new Date(a.dueAt).toISOString()})` : ''}`);
  }
  lines.push('', 'Call send_report for each material event only, update_continuity for anything new or now resolved, then give your one-sentence assessment.');
  return lines.join('\n');
}

// ---------- setup ----------

/** Resolve the CLI/model/effort a floor manager's checks run with: office defaults, effort low unless overridden. */
export function managerSetup(m: { cli: AgentCli | ''; model: string; effort: EffortLevel | '' }, office: { cli: AgentCli; model: string; effort: EffortLevel }): { cli: AgentCli; model: string; effort: EffortLevel } {
  const cli = m.cli || office.cli;
  return {
    cli,
    model: m.model || (cli === office.cli ? office.model : ''),
    effort: m.effort || DEFAULT_CHECK_EFFORT,
  };
}
