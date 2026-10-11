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
    expect(sonnet).toMatchObject({ input: 3, output: 16 });
  });
});

describe('token arithmetic', () => {
  it('prices uncached input, cache read and write, and output separately', () => {
    const rate = rateFor('claude-opus')!;
    const e = estimateTokensUsd({ uncachedInput: 1_000_000, cachedInput: 2_000_000, cacheWriteInput: 1_000_000, output: 1_000_000, reasoning: null, reasoningIncludedInOutput: true }, rate, BASE.at)!;
    // 15 + 2*1.5 + 18.75 + 75
    expect(e.usd).toBeCloseTo(15 + 3 + 18.75 + 75, 4);
  });

  it('does not count reasoning twice when the provider already folded it into output', () => {
    const rate = rateFor('deepseek-flash')!;
    const included = estimateTokensUsd({ uncachedInput: 0, cachedInput: 0, cacheWriteInput: 0, output: 1_000_000, reasoning: 500_000, reasoningIncludedInOutput: true }, rate, BASE.at)!;
    const separate = estimateTokensUsd({ uncachedInput: 0, cachedInput: 0, cacheWriteInput: 0, output: 1_000_000, reasoning: 500_000, reasoningIncludedInOutput: false }, rate, BASE.at)!;
    expect(included.usd).toBeCloseTo(1.1, 4);
    expect(separate.usd).toBeCloseTo(1.1 + 0.55, 4); // 0.5M at the output rate
  });

  it('counts reasoning in the token total only when it is not already in output', () => {
    expect(totalTokens({ uncachedInput: 10, cachedInput: 0, cacheWriteInput: 0, output: 5, reasoning: 100, reasoningIncludedInOutput: true })).toBe(15);
    expect(totalTokens({ uncachedInput: 10, cachedInput: 0, cacheWriteInput: 0, output: 5, reasoning: 100, reasoningIncludedInOutput: false })).toBe(115);
  });
});

describe('deepseek time tiers', () => {
  it('halves the price in the off-peak window and charges full at peak', () => {
    const rate = rateFor('deepseek-flash')!;
    const peak = new Date(Date.UTC(2026, 9, 11, 10, 0));
    const off = new Date(Date.UTC(2026, 9, 11, 18, 0));
    const usage = { uncachedInput: 1_000_000, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoning: null, reasoningIncludedInOutput: true };
    expect(estimateTokensUsd(usage, rate, peak.getTime())!.usd).toBeCloseTo(0.27, 4);
    expect(estimateTokensUsd(usage, rate, off.getTime())!.usd).toBeCloseTo(0.135, 4);
    expect(tierFor(rate, off.getTime()).label).toBe('off-peak');
  });

  it('assumes peak, and exposes a range, when the time is unknown', () => {
    const rate = rateFor('deepseek-flash')!;
    expect(tierFor(rate, null)).toMatchObject({ multiplier: 1, label: 'peak (time unknown)' });
    const r = resolveUsage(rec({ provider: 'deepseek', model: 'deepseek-flash', at: null, usage: { uncachedInput: 1_000_000, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoning: null, reasoningIncludedInOutput: true } }));
    expect(r.kind).toBe('estimated');
    expect(r.range).toEqual([0.135, 0.27]);
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
    expect(r).toMatchObject({ reportedUsd: 2, estimatedUsd: 15, records: 3, unavailable: 1, partial: true });
    expect(r.coverage).toBeCloseTo(2 / 3);
    expect(r.totalUsd).toBeCloseTo(17);
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
