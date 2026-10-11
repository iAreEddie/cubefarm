import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hourlyByModel } from '../shared/cost.ts';
import { parseClaudeSdkUsage, parseClaudeTranscript, parseCodexRollout, parseOpencodeMessages, preferReported, summariseSession } from './telemetry.ts';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'cost', name), 'utf8');

describe('Claude Code transcript', () => {
  const records = parseClaudeTranscript(fixture('claude-transcript.jsonl'), { sessionId: 'sess-claude-1' });

  it('reads one record per assistant message, cache kept apart, and skips a message without usage', () => {
    expect(records).toHaveLength(4); // msg_opus_1 twice, msg_sonnet_1 twice; msg_nousage skipped
    const opus = records.find((r) => r.model === 'claude-opus' && r.usage.output === 500)!;
    expect(opus).toMatchObject({
      provider: 'claude',
      modelRaw: 'claude-opus-5-5',
      usage: { uncachedInput: 100, cachedInput: 2000, cacheWriteInput: 1000, output: 500, reasoningIncludedInOutput: true },
      source: 'claude-transcript',
    });
  });

  it('estimates from tokens with the verified Claude rates, one report per message', () => {
    const s = summariseSession(records);
    expect(s.kind).toBe('estimated');
    expect(s.records).toHaveLength(2); // the duplicate message ids collapse
    expect(s.reportedUsd).toBe(0);
    // opus: (100*15 + 2000*1.5 + 1000*18.75 + 500*75)/1e6 = (1500 + 3000 + 18750 + 37500)/1e6
    expect(s.estimatedUsd).toBeCloseTo((1500 + 3000 + 18750 + 37500 + (50 * 3 + 100 * 15)) / 1e6, 3);
  });

  it('attributes a reported SDK per-model cost and drops that session\'s estimates', () => {
    const sdk = parseClaudeSdkUsage({ 'claude-opus-5-5': { inputTokens: 100, outputTokens: 500, cacheReadInputTokens: 2000, cacheCreationInputTokens: 1000, costUSD: 0.061 } }, { sessionId: 'sess-claude-1' });
    expect(sdk).toHaveLength(1);
    const s = summariseSession([...records, ...sdk]);
    expect(s.kind).toBe('reported');
    expect(s.reportedUsd).toBeCloseTo(0.061, 6);
    expect(s.estimatedUsd).toBe(0); // the report covers the session
    expect(s.records).toHaveLength(1);
  });
});

describe('Codex rollout', () => {
  const records = parseCodexRollout(fixture('codex-rollout.jsonl'), { sessionId: 'sess-codex-1' });

  it('reads each token_count event with its model, cached input subtracted from input, reasoning inside output', () => {
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      provider: 'openai',
      usage: { uncachedInput: 1000, cachedInput: 200, output: 300, reasoning: 100, reasoningIncludedInOutput: true },
      reportedUsd: null,
      source: 'codex-rollout',
    });
    expect(records[1]).toMatchObject({ model: 'gpt-6.1-sol', usage: { uncachedInput: 0, cachedInput: 300, output: 100 } });
  });

  it('has no published Sol rate, so the cost is unavailable until a manager override supplies one', () => {
    const s = summariseSession(records);
    expect(s.kind).toBe('unavailable');
    expect(s.rollup.unavailable).toBe(2);
    expect(s.estimatedUsd).toBe(0);
    const overridden = summariseSession(records, { 'gpt-5.6-sol': { input: 1.25, output: 10, source: 'manager', verifiedAt: '2026-10-11' }, 'gpt-6.1-sol': { input: 1.25, output: 10, source: 'manager', verifiedAt: '2026-10-11' } });
    expect(overridden.kind).toBe('estimated');
    expect(overridden.estimatedUsd).toBeGreaterThan(0);
  });
});

describe('OpenCode session messages', () => {
  const records = parseOpencodeMessages(JSON.parse(fixture('opencode-messages.json')), { sessionId: 'sess-oc-1' });

  it('reads assistant messages only, tokens (cache and reasoning apart) and the provider figure', () => {
    expect(records).toHaveLength(4); // the user message is skipped
    expect(records[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      modelRaw: 'deepseek/deepseek-flash',
      usage: { uncachedInput: 1000, cachedInput: 100, cacheWriteInput: 50, output: 400, reasoning: 0, reasoningIncludedInOutput: false },
      reportedUsd: 0,
    });
  });

  it('estimates a zero-rate placeholder, keeps a reported cost, a genuine free and an unknown rate apart', () => {
    const s = summariseSession(records);
    const byKey = Object.fromEntries(s.resolved.map((r) => [r.key.split(':').pop(), r]));
    expect(byKey.oc_1.kind).toBe('estimated'); // cost 0, but DeepSeek has a rate
    expect(byKey.oc_2.kind).toBe('reported');
    expect(byKey.oc_2.usd).toBeCloseTo(0.0042, 6);
    expect(byKey.oc_3.kind).toBe('free');
    expect(byKey.oc_4.kind).toBe('unavailable'); // no rate for llama-local
    expect(s.rollup).toMatchObject({ records: 4, unavailable: 1, partial: true });
    expect(s.reportedUsd).toBeCloseTo(0.0042, 6);
    expect(s.estimatedUsd).toBeGreaterThan(0);
    expect(s.kind).toBe('estimated'); // mixed reported + estimated
  });
});

describe('deduplication across resumes and restarts', () => {
  it('never adds a resumed cumulative total again', () => {
    const s1 = { ...baseSession('s1', 1.0, 100) };
    const s1Resumed = { ...baseSession('s1', 1.6, 200) };
    const s = summariseSession([s1, s1Resumed]);
    expect(s.reportedUsd).toBe(1.6);
    expect(s.records).toHaveLength(1);
  });

  it('preferReported drops a session\'s estimates when a report covers it', () => {
    const estimate = parseClaudeTranscript(fixture('claude-transcript.jsonl'), { sessionId: 's1' })[0];
    const report = { ...estimate, key: 'report', scope: 'session' as const, reportedUsd: 0.02, model: estimate.model };
    expect(preferReported([estimate, report])).toEqual([report]);
  });
});

describe('hourly cost by model', () => {
  it('reaches a fake-clock average for a mixed-model session', () => {
    const now = Date.UTC(2026, 9, 11, 15, 0);
    const records = parseClaudeTranscript(fixture('claude-transcript.jsonl'), { sessionId: 's1' }).map((r) => ({ ...r, at: now - 2 * 3_600_000 }));
    const s = summariseSession(records);
    const h = hourlyByModel(s.resolved, now, 24, now - 24 * 3_600_000);
    expect(h.rows.map((r) => r.model).sort()).toEqual(['claude-opus', 'claude-sonnet']);
    expect(h.total.usdPerHour).toBeCloseTo(h.total.usd / 24, 6);
  });
});

function baseSession(sessionId: string, reportedUsd: number, at: number) {
  return {
    key: `claude:${sessionId}:session`,
    sessionId,
    scope: 'session' as const,
    at,
    provider: 'claude' as const,
    model: 'claude-opus',
    modelRaw: 'claude-opus-5-5',
    usage: { uncachedInput: 100, cachedInput: 0, cacheWriteInput: 0, output: 100, reasoning: null, reasoningIncludedInOutput: true },
    reportedUsd,
    source: 'claude-sdk' as const,
  };
}
