// Upstream drift (#14): a daily check of whether the original project this fork was made from has commits our fork's
// default branch lacks. The monitor owns the cadence (at most once every 24 hours while the office runs, remembered
// across restarts) and reports a newly observed upstream head once, through the manager's phone notifications.
//
// It never changes the running checkout: comparisons happen in an isolated bare mirror under <SWARM_HOME>/upstream,
// and use commit ancestry (rev-list over fetched refs), not version strings. This is separate from the office's own
// self-update (officeUpdate.ts, scripts/office.mjs), which follows origin's default branch and fast-forwards it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME_DIR } from './config.ts';
import { gh, git } from './exec.ts';
import { HttpError } from './httpError.ts';
import type { UpstreamSettings, UpstreamState, UpstreamView } from '../shared/types.ts';

/** Check at most this often while the office runs. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** After a failed check, try again this soon (bounded: see MAX_RETRIES). */
export const RETRY_MS = 30 * 60_000;
/** Failures in a row after which retries fall back to the daily cadence, so a long outage can't hammer GitHub. */
export const MAX_RETRIES = 3;
/** How often the monitor looks at the clock (the check itself only runs when due). */
export const UPSTREAM_TICK_MS = 5 * 60_000;
/** The demo ticks faster, so its scenarios are visible without waiting. */
export const DEMO_UPSTREAM_TICK_MS = 30_000;

export const DEFAULT_UPSTREAM: UpstreamSettings = { enabled: true, repo: 'leonvanzyl/cubefarm', branch: '' };

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const BRANCH_MAX = 200;
const oneLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0].slice(0, 200);

/** Upstream settings from a saved state or a PATCH /api/settings; a bad repo or branch is refused. */
export function upstreamSettings(base: UpstreamSettings, patch: unknown): UpstreamSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as { enabled?: unknown; repo?: unknown; branch?: unknown };
  let repo = base.repo;
  if (p.repo !== undefined) {
    if (typeof p.repo !== 'string' || !REPO_RE.test(p.repo.trim())) throw new HttpError(400, 'The upstream repository must be owner/name, e.g. leonvanzyl/cubefarm.');
    repo = p.repo.trim();
  }
  let branch = base.branch;
  if (p.branch !== undefined) {
    if (typeof p.branch !== 'string' || p.branch.trim().length > BRANCH_MAX) throw new HttpError(400, 'The upstream branch must be a short branch name.');
    branch = p.branch.trim();
  }
  return { enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled, repo, branch };
}

/** The classification of a comparison, from commit counts. */
export function compareState(missing: number, ahead: number): 'current' | 'updates' | 'diverged' {
  if (missing <= 0) return 'current'; // our fork may be ahead on its own: still "current" upstream
  return ahead > 0 ? 'diverged' : 'updates';
}

/** Whether this result should alert: upstream has commits we lack, at a head we haven't reported yet. */
export function alertFor(state: 'current' | 'updates' | 'diverged', missing: number, upstreamHead: string, lastAlertedHead: string | null): boolean {
  return state !== 'current' && missing > 0 && upstreamHead !== lastAlertedHead;
}

/** The one-line phone note for an upstream result, before the notifier adds its event icon. */
export function upstreamMessage(v: UpstreamView): { title: string; body: string; line: string } {
  const commits = `${v.missing} new commit${v.missing === 1 ? '' : 's'}`;
  const diverged = v.state === 'diverged' ? ` (this fork also has ${v.ahead} of its own)` : '';
  const where = v.resolvedBranch && v.resolvedBranch !== 'main' ? `${v.repo} (${v.resolvedBranch})` : v.repo;
  const title = `Upstream ${where}: ${commits}${diverged}`;
  const changes = v.summary.slice(0, 3).map((s) => `• ${s}`).join(' ');
  const body = [`${commits} on ${where} aren't in this fork yet${diverged}.`, changes, v.compareUrl ? `Compare: ${v.compareUrl}` : '', 'Integration can be requested as a reviewed PR.']
    .filter(Boolean)
    .join(' ');
  return { title, body, line: `${where}: ${commits} upstream${diverged}` };
}

