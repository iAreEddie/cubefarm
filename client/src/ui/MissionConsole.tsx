import { useEffect } from 'react';
import { api } from '../api';
import { fmtDuration, fmtPct, fmtUsd, usageMeter } from '../ops';
import { useStore } from '../store';
import type { BudgetView, DoctorFinding, DoctorFix, OpsAlarm, OpsCostView, OpsNumbers, RepoView } from '../../../shared/types';
import { confirmDialog } from './Confirm';

// The manager's console → Mission control: Claude's usage with "Resume full speed", what needs you (the alarms the
// lobby wall's beacon rings for), the office doctor's findings with their one-click fixes, and every floor's numbers
// from the wall as a table.

async function attempt<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch {
    return undefined; // api() already toasted the error
  }
}

/** "Resume full speed": asks first, then clears pacing. From the console's button and E on the lobby's usage meter. */
export async function confirmResume() {
  const { usage, settings } = useStore.getState();
  if (usage.state !== 'pacing') return;
  if (document.pointerLockElement) document.exitPointerLock();
  const m = usageMeter(usage, Date.now());
  const ok = await confirmDialog({
    icon: '⏩',
    tone: 'warn',
    title: 'Resume full speed?',
    body: (
      <>
        <p>
          Claude warned that usage is getting high{usage.warning ? ` (${m.limit})` : ''}, so until {m.resets} new issues only start while fewer than {settings.pacingSessions} session{settings.pacingSessions === 1 ? '' : 's'} run.
        </p>
        <p>Resume if you've topped up or your usage was reset. If Claude still turns a session away at the limit, the office pauses until it resets.</p>
      </>
    ),
    confirm: 'Resume full speed',
  });
  if (ok) await attempt(() => api.resumeFullSpeed());
}

function UsageCard({ hot }: { hot: boolean }) {
  const usage = useStore((s) => s.usage);
  const sessions = useStore((s) => s.settings.pacingSessions);
  const demo = useStore((s) => s.demo);
  const m = usageMeter(usage, Date.now());
  const why =
    usage.state === 'pacing'
      ? `Until ${m.resets}, new issues only start while fewer than ${sessions} session${sessions === 1 ? '' : 's'} run; QA, fixes and the CEO carry on. Topped up, or was your usage reset? Resume full speed.`
      : usage.state === 'paused'
        ? `Claude turned a session away at the limit, so nothing new starts until ${m.resets}. That can't be cleared early; sessions already running carry on.`
        : 'New work starts at full speed. When Claude warns that usage is getting high, the office paces itself (Settings → Sessions while pacing).';
  return (
    <div id="ops-card-usage" className={`card usage-card usage-${m.tone} ${hot ? 'ops-card-hot' : ''}`}>
      <div className="row wrap">
        <b>🤖 Claude usage</b>
        <span className={`pill usage-pill-${m.tone}`}>{m.state}</span>
        <span className="spacer" />
        <button
          className="btn btn-small btn-good"
          disabled={usage.state !== 'pacing'}
          title={usage.state === 'paused' ? "A pause at the limit can't be cleared early" : usage.state === 'normal' ? 'Already at full speed' : 'Stop pacing new issues now'}
          onClick={() => void confirmResume()}
        >
          ⏩ Resume full speed
        </button>
      </div>
      <div className="usage-gauge" role="meter" aria-label="Claude usage at the last warning" aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.pct ?? 0}>
        <div style={{ width: `${Math.min(100, m.pct ?? 0)}%`, background: (m.pct ?? 0) >= 90 ? 'var(--bad)' : (m.pct ?? 0) >= 75 ? 'var(--warn)' : 'var(--good)' }} />
      </div>
      <div className="small">
        <b>{m.limit}</b>
        {m.resets && ` · resets ${m.resets}`}
      </div>
      <div className="muted small">{why}</div>
      {demo && (
        <div className="row wrap">
          <span className="muted small">Demo:</span>
          <button className="btn btn-small btn-ghost" onClick={() => void attempt(() => api.simulateUsage('warning'))}>
            Simulate a usage warning
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => void attempt(() => api.simulateUsage('limit'))}>
            Simulate reaching the limit
          </button>
        </div>
      )}
    </div>
  );
}

