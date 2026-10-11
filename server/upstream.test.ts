import { describe, expect, it, vi } from 'vitest';
import {
  alertFor,
  CHECK_INTERVAL_MS,
  compareState,
  dueForCheck,
  emptyUpstream,
  loadUpstream,
  MAX_RETRIES,
  RETRY_MS,
  upstreamMessage,
  upstreamSettings,
  UpstreamMonitor,
  type UpstreamFacts,
  type UpstreamHost,
} from './upstream.ts';
import type { UpstreamSettings, UpstreamView } from '../shared/types.ts';

const NOW = 1_700_000_000_000;
const SHA_A = `a11ce${'0'.repeat(35)}`;
const SHA_B = `b0b0b${'0'.repeat(35)}`;
const SHA_C = `c0c0c${'0'.repeat(35)}`;
const SHA_D = `d0d0d${'0'.repeat(35)}`;

const facts = (over: Partial<UpstreamFacts> = {}): UpstreamFacts => ({
  upstreamBranch: 'main',
  upstreamHead: SHA_A,
  forkBranch: 'main',
  forkHead: SHA_B,
  missing: 3,
  ahead: 0,
  summary: ['Add drift check', 'Tidy previews', 'Fix a path bug'],
  compareUrl: 'https://github.com/leonvanzyl/cubefarm/compare/iAreEddie:main...main',
  ...over,
});

/** A monitor with a controllable clock, settings and host. */
function harness(host: UpstreamHost, cfg: UpstreamSettings = { enabled: true, repo: 'leonvanzyl/cubefarm', branch: '' }, clock = { t: NOW }) {
  const alerts: UpstreamView[] = [];
  const changes: UpstreamView[] = [];
  const monitor = new UpstreamMonitor({
    host,
    settings: () => cfg,
    now: () => clock.t,
    notify: (v) => alerts.push(v),
    changed: (v) => changes.push(v),
    save: () => undefined,
  });
  monitor.restore(emptyUpstream());
  return { monitor, alerts, changes, cfg, clock };
}

describe('upstreamSettings', () => {
  const base = { enabled: true, repo: 'leonvanzyl/cubefarm', branch: '' };

  it('keeps the base for what the patch omits', () => {
    expect(upstreamSettings(base, {})).toEqual(base);
  });

  it('changes the repo, branch and enabled switch', () => {
    expect(upstreamSettings(base, { repo: 'other/project', branch: 'dev', enabled: false })).toEqual({ enabled: false, repo: 'other/project', branch: 'dev' });
    expect(upstreamSettings(base, { branch: ' release ' })).toEqual({ ...base, branch: 'release' });
  });

  it('refuses a repo that is not owner/name and a too-long branch', () => {
    expect(() => upstreamSettings(base, { repo: 'not a repo' })).toThrow(/owner\/name/);
    expect(() => upstreamSettings(base, { repo: 'owner/' })).toThrow(/owner\/name/);
    expect(() => upstreamSettings(base, { branch: 'x'.repeat(201) })).toThrow(/branch/);
  });
});

describe('the comparison', () => {
  it('classifies current, upstream-ahead and diverged', () => {
    expect(compareState(0, 0)).toBe('current');
    expect(compareState(0, 5)).toBe('current'); // fork-ahead-only is still current upstream
    expect(compareState(3, 0)).toBe('updates');
    expect(compareState(2, 4)).toBe('diverged');
  });

  it('alerts once per upstream head, only when there are commits we lack', () => {
    expect(alertFor('updates', 3, SHA_A, null)).toBe(true);
    expect(alertFor('updates', 3, SHA_A, SHA_A)).toBe(false); // the same head, already reported
    expect(alertFor('diverged', 2, SHA_B, SHA_A)).toBe(true);
    expect(alertFor('current', 0, SHA_A, null)).toBe(false);
  });
});