// ---------- what a check found (the host's raw facts) ----------

export interface UpstreamFacts {
  upstreamBranch: string; // the branch compared, after resolving '' to the upstream default
  upstreamHead: string; // full sha
  forkBranch: string; // our fork's default branch
  forkHead: string; // full sha
  missing: number; // commits upstream has that our fork lacks
  ahead: number; // commits our fork has that upstream lacks
  summary: string[]; // subjects of the missing commits, newest first
  compareUrl: string; // GitHub's cross-fork comparison link
}

/** Where the office's fork and the upstream stand right now. The real one fetches; the demo fakes all of it. Throws on failure. */
export interface UpstreamHost {
  inspect(cfg: { repo: string; branch: string }): Promise<UpstreamFacts>;
}

// ---------- persisted cadence ----------

export interface UpstreamResult extends UpstreamFacts {
  state: 'current' | 'updates' | 'diverged';
}

export interface UpstreamPersisted {
  lastAttemptAt: number | null;
  lastCheckAt: number | null; // last successful check
  failures: number; // failures in a row
  failure: string | null; // why the last attempt failed (cleared on success)
  lastAlertedHead: string | null; // the upstream head the manager was last told about
  result: UpstreamResult | null; // the last successful result, kept through failures
}

export const emptyUpstream = (): UpstreamPersisted => ({ lastAttemptAt: null, lastCheckAt: null, failures: 0, failure: null, lastAlertedHead: null, result: null });

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function loadResult(raw: unknown): UpstreamResult | null {
  const r = raw && typeof raw === 'object' ? (raw as Partial<UpstreamResult>) : null;
  if (!r || typeof r.upstreamHead !== 'string' || typeof r.upstreamBranch !== 'string' || typeof r.forkHead !== 'string' || typeof r.forkBranch !== 'string') return null;
  const state = r.state === 'updates' || r.state === 'diverged' || r.state === 'current' ? r.state : compareState(Number(r.missing) || 0, Number(r.ahead) || 0);
  return {
    state,
    upstreamBranch: r.upstreamBranch,
    upstreamHead: r.upstreamHead,
    forkBranch: r.forkBranch,
    forkHead: r.forkHead,
    missing: Math.max(0, Math.round(Number(r.missing) || 0)),
    ahead: Math.max(0, Math.round(Number(r.ahead) || 0)),
    summary: Array.isArray(r.summary) ? r.summary.filter((s): s is string => typeof s === 'string').slice(0, 5) : [],
    compareUrl: typeof r.compareUrl === 'string' ? r.compareUrl : '',
  };
}

/** Upstream cadence from a saved state (server/swarm.ts's Persisted). */
export function loadUpstream(raw: unknown): UpstreamPersisted {
  const r = raw && typeof raw === 'object' ? (raw as Partial<UpstreamPersisted>) : {};
  return {
    lastAttemptAt: num(r.lastAttemptAt),
    lastCheckAt: num(r.lastCheckAt),
    failures: typeof r.failures === 'number' && r.failures > 0 ? Math.round(r.failures) : 0,
    failure: typeof r.failure === 'string' && r.failure ? r.failure : null,
    lastAlertedHead: typeof r.lastAlertedHead === 'string' && r.lastAlertedHead ? r.lastAlertedHead : null,
    result: loadResult(r.result),
  };
}

/** Is a check due now? Once a day after a success; sooner after a failure, until MAX_RETRIES then daily again. */
export function dueForCheck(s: UpstreamPersisted, enabled: boolean, now: number): boolean {
  if (!enabled) return false;
  if (s.lastAttemptAt === null) return true;
  const wait = s.failure ? (s.failures >= MAX_RETRIES ? CHECK_INTERVAL_MS : RETRY_MS) : CHECK_INTERVAL_MS;
  return now - s.lastAttemptAt >= wait;
}

// ---------- the monitor ----------