function AlarmCard({ alarm, repo, hot }: { alarm: OpsAlarm; repo: RepoView | undefined; hot: boolean }) {
  const openOverlay = useStore((s) => s.openOverlay);
  const goToFloor = useStore((s) => s.goToFloor);
  const pr = alarm.prNumber !== null ? repo?.pulls.find((p) => p.number === alarm.prNumber) : undefined;
  return (
    <div id={`ops-card-${alarm.id}`} className={`card floor-card alarm-card ${hot ? 'ops-card-hot' : ''}`} style={{ ['--accent' as string]: repo?.color ?? '#ef476f' }}>
      <div className="row">
        <span className="floor-badge">{alarm.floor}</span>
        <div className="grow">
          <b>🚨 {alarm.text}</b>
          <div className="muted small">
            {repo?.fullName ?? alarm.repoId}
            {pr ? ` · ${pr.title}` : ''} · since {new Date(alarm.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
      <div className="row wrap">
        {alarm.kind === 'pr' && alarm.prNumber !== null ? (
          <>
            <button className="btn btn-small" onClick={() => openOverlay({ kind: 'kanban', repoId: alarm.repoId })}>
              📋 Open the Kanban
            </button>
            <button className="btn btn-small btn-good" onClick={() => void attempt(() => api.sendToQa(alarm.repoId, alarm.prNumber!))}>
              Retry QA
            </button>
            <button className="btn btn-small" title="Hand it to its author, or any free agent, with QA's findings" onClick={() => void attempt(() => api.sendBack(alarm.repoId, alarm.prNumber!))}>
              Send back for a fix
            </button>
            {pr && (
              <a className="small" href={pr.url} target="_blank" rel="noreferrer">
                PR on GitHub ↗
              </a>
            )}
          </>
        ) : (
          alarm.agentId && (
            <>
              <button className="btn btn-small" onClick={() => openOverlay({ kind: 'terminal', agentId: alarm.agentId! })}>
                Terminal
              </button>
              <button className="btn btn-small btn-good" title="Clear their desk so they take new work" onClick={() => void attempt(() => api.reset(alarm.agentId!))}>
                Clear desk
              </button>
            </>
          )
        )}
        <span className="spacer" />
        <button className="btn btn-small btn-ghost" onClick={() => goToFloor(alarm.floor)}>
          Visit floor {alarm.floor}
        </button>
      </div>
    </div>
  );
}

const FIXES: Record<DoctorFix, [string, string]> = {
  clear: ['↺ Clear desk', 'Clear their desk so they take new work'],
  stop: ['■ Stop', 'Stop their session'],
  requeue: ['↩ Requeue', 'Stop them and put the work back in line, without a strike'],
  'retry-qa': ['Retry QA', 'Queue the PR for a fresh QA run'],
  'send-back': ['Send back for a fix', 'Hand the PR to its author, or any free agent'],
  'close-issue': ['Close issue', 'Close the issue on GitHub as completed'],
};

async function applyFix(f: DoctorFinding, fix: DoctorFix) {
  if (fix === 'close-issue') {
    if (document.pointerLockElement) document.exitPointerLock();
    const ok = await confirmDialog({
      icon: '🩺',
      tone: 'warn',
      title: `Close issue #${f.issueNumber}?`,
      body: <p>It's closed on GitHub as completed, with a comment saying PR #{f.prNumber} resolved it.</p>,
      confirm: 'Close issue',
    });
    if (!ok) return;
  }
  await attempt(() => api.doctorFix(f.id, fix));
}

function DoctorCard({ finding: f, repo }: { finding: DoctorFinding; repo: RepoView | undefined }) {
  const openOverlay = useStore((s) => s.openOverlay);
  return (
    <div id={`ops-card-doctor-${f.id}`} className="card floor-card alarm-card doctor-card" style={{ ['--accent' as string]: repo?.color ?? '#7c6cf0' }}>
      <div className="row">
        <span className="floor-badge">{repo?.floor ?? '?'}</span>
        <div className="grow">
          <b>🩺 {f.text}</b>
          <div className="muted small">
            {repo?.fullName ?? f.repoId} · since {new Date(f.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
      <div className="row wrap">
        {f.fixes.map((fix, i) => (
          <button key={fix} className={`btn btn-small ${i === 0 ? 'btn-good' : ''}`} title={FIXES[fix][1]} onClick={() => void applyFix(f, fix)}>
            {FIXES[fix][0]}
          </button>
        ))}
        {f.agentId && (
          <button className="btn btn-small" onClick={() => openOverlay({ kind: 'terminal', agentId: f.agentId! })}>
            Terminal
          </button>
        )}
        <span className="spacer" />
        <button className="btn btn-small btn-ghost" title="Hide it until it goes away" onClick={() => void attempt(() => api.doctorIgnore(f.id))}>
          Ignore
        </button>
      </div>
    </div>
  );
}

async function demoDoctor(action: Parameters<typeof api.demoDoctor>[0]) {
  const r = await attempt(() => api.demoDoctor(action));
  if (r) useStore.getState().pushToast('info', r.text);
}

function DoctorSection({ hot }: { hot: boolean }) {
  const doctor = useStore((s) => s.doctor);
  const repos = useStore((s) => s.repos);
  const demo = useStore((s) => s.demo);
  return (
    <div id="ops-card-doctor" className={hot ? 'ops-card-hot' : ''}>
      <h3 className="section">🩺 Office doctor {doctor.length > 0 && <span className="badge">{doctor.length}</span>}</h3>
      {doctor.length === 0 && (
        <p className="muted small">Nothing stuck. Every minute the watchdog nudges quiet sessions, frees stuck desks and puts orphaned work back in line by itself; what it can't safely fix shows up here.</p>
      )}
      {doctor.map((f) => (
        <DoctorCard key={f.id} finding={f} repo={repos.find((r) => r.id === f.repoId)} />
      ))}
      {demo && (
        <div className="row wrap">
          <span className="muted small">Demo:</span>
          <button className="btn btn-small btn-ghost" title="Restart with desks gone and work finished on GitHub meanwhile" onClick={() => void demoDoctor('restart')}>
            Simulate a restart
          </button>
          <button className="btn btn-small btn-ghost" title="Someone's session goes quiet for 20 minutes" onClick={() => void demoDoctor('stuck')}>
            Make a session stuck
          </button>
          <button className="btn btn-small btn-ghost" title="Ten more minutes pass for the stuck sessions" onClick={() => void demoDoctor('later')}>
            10 minutes later
          </button>
          <button className="btn btn-small btn-ghost" title="A merged PR whose issue was never closed" onClick={() => void demoDoctor('unclosed')}>
            Leave an issue open
          </button>
        </div>
      )}
    </div>
  );
}

/** A floor's budget: its cap, the spend its agents reported, and the 80%/100% state (#7). */
export function BudgetChip({ budget }: { budget: BudgetView }) {
  if (budget.budgetUsd <= 0) return <span className="muted small">No budget</span>;
  if (budget.spentUsd === null) {
    return (
      <span className="muted small" title="No session on this floor has reported a cost, so spend is not reported — never a zero, and it never blocks the floor on its own.">
        not reported / {fmtUsd(budget.budgetUsd)}
      </span>
    );
  }
  const tone = budget.level === 'over' ? 'bad' : budget.level === 'warning' ? 'warn' : 'good';
  return (
    <span className={`budget-chip budget-${tone}`} title={`${fmtUsd(budget.spentUsd)} of ${fmtUsd(budget.budgetUsd)} reported from ${budget.sessions} session${budget.sessions === 1 ? '' : 's'}`}>
      {budget.level === 'over' ? '🛑' : budget.level === 'warning' ? '⚠️' : '💵'} {fmtUsd(budget.spentUsd)} / {fmtUsd(budget.budgetUsd)}
      {budget.pct !== null && ` · ${budget.pct}%`}
    </span>
  );
}

const COLUMNS: [string, (n: OpsNumbers) => string, string?][] = [
  ['Ready', (n) => String(n.ready), 'Backlog issues that can start now'],
  ['Building', (n) => String(n.building)],
  ['In QA', (n) => String(n.inQa)],
  ['Fixing', (n) => String(n.fixing), 'Back with an agent: QA findings, checks or a conflict'],
  ['To merge', (n) => String(n.toMerge)],
  ['Needs you', (n) => `${n.needsYou}${n.triage ? ` (+${n.triage} 🧭)` : ''}`, '🧭: the CEO is looking first'],
  ['Merged today', (n) => `${n.mergedToday} (${n.mergedHour} last hour)`],
  ['Lead time', (n) => fmtDuration(n.leadMs), 'Median issue → merge over the last 24 hours'],
  ['QA wait', (n) => fmtDuration(n.qaWaitMs), 'Median wait for a free agent over the last 24 hours'],
  ['CI', (n) => (n.ciRuns ? `${fmtPct(n.ciPass)} · ${fmtDuration(n.ciMs)}` : '—'), "GitHub's checks over 7 days: pass rate · median time"],
  ['Team', (n) => `${n.busy} busy · ${n.idle} idle${n.errors ? ` · ${n.errors} error` : ''}`],
];

/** The provenance label a cost breakdown shows: reported, estimated, a mix, free, or unavailable. */
const costKindLabel = (kind: OpsCostView['kind']) => kind.replace('mixed', 'reported + estimated').replace('none', 'no data');

/** The office's cost detail (#15): the breakdown, coverage, and the last 24 hours by model. */
function CostDetail({ cost }: { cost: OpsCostView }) {
  const hours = cost.elapsedHours >= 23.5 ? 'last 24h' : `last ${Math.max(1, Math.round(cost.elapsedHours))}h`;
  return (
    <div className="muted small">
      <div>
        Cost ({hours}): <b>~{fmtUsd(cost.totalUsd)}</b> · {costKindLabel(cost.kind)}
        {cost.reportedUsd > 0 && ` · reported ${fmtUsd(cost.reportedUsd)}`}
        {cost.estimatedUsd > 0 && ` · estimated ${fmtUsd(cost.estimatedUsd)}`}
        {cost.unavailable > 0 && ` · ${cost.unavailable} unavailable`}
        {cost.partialHistory && ` · partial history (${Math.max(1, Math.round(cost.elapsedHours))}h)`}
      </div>
      {cost.byModel.length > 0 && (
        <table className="ops-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Model</th>
              <th>$ / hour</th>
              <th>tokens / hour</th>
              <th>source</th>
            </tr>
          </thead>
          <tbody>
            {cost.byModel.map((m) => (
              <tr key={m.model}>
                <td>{m.model}</td>
                <td>{m.usdPerHour === null ? '—' : `$${m.usdPerHour.toFixed(2)}`}</td>
                <td>{m.tokensPerHour === null ? '—' : `${Math.round(m.tokensPerHour).toLocaleString()}`}</td>
                <td>{costKindLabel(m.kind)}{m.unavailable ? ` · ${m.unavailable} unavailable` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OpsTable() {
  const ops = useStore((s) => s.ops);
  const repos = useStore((s) => s.repos);
  const rows: [string, string, OpsNumbers, BudgetView | null, OpsCostView | undefined][] = [
    ...ops.floors.map((f): [string, string, OpsNumbers, BudgetView | null, OpsCostView | undefined] => {
      const r = repos.find((x) => x.id === f.repoId);
      return [`${f.floor} · ${r?.fullName.split('/')[1] ?? f.repoId}`, r?.color ?? '#ccc', f, r?.budget ?? null, f.cost];
    }),
    ['All floors', '#1f1d2b', ops.total, null, ops.cost],
  ];
  return (
    <div className="ops-table-wrap">
      <table className="ops-table">
        <thead>
          <tr>
            <th />
            {rows.map(([name, color]) => (
              <th key={name} style={{ ['--accent' as string]: color }} className="ops-col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COLUMNS.map(([label, value, tip]) => (
            <tr key={label}>
              <th title={tip}>{label}</th>
              {rows.map(([name, , n]) => (
                <td key={name}>{value(n)}</td>
              ))}
            </tr>
          ))}
          <tr>
            <th title="Last 24 hours of measured usage: reported spend preferred, otherwise estimated from tokens and a verified rate. Unavailable means the CLI reported no measurable usage.">Cost (24h)</th>
            {rows.map(([name, , , , c]) => (
              <td key={name}>{c && c.kind !== 'none' ? `~${fmtUsd(c.totalUsd)} · ${costKindLabel(c.kind)}${c.partial ? ' *' : ''}` : <span className="muted">—</span>}</td>
            ))}
          </tr>
          <tr>
            <th title="The manager's cap on this floor's reported spend; not reported: no session has reported a cost, so it never blocks the floor on its own">Budget</th>
            {rows.map(([name, , , b]) => (
              <td key={name}>{b ? <BudgetChip budget={b} /> : <span className="muted">—</span>}</td>
            ))}
          </tr>
        </tbody>
      </table>
      {ops.cost && <CostDetail cost={ops.cost} />}
      {ops.ceoCostToday > 0 && <div className="muted small">The CEO's sessions today: ~{fmtUsd(ops.ceoCostToday)} (in All floors' cost).</div>}
    </div>
  );
}

export function OpsTab({ card }: { card?: string }) {
  const alarms = useStore((s) => s.ops.alarms);
  const repos = useStore((s) => s.repos);
  useEffect(() => {
    if (card) document.getElementById(`ops-card-${card}`)?.scrollIntoView({ block: 'center' });
  }, [card]);
  return (
    <div className="tab-grid">
      <div>
        <UsageCard hot={card === 'usage'} />
        <h3 className="section">🚨 Needs you {alarms.length > 0 && <span className="badge">{alarms.length}</span>}</h3>
        {alarms.length === 0 && <p className="muted small">All clear. The beacon on the lobby's mission control wall spins when a PR needs you or an agent has been stuck on an error for 10 minutes.</p>}
        {alarms.map((a) => (
          <AlarmCard key={a.id} alarm={a} repo={repos.find((r) => r.id === a.repoId)} hot={a.id === card} />
        ))}
        <DoctorSection hot={card === 'doctor'} />
      </div>
      <div>
        <h3 className="section">🛰️ The numbers</h3>
        <OpsTable />
      </div>
    </div>
  );
}