describe('the cadence', () => {
  it('is due at once, then a day after a success, then a day after that', () => {
    expect(dueForCheck(emptyUpstream(), true, NOW)).toBe(true);
    expect(dueForCheck(emptyUpstream(), false, NOW)).toBe(false); // switched off
    const done = { ...emptyUpstream(), lastAttemptAt: NOW, lastCheckAt: NOW };
    expect(dueForCheck(done, true, NOW + CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(dueForCheck(done, true, NOW + CHECK_INTERVAL_MS)).toBe(true);
  });

  it('retries sooner after a failure, then falls back to daily after a few', () => {
    const failed = { ...emptyUpstream(), lastAttemptAt: NOW, failure: 'network', failures: 1 };
    expect(dueForCheck(failed, true, NOW + RETRY_MS - 1)).toBe(false);
    expect(dueForCheck(failed, true, NOW + RETRY_MS)).toBe(true);
    const many = { ...failed, failures: MAX_RETRIES };
    expect(dueForCheck(many, true, NOW + RETRY_MS)).toBe(false);
    expect(dueForCheck(many, true, NOW + CHECK_INTERVAL_MS)).toBe(true);
  });

  it('checks once when overdue, not again inside the day, and once in a new office after the window', async () => {
    const inspect = vi.fn(async () => facts({ missing: 0, ahead: 0 }));
    const { monitor, clock } = harness({ inspect });
    await monitor.tick(); // overdue: checks once
    expect(inspect).toHaveBeenCalledTimes(1);
    clock.t += 60_000;
    expect(monitor.tick()).toBeUndefined(); // inside the window: nothing due
    expect(inspect).toHaveBeenCalledTimes(1);

    // A restart inside the window: the persisted cadence stops a duplicate check.
    const inspect2 = vi.fn(async () => facts({ missing: 0, ahead: 0 }));
    const restart = harness({ inspect: inspect2 }, undefined, clock);
    restart.monitor.restore(monitor.serialize());
    clock.t = NOW + 60_000;
    await restart.monitor.tick();
    expect(inspect2).toHaveBeenCalledTimes(0);

    // A restart after the window: one catch-up check.
    clock.t = NOW + CHECK_INTERVAL_MS;
    await restart.monitor.tick();
    expect(inspect2).toHaveBeenCalledTimes(1);
  });
});

describe('the monitor', () => {
  it('alerts once per new upstream head with missing commits, not for the same head', async () => {
    const inspect = vi.fn(async () => facts());
    const { monitor, alerts, clock } = harness({ inspect });
    await monitor.check('scheduled');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].missing).toBe(3);
    clock.t += 60_000;
    await monitor.check('scheduled');
    expect(alerts).toHaveLength(1); // repeated checks of the same head don't repeat the alert

    inspect.mockResolvedValue(facts({ upstreamHead: SHA_C }));
    clock.t += 60_000;
    await monitor.check('scheduled');
    expect(alerts).toHaveLength(2);
  });

  it('reports nothing for a fork that is merely ahead, and goes quiet once integrated', async () => {
    const inspect = vi.fn(async () => facts({ missing: 0, ahead: 5 }));
    const { monitor, alerts } = harness({ inspect });
    await monitor.check('scheduled');
    expect(monitor.view().state).toBe('current');
    expect(alerts).toHaveLength(0);

    // Upstream later moves ahead: one alert; then our fork catches up: no more.
    inspect.mockResolvedValue(facts({ upstreamHead: SHA_C }));
    await monitor.check('scheduled');
    expect(alerts).toHaveLength(1);
    inspect.mockResolvedValue(facts({ missing: 0, ahead: 1, upstreamHead: SHA_D }));
    await monitor.check('scheduled');
    expect(monitor.view().state).toBe('current');
    expect(alerts).toHaveLength(1);
  });

  it('keeps the last good result through a failure, sends no alert, then recovers', async () => {
    const inspect = vi.fn(async () => facts());
    const { monitor, alerts } = harness({ inspect });
    await monitor.check('scheduled');
    expect(alerts).toHaveLength(1);

    inspect.mockRejectedValueOnce(new Error('gh: API rate limit exceeded'));
    await monitor.check('scheduled');
    const v = monitor.view();
    expect(v.state).toBe('failed');
    expect(v.missing).toBe(3); // the previous result is preserved
    expect(v.upstreamHead).toBe(SHA_A.slice(0, 7));
    expect(v.detail).toMatch(/rate limit/);
    expect(alerts).toHaveLength(1); // no notification for a failure

    inspect.mockResolvedValue(facts({ upstreamHead: SHA_C }));
    await monitor.check('scheduled');
    expect(monitor.view().state).toBe('updates');
    expect(monitor.view().detail).toBeNull();
    expect(alerts).toHaveLength(2);
  });

  it('re-checks and can alert again when the source configuration changes', async () => {
    const inspect = vi.fn(async () => facts());
    const { monitor, alerts, cfg } = harness({ inspect });
    await monitor.check('scheduled');
    expect(alerts).toHaveLength(1);

    const before = { ...cfg };
    cfg.repo = 'other/project';
    monitor.configChanged(before, { ...cfg });
    expect(monitor.view().state).toBe('unknown');
    expect(dueForCheck(monitor.serialize(), true, NOW)).toBe(true); // the next tick checks the new source
    await monitor.check('scheduled');
    expect(alerts).toHaveLength(2); // a new source with the same head is still a new comparison
  });

  it('shows off when the check is switched off', async () => {
    const cfg: UpstreamSettings = { enabled: false, repo: 'leonvanzyl/cubefarm', branch: '' };
    const { monitor } = harness({ inspect: vi.fn(async () => facts()) }, cfg);
    expect(monitor.view().state).toBe('off');
    expect(dueForCheck(monitor.serialize(), false, NOW)).toBe(false);
  });
});

