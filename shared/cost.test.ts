import { describe, expect, it } from 'vitest';
import {
  costLabel,
  dedupe,
  estimateTokensUsd,
  hourlyByModel,
  modelKey,
  normalizeTokens,
  providerFor,
  rateFor,
  RATES,
  resolveUsage,
  rollup,
  tierFor,
  totalTokens,
  type UsageRecord,
} from './cost.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE: UsageRecord = {
  key: 's1:m1',
  sessionId: 's1',
  scope: 'message',
  at: Date.UTC(2026, 9, 11, 12, 0, 0),
  provider: 'claude',
  model: 'claude-opus',
  modelRaw: 'claude-opus-5-5',
  usage: { uncachedInput: 1_000_000, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoning: null, reasoningIncludedInOutput: true },
  reportedUsd: null,
  source: 'claude-transcript',
};
const rec = (over: Partial<UsageRecord>): UsageRecord => ({ ...BASE, ...over });

describe('model aliases and providers', () => {
  it('maps exact and versioned ids to a canonical family', () => {
    expect(modelKey('anthropic/claude-opus-5-5')).toBe('claude-opus');
    expect(modelKey('claude-fable-5-1')).toBe('claude-fable');
    expect(modelKey('sonnet')).toBe('claude-sonnet');
    expect(modelKey('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(modelKey('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(modelKey('deepseek/deepseek-flash')).toBe('deepseek-flash');
  });

  it('infers the provider from the printed id', () => {
    expect(providerFor('claude-opus-5-5')).toBe('claude');
    expect(providerFor('anthropic/claude-sonnet-5')).toBe('claude');
    expect(providerFor('gpt-6.1-sol')).toBe('openai');
    expect(providerFor('deepseek/deepseek-flash')).toBe('deepseek');
    expect(providerFor('llama-local')).toBe('unknown');
  });
});

describe('rates', () => {
  it('carries currency, a source and a verified date for every published rate', () => {
    for (const r of RATES) {
      expect(r.currency).toBe('USD');
      expect(r.source).toMatch(/^https:\/\//);
      expect(r.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.input).toBeGreaterThan(0);
      expect(r.output).toBeGreaterThan(0);
    }
  });

  it('has no rate for an unpublished id, but a manager override supplies one', () => {
    expect(rateFor('gpt-5.6-sol')).toBeNull();
    expect(rateFor('gpt-5.6-sol', { 'gpt-5.6-sol': { input: 1, output: 2, source: 'manager', verifiedAt: '2026-10-11' } })?.output).toBe(2);
    // a partial override of a known rate keeps the other prices
    const sonnet = rateFor('claude-sonnet', { 'claude-sonnet': { output: 16 } });
    expect(sonnet).toMatchObject({ input: 2, output: 16 });
  });

  it('matches the official Claude rates at the cited page (current models, not retired ones)', () => {
    expect(rateFor('claude-fable')).toMatchObject({ input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50, currency: 'USD' });
    expect(rateFor('claude-opus')).toMatchObject({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20, currency: 'USD' });
    expect(rateFor('claude-sonnet')).toMatchObject({ input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10, currency: 'USD' });
    expect(rateFor('claude-haiku')).toMatchObject({ input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5, currency: 'USD' });
  });

  it('matches the official DeepSeek peak rates (off-peak is half)', () => {
    expect(rateFor('deepseek-flash')).toMatchObject({ input: 0.3, cacheWrite: 0.3, cacheRead: 0.006, output: 1.2, offPeakMultiplier: 0.5, currency: 'USD' });
    expect(rateFor('deepseek-v4-pro')).toMatchObject({ input: 1.32, cacheWrite: 1.32, cacheRead: 0.044, output: 3.96, offPeakMultiplier: 0.5, currency: 'USD' });
  });

  it('estimates a Claude Fable session from its verified rate instead of calling it unavailable', () => {
    expect(modelKey('claude-fable-5-1')).toBe('claude-fable');
    const e = estimateTokensUsd({ uncachedInput: 1_000_000, cachedInput: 0, cacheWriteInput: 0, output: 500_000, reasoning: null, reasoningIncludedInOutput: true }, rateFor('claude-fable')!, null)!;
    expect(e.usd).toBeCloseTo(10 + 25, 4); // 1M input + 0.5M output
    const r = resolveUsage(rec({ model: 'claude-fable', modelRaw: 'claude-fable-5-1', provider: 'claude', reportedUsd: null }));
    expect(r.kind).toBe('estimated');
    expect(r.usd).toBeGreaterThan(0);
  });
});

describe('token arithmetic', () => {
  it('prices uncached input, cache read and write, and output separately', () => {
    const rate = rateFor('claude-opus')!;
    const e = estimateTokensUsd({ uncachedInput: 1_000_000, cachedInput: 2_000_000, cacheWriteInput: 1_000_000, output: 1_000_000, reasoning: null, reasoningIncludedInOutput: true }, rate, BASE.at)!;
    // 4 + 2*0.20 + 5 + 20
    expect(e.usd).toBeCloseTo(4 + 0.4 + 5 + 20, 4);
  });

  it('does not count reasoning twice when the provider already folded it into output', () => {
    const rate = rateFor('claude-opus')!;
    const included = estimateTokensUsd({ uncachedInput: 0, cachedInput: 0, cacheWriteInput: 0, output: 1_000_000, reasoning: 500_000, reasoningIncludedInOutput: true }, rate, BASE.at)!;
    const separate = estimateTokensUsd({ uncachedInput: 0, cachedInput: 0, cacheWriteInput: 0, output: 1_000_000, reasoning: 500_000, reasoningIncludedInOutput: false }, rate, BASE.at)!;
    expect(included.usd).toBeCloseTo(20, 4);
    expect(separate.usd).toBeCloseTo(20 + 10, 4); // 0.5M reasoning at the output rate
  });

  it('counts reasoning in the token total only when it is not already in output', () => {
    expect(totalTokens({ uncachedInput: 10, cachedInput: 0, cacheWriteInput: 0, output: 5, reasoning: 100, reasoningIncludedInOutput: true })).toBe(15);
    expect(totalTokens({ uncachedInput: 10, cachedInput: 0, cacheWriteInput: 0, output: 5, reasoning: 100, reasoningIncludedInOutput: false })).toBe(115);
  });
});

describe('deepseek time tiers', () => {
  const usage = { uncachedInput: 1_000_000, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoning: null, reasoningIncludedInOutput: true };

  it('charges full price in the weekday peak windows and half at every other hour', () => {
    const rate = rateFor('deepseek-flash')!;
    const mondayPeak = Date.UTC(2026, 9, 12, 2, 0); // Monday 02:00 UTC
    const mondayOff = Date.UTC(2026, 9, 12, 18, 0); // Monday 18:00 UTC
    expect(estimateTokensUsd(usage, rate, mondayPeak)!.usd).toBeCloseTo(0.3, 4);
    expect(estimateTokensUsd(usage, rate, mondayOff)!.usd).toBeCloseTo(0.15, 4);
    expect(tierFor(rate, mondayPeak).label).toBe('peak');
    expect(tierFor(rate, mondayOff).label).toBe('off-peak');
  });

  it('prices weekends and Chinese public holidays off-peak even inside a peak window', () => {
    const rate = rateFor('deepseek-flash')!;
    const saturdayPeak = Date.UTC(2026, 9, 10, 2, 0); // Saturday 02:00 UTC
    const holidayPeak = Date.UTC(2026, 9, 1, 2, 0); // National Day, a Thursday, 02:00 UTC
    expect(tierFor(rate, saturdayPeak)).toMatchObject({ multiplier: 0.5, label: 'off-peak' });
    expect(estimateTokensUsd(usage, rate, holidayPeak)!.usd).toBeCloseTo(0.15, 4);
  });

  it('assumes peak, and exposes a range, when the time is unknown', () => {
    const rate = rateFor('deepseek-flash')!;
    expect(tierFor(rate, null)).toMatchObject({ multiplier: 1, label: 'peak (time unknown)' });
    const r = resolveUsage(rec({ provider: 'deepseek', model: 'deepseek-flash', at: null, usage }));
    expect(r.kind).toBe('estimated');
    expect(r.range).toEqual([0.15, 0.3]);
  });
});

describe('resolving a record', () => {
  it('prefers a reported cost and labels it reported', () => {
    const r = resolveUsage(rec({ reportedUsd: 2.5 }));
    expect(r).toMatchObject({ kind: 'reported', usd: 2.5 });
  });

  it('keeps a verified genuine zero as free', () => {
    expect(resolveUsage(rec({ reportedUsd: 0, free: true }))).toMatchObject({ kind: 'free', usd: 0 });
  });

  it("estimates OpenCode's zero-rate placeholder from tokens rather than calling it free", () => {
    const r = resolveUsage(rec({ reportedUsd: 0, provider: 'deepseek', model: 'deepseek-flash' }));
    expect(r.kind).toBe('estimated');
    expect(r.usd).toBeGreaterThan(0);
  });

  it('is unavailable, never zero, without tokens or a rate', () => {
    expect(resolveUsage(rec({ reportedUsd: null, usage: { uncachedInput: null, cachedInput: null, cacheWriteInput: null, output: null, reasoning: null, reasoningIncludedInOutput: true } })).kind).toBe('unavailable');
    // unknown rate, measured tokens: unavailable
    expect(resolveUsage(rec({ model: 'gpt-5.6-sol', modelRaw: 'gpt-5.6-sol', provider: 'openai', usage: { uncachedInput: 100, cachedInput: 0, cacheWriteInput: 0, output: 50, reasoning: null, reasoningIncludedInOutput: true } })).kind).toBe('unavailable');
  });
});

describe('deduplication', () => {
  it('keeps the fuller report of a repeated message', () => {
    const partial = rec({ usage: { uncachedInput: 100, cachedInput: null, cacheWriteInput: null, output: null, reasoning: null, reasoningIncludedInOutput: true } });
    const full = rec({ usage: { uncachedInput: 100, cachedInput: null, cacheWriteInput: null, output: 40, reasoning: null, reasoningIncludedInOutput: true } });
    expect(dedupe([partial, full])).toHaveLength(1);
    expect(totalTokens(dedupe([partial, full])[0].usage)).toBe(140);
  });

  it("never adds a resumed session's cumulative total again, and drops its messages", () => {
    const first = rec({ key: 's1', scope: 'session', reportedUsd: 1, at: 100 });
    const resumed = rec({ key: 's1', scope: 'session', reportedUsd: 1.6, at: 200 });
    const msg = rec({ key: 's1:m1', scope: 'message', reportedUsd: 0.4, at: 150 });
    const kept = dedupe([first, resumed, msg]);
    expect(kept).toHaveLength(1);
    expect(kept[0].reportedUsd).toBe(1.6);
  });
});

describe('roll-ups', () => {
  it('keeps reported and estimated apart and counts coverage', () => {
    const r = rollup([
      resolveUsage(rec({ key: 'a', reportedUsd: 2 })),
      resolveUsage(rec({ key: 'b' })),
      resolveUsage(rec({ key: 'c', usage: { uncachedInput: null, cachedInput: null, cacheWriteInput: null, output: null, reasoning: null, reasoningIncludedInOutput: true } })),
    ]);
    expect(r).toMatchObject({ reportedUsd: 2, estimatedUsd: 4, records: 3, unavailable: 1, partial: true });
    expect(r.coverage).toBeCloseTo(2 / 3);
    expect(r.totalUsd).toBeCloseTo(6);
  });
});

describe('hourly averages over a fake clock', () => {
  const now = Date.UTC(2026, 9, 11, 15, 0);
  it('divides by elapsed wall-clock hours, idle hours included', () => {
    // One model, $24 of cost spread over records, history spans the full window.
    const records = [
      resolveUsage(rec({ key: 's1:m1', model: 'claude-opus', reportedUsd: 12, at: now - 20 * HOUR })),
      resolveUsage(rec({ key: 's1:m2', model: 'claude-opus', reportedUsd: 12, at: now - 1 * HOUR })),
    ];
    const h = hourlyByModel(records, now, 24, now - 24 * HOUR);
    expect(h.elapsedHours).toBe(24);
    expect(h.partial).toBe(false);
    expect(h.rows[0]).toMatchObject({ model: 'claude-opus', usd: 24 });
    expect(h.rows[0].usdPerHour).toBeCloseTo(1, 4);
  });

  it('discloses partial history and skips a window with no elapsed time', () => {
    const records = [resolveUsage(rec({ key: 's1:m1', reportedUsd: 3, at: now - 3 * HOUR }))];
    const h = hourlyByModel(records, now, 24, now - 6 * HOUR);
    expect(h.elapsedHours).toBe(6);
    expect(h.partial).toBe(true);
    expect(h.rows[0].usdPerHour).toBeCloseTo(0.5, 4);
    const none = hourlyByModel([], now, 24, now);
    expect(none.elapsedHours).toBe(0);
    expect(none.rows).toEqual([]);
  });

  it('groups by model and flags a model with unavailable records', () => {
    const records = [
      resolveUsage(rec({ key: 's1:m1', model: 'claude-opus', reportedUsd: 6, at: now - HOUR })),
      resolveUsage(rec({ key: 's1:m2', model: 'gpt-5.6-sol', modelRaw: 'gpt-5.6-sol', provider: 'openai', usage: { uncachedInput: 100, cachedInput: 0, cacheWriteInput: 0, output: 50, reasoning: null, reasoningIncludedInOutput: true }, at: now - HOUR })),
    ];
    const h = hourlyByModel(records, now, 24, now - 24 * HOUR);
    const sol = h.rows.find((r) => r.model === 'gpt-5.6-sol')!;
    expect(sol).toMatchObject({ kind: 'unavailable', partial: true, usd: 0, unavailable: 1 });
    expect(h.partial).toBe(true);
  });
});

describe('labels and parsing helpers', () => {
  it('names every provenance', () => {
    expect(costLabel('reported')).toBe('reported');
    expect(costLabel('mixed')).toBe('reported + estimated');
    expect(costLabel('none')).toBe('no data');
  });

  it('normalizes a token block and reads timestamps', () => {
    expect(normalizeTokens({ input: 5, output: 2, cacheRead: 1, cacheWrite: 3, reasoning: 4, reasoningIncludedInOutput: false })).toEqual({
      uncachedInput: 5,
      output: 2,
      cachedInput: 1,
      cacheWriteInput: 3,
      reasoning: 4,
      reasoningIncludedInOutput: false,
    });
    expect(normalizeTokens({ input: 'x' as unknown })).toMatchObject({ uncachedInput: null });
  });
});