export interface UpstreamDeps {
  host: UpstreamHost;
  settings(): UpstreamSettings;
  /** A new upstream head with commits we lack: report it (the notifier's 'upstream' event). */
  notify(view: UpstreamView): void;
  /** The view changed: fold it into the tabs. */
  changed(view: UpstreamView): void;
  save(): void;
  log?(line: string): void;
  now?(): number;
  tickMs?: number;
}

/**
 * The daily upstream check's clock and state. It owns the persisted cadence (last attempt, last success, the observed
 * head it told the manager about and the last good result) and never touches the running checkout.
 */
export class UpstreamMonitor {
  private s: UpstreamPersisted = emptyUpstream();
  private checking = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: UpstreamDeps) {}

  restore(raw: unknown) {
    this.s = loadUpstream(raw);
  }

  /** The state to persist in state.json. */
  serialize(): UpstreamPersisted {
    return this.s;
  }

  /** What the manager sees: the configured source, the status and the last successful result. */
  view(): UpstreamView {
    const cfg = this.deps.settings();
    const r = this.s.result;
    const state: UpstreamState = !cfg.enabled ? 'off' : this.s.failure ? 'failed' : r ? r.state : 'unknown';
    return {
      enabled: cfg.enabled,
      repo: cfg.repo,
      branch: cfg.branch,
      resolvedBranch: r?.upstreamBranch ?? null,
      state,
      missing: r?.missing ?? 0,
      ahead: r?.ahead ?? 0,
      upstreamHead: r?.upstreamHead.slice(0, 7) ?? null,
      forkHead: r?.forkHead.slice(0, 7) ?? null,
      compareUrl: r?.compareUrl ?? null,
      summary: r?.summary ?? [],
      lastAttemptAt: this.s.lastAttemptAt,
      lastCheckAt: this.s.lastCheckAt,
      detail: this.detail(cfg),
    };
  }

  private detail(cfg: UpstreamSettings): string | null {
    if (!cfg.enabled) return 'The daily upstream check is off.';
    if (this.s.failure) {
      const last = this.s.result ? ` The last result (${this.s.result.missing} commit${this.s.result.missing === 1 ? '' : 's'} behind) is from ${new Date(this.s.lastCheckAt ?? 0).toLocaleString()}.` : '';
      return `Check failed: ${this.s.failure}.${last}`;
    }
    if (!this.s.result) return 'Not checked yet.';
    return null;
  }

  /** Start the clock: an overdue office checks once at once, then at most daily. */
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? UPSTREAM_TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Look at the clock; run a check if one is due and none is running. Returns the check (for tests) or undefined. */
  tick(): Promise<UpstreamView> | undefined {
    if (this.checking) return undefined;
    const cfg = this.deps.settings();
    if (!dueForCheck(this.s, cfg.enabled, this.now())) return undefined;
    return this.check('scheduled');
  }

  /**
   * Run one check now. `manual` (the manager's Check now) runs even when the check is switched off. On failure the
   * previous successful result is kept and no notification is sent; the cadence backs off so it can retry later.
   */
  async check(trigger: 'scheduled' | 'manual' = 'manual'): Promise<UpstreamView> {
    if (this.checking) return this.view();
    const cfg = this.deps.settings();
    if (!cfg.enabled && trigger !== 'manual') return this.view();
    this.checking = true;
    const now = this.now();
    this.s.lastAttemptAt = now;
    this.deps.save();
    try {
      const facts = await this.deps.host.inspect({ repo: cfg.repo, branch: cfg.branch });
      const state = compareState(facts.missing, facts.ahead);
      this.s.failure = null;
      this.s.failures = 0;
      this.s.result = { state, ...facts };
      this.s.lastCheckAt = now;
      const view = this.view();
      if (alertFor(state, facts.missing, facts.upstreamHead, this.s.lastAlertedHead)) {
        this.s.lastAlertedHead = facts.upstreamHead;
        this.deps.notify(view);
      }
      this.deps.changed(view);
      return view;
    } catch (err) {
      this.s.failures += 1;
      this.s.failure = oneLine(err);
      this.deps.log?.(`upstream: check of ${cfg.repo} failed: ${this.s.failure}`);
      const view = this.view();
      this.deps.changed(view);
      return view;
    } finally {
      this.checking = false;
      this.deps.save();
    }
  }

  /** The manager changed the source: forget the old comparison and check the new one on the next tick. */
  configChanged(before: UpstreamSettings, after: UpstreamSettings) {
    if (before.repo !== after.repo || before.branch !== after.branch) {
      this.s.lastAttemptAt = null;
      this.s.lastAlertedHead = null;
      this.s.failure = null;
      this.s.failures = 0;
      this.s.result = null;
    }
    this.deps.changed(this.view());
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
}