describe('the phone note', () => {
  it('names the upstream, the count and the comparison link, and says integration is a reviewed PR', () => {
    const v: UpstreamView = {
      enabled: true,
      repo: 'leonvanzyl/cubefarm',
      branch: '',
      resolvedBranch: 'main',
      state: 'updates',
      missing: 3,
      ahead: 0,
      upstreamHead: 'a11ce00',
      forkHead: 'b0b0b00',
      compareUrl: 'https://github.com/leonvanzyl/cubefarm/compare/iAreEddie:main...main',
      summary: ['Add drift check'],
      lastAttemptAt: NOW,
      lastCheckAt: NOW,
      detail: null,
    };
    const m = upstreamMessage(v);
    expect(m.title).toContain('leonvanzyl/cubefarm');
    expect(m.title).toContain('3 new commits');
    expect(m.body).toContain('3 new commits');
    expect(m.body).toContain('Add drift check');
    expect(m.body).toContain(v.compareUrl!);
    expect(m.body).toMatch(/reviewed PR/);
  });

  it('mentions a diverged fork', () => {
    const v = { ...({} as UpstreamView), enabled: true, repo: 'o/r', branch: '', resolvedBranch: 'main', state: 'diverged' as const, missing: 2, ahead: 4, summary: [], compareUrl: 'https://example/compare', upstreamHead: 'a', forkHead: 'b' };
    expect(upstreamMessage(v).title).toMatch(/4 of its own/);
  });
});

describe('persisted state', () => {
  it('round-trips a good result and drops nonsense', () => {
    const raw = { lastAttemptAt: NOW, lastCheckAt: NOW, failures: 2, failure: 'x', lastAlertedHead: SHA_A, result: { ...facts(), state: 'updates' } };
    const loaded = loadUpstream(raw);
    expect(loaded.lastAttemptAt).toBe(NOW);
    expect(loaded.result?.state).toBe('updates');
    expect(loadUpstream(null)).toEqual(emptyUpstream());
    expect(loadUpstream({ result: { nope: true } }).result).toBeNull();
    expect(loadUpstream({ failures: -3 }).failures).toBe(0);
  });
});

describe('the demo scenarios (#14)', () => {
  it('offers current, fork-ahead, upstream-ahead, diverged and a simulated failure', async () => {
    const { createDemoBackend } = await import('./demo.ts');
    const backend = createDemoBackend(null);
    const cfg = { repo: 'leonvanzyl/cubefarm', branch: '' };
    const seen: Record<string, string> = {};
    for (const scenario of ['current', 'ahead', 'updates', 'diverged'] as const) {
      expect(backend.demoUpstream!(scenario)).toBe(true);
      const f = await backend.upstream.inspect(cfg);
      seen[scenario] = compareState(f.missing, f.ahead);
    }
    expect(seen).toEqual({ current: 'current', ahead: 'current', updates: 'updates', diverged: 'diverged' });

    expect(backend.demoUpstream!('failed')).toBe(true);
    await expect(backend.upstream.inspect(cfg)).rejects.toThrow(/simulated/);
    expect(backend.demoUpstream!('nonsense')).toBe(false);
  });
});
