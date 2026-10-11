import { describe, expect, it } from 'vitest';
import { upstreamSince, upstreamStatusText } from './upstream';
import type { UpstreamView } from '../../shared/types';

const view = (over: Partial<UpstreamView> = {}): UpstreamView => ({
  enabled: true,
  repo: 'leonvanzyl/cubefarm',
  branch: '',
  resolvedBranch: 'main',
  state: 'current',
  missing: 0,
  ahead: 0,
  upstreamHead: null,
  forkHead: null,
  compareUrl: null,
  summary: [],
  lastAttemptAt: null,
  lastCheckAt: null,
  detail: null,
  ...over,
});

describe('upstream status text', () => {
  it('reads each state in plain words', () => {
    expect(upstreamStatusText(view())).toBe('Up to date with upstream');
    expect(upstreamStatusText(view({ ahead: 5 }))).toBe('Up to date (this fork is 5 commits ahead)');
    expect(upstreamStatusText(view({ state: 'updates', missing: 3 }))).toBe('3 updates available');
    expect(upstreamStatusText(view({ state: 'updates', missing: 1 }))).toBe('1 update available');
    expect(upstreamStatusText(view({ state: 'diverged', missing: 2, ahead: 4 }))).toBe('Diverged: 2 upstream commits, 4 of our own');
    expect(upstreamStatusText(view({ state: 'failed' }))).toBe('Last check failed');
    expect(upstreamStatusText(view({ state: 'off' }))).toBe('Off');
    expect(upstreamStatusText(view({ state: 'unknown' }))).toBe('Not checked yet');
  });

  it('says when the last check was', () => {
    const now = 1_700_000_000_000;
    expect(upstreamSince(null, now)).toBe('never');
    expect(upstreamSince(now - 30_000, now)).toBe('just now');
    expect(upstreamSince(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(upstreamSince(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(upstreamSince(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