// ---------- the real host: an isolated mirror; the fork is fetched through the checkout's own origin remote ----------

const OFFICE_DIR = path.resolve(import.meta.dirname, '..');
const MIRROR_DIR = path.join(HOME_DIR, 'upstream');
const slug = (full: string) => full.replace(/[^A-Za-z0-9._-]+/g, '__');

/** GitHub's cross-fork compare: base is our fork's branch, head is the upstream's. */
export function compareUrl(upstream: string, upstreamBranch: string, forkOwner: string, forkBranch: string): string {
  return `https://github.com/${upstream}/compare/${forkOwner}:${forkBranch}...${upstreamBranch}`;
}

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

/** The office's origin remote, if it points at GitHub. Reused so the mirror fetches with the credentials the checkout already uses. */
async function originInfo(): Promise<{ full: string; url: string } | null> {
  const url = await git(['remote', 'get-url', 'origin'], { cwd: OFFICE_DIR }).catch(() => '');
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { full: `${m[1]}/${m[2]}`, url } : null;
}

const defaultBranchOf = (full: string) => gh(['api', `repos/${full}`, '--jq', '.default_branch']).then((s) => s.trim());

export const realUpstream: UpstreamHost = {
  async inspect(cfg) {
    if (!REPO_RE.test(cfg.repo)) throw new Error(`"${cfg.repo}" isn't an owner/name repository`);
    const upstreamBranch = cfg.branch || (await defaultBranchOf(cfg.repo));
    if (!upstreamBranch) throw new Error(`Couldn't read ${cfg.repo}'s default branch`);
    const origin = await originInfo();
    if (!origin) throw new Error(`This office doesn't run from a GitHub checkout, so there's no fork of ${cfg.repo} to compare`);
    const forkBranch = (await defaultBranchOf(origin.full)) || 'main';
    const mirror = path.join(MIRROR_DIR, `${slug(cfg.repo)}.git`);
    if (!(await exists(path.join(mirror, 'HEAD')))) await git(['init', '--bare', mirror]);
    const fetch = (url: string, refspec: string) => git(['-C', mirror, 'fetch', '--no-tags', url, refspec], { timeoutMs: 180_000 });
    await fetch(`https://github.com/${cfg.repo}.git`, `+refs/heads/${upstreamBranch}:refs/upstream/${upstreamBranch}`);
    await fetch(origin.url, `+refs/heads/${forkBranch}:refs/fork/${forkBranch}`);
    const upRef = `refs/upstream/${upstreamBranch}`;
    const forkRef = `refs/fork/${forkBranch}`;
    const upstreamHead = await git(['-C', mirror, 'rev-parse', upRef]);
    const forkHead = await git(['-C', mirror, 'rev-parse', forkRef]);
    const missing = Number(await git(['-C', mirror, 'rev-list', '--count', `${forkRef}..${upRef}`]));
    const ahead = Number(await git(['-C', mirror, 'rev-list', '--count', `${upRef}..${forkRef}`]));
    const summary = missing
      ? (await git(['-C', mirror, 'log', '--format=%s', '-n', '5', `${forkRef}..${upRef}`]))
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return { upstreamBranch, upstreamHead, forkBranch, forkHead, missing, ahead, summary, compareUrl: compareUrl(cfg.repo, upstreamBranch, origin.full.split('/')[0], forkBranch) };
  },
};
