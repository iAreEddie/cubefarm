// Reading what each coding agent's sessions actually used (#15): Claude Code's transcript and SDK result, Codex's
// rollout file and OpenCode's session messages. Every parser is pure and turns structured session data into the
// office's normalized UsageRecord — never terminal text — so the accounting in shared/cost.ts can price it. Each
// function tolerates a shape it doesn't recognize by returning nothing.

import {
  atMs,
  dedupe,
  modelKey,
  providerFor,
  resolveUsage,
  rollup,
  type CostKind,
  type CostRollup,
  type RateOverrides,
  type ResolvedUsage,
  type UsageRecord,
  type UsageSource,
} from '../shared/cost.ts';

export interface ParseContext {
  sessionId: string;
  cli?: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function record(parts: {
  key: string;
  sessionId: string;
  scope: 'message' | 'session';
  at: number | null;
  model: string;
  modelRaw?: string;
  cli?: string;
  usage: UsageRecord['usage'];
  reportedUsd: number | null;
  free?: boolean;
  source: UsageSource;
}): UsageRecord {
  return {
    key: parts.key,
    sessionId: parts.sessionId,
    scope: parts.scope,
    at: parts.at,
    provider: providerFor(parts.modelRaw || parts.model),
    model: modelKey(parts.modelRaw || parts.model),
    modelRaw: parts.modelRaw || parts.model,
    cli: parts.cli,
    usage: parts.usage,
    reportedUsd: parts.reportedUsd,
    ...(parts.free ? { free: true } : {}),
    source: parts.source,
  };
}

// ---------- Claude Code ----------

/**
 * Claude Code's transcript: one JSON object per line, assistant turns carrying the API message id, model and token
 * usage. Cached read and cache creation are separate line items the API doesn't fold into input, so they stay apart;
 * thinking tokens are billed as output, so reasoning isn't added a second time. The same message can appear more than
 * once (streaming, or a resumed session replaying a turn): dedupe keeps the fuller report.
 */
export function parseClaudeTranscript(text: string, ctx: ParseContext): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type !== 'assistant') continue;
    const message = obj(row.message);
    const usage = obj(message.usage);
    const id = str(message.id) || str(row.uuid);
    const modelRaw = str(message.model);
    if (!id || !modelRaw) continue;
    const input = numOrNull(usage.input_tokens);
    const output = numOrNull(usage.output_tokens);
    const cached = numOrNull(usage.cache_read_input_tokens);
    const cacheWrite = numOrNull(usage.cache_creation_input_tokens);
    if (input === null && output === null && cached === null && cacheWrite === null) continue;
    out.push(
      record({
        key: `claude:${ctx.sessionId}:${id}`,
        sessionId: ctx.sessionId,
        scope: 'message',
        at: atMs(row.timestamp),
        model: modelRaw,
        cli: ctx.cli ?? 'claude',
        usage: { uncachedInput: input, cachedInput: cached, cacheWriteInput: cacheWrite, output, reasoning: null, reasoningIncludedInOutput: true },
        reportedUsd: null,
        source: 'claude-transcript',
      }),
    );
  }
  return out;
}

/** One model's block in an SDK result's `modelUsage` / a CLI status line's per-model totals. */
function modelUsageRecord(modelRaw: string, u: Record<string, unknown>, reportedUsd: number | null, ctx: ParseContext): UsageRecord | null {
  const input = numOrNull(u.inputTokens ?? u.input_tokens);
  const output = numOrNull(u.outputTokens ?? u.output_tokens);
  const cached = numOrNull(u.cacheReadInputTokens ?? u.cache_read_input_tokens);
  const cacheWrite = numOrNull(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens);
  if (input === null && output === null && cached === null && cacheWrite === null && reportedUsd === null) return null;
  return record({
    key: `claude:${ctx.sessionId}:${modelKey(modelRaw)}`,
    sessionId: ctx.sessionId,
    scope: 'session',
    at: Date.now(),
    model: modelRaw,
    cli: ctx.cli ?? 'claude',
    usage: { uncachedInput: input, cachedInput: cached, cacheWriteInput: cacheWrite, output, reasoning: null, reasoningIncludedInOutput: true },
    reportedUsd,
    source: 'claude-sdk',
  });
}

/**
 * The Claude Agent SDK's result: per-model totals in `modelUsage` (each with its own `costUSD`), so the reported cost
 * is attributed to the model that accrued it rather than smeared over one.
 */
export function parseClaudeSdkUsage(modelUsage: unknown, ctx: ParseContext): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const [modelRaw, block] of Object.entries(obj(modelUsage))) {
    const b = obj(block);
    const r = modelUsageRecord(modelRaw, b, numOrNull(b.costUSD ?? b.cost_usd), ctx);
    if (r) out.push(r);
  }
  return out;
}

// ---------- Codex ----------

/**
 * Codex's rollout file: JSON lines. `turn_context` carries the model; `token_count` events carry `last_token_usage`
 * for the turn (or a running `total_token_usage`). OpenAI counts cached input inside input, and reasoning inside
 * output, so the cached part is subtracted from input and reasoning isn't re-added. Codex reports no dollar figure:
 * the cost is estimated from the verified rate.
 */
export function parseCodexRollout(text: string, ctx: ParseContext): UsageRecord[] {
  const out: UsageRecord[] = [];
  let model = '';
  let seq = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = obj(row.payload);
    if (row.type === 'turn_context' || row.type === 'session_meta') {
      model = str(payload.model) || model;
      continue;
    }
    if (row.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = obj(payload.info);
    const use = obj(info.last_token_usage).input_tokens !== undefined || obj(info.last_token_usage).output_tokens !== undefined ? obj(info.last_token_usage) : obj(info.total_token_usage);
    const totalIn = numOrNull(use.input_tokens);
    const cached = numOrNull(use.cached_input_tokens);
    const output = numOrNull(use.output_tokens);
    const reasoning = numOrNull(use.reasoning_output_tokens);
    if (totalIn === null && output === null && cached === null) continue;
    const at = atMs(row.timestamp);
    const raw = model || 'codex';
    out.push(
      record({
        key: `codex:${ctx.sessionId}:${seq++}`,
        sessionId: ctx.sessionId,
        scope: 'message',
        at,
        model: raw,
        cli: ctx.cli ?? 'codex',
        usage: {
          uncachedInput: totalIn !== null && cached !== null ? Math.max(0, totalIn - cached) : totalIn,
          cachedInput: cached,
          cacheWriteInput: null,
          output,
          reasoning,
          reasoningIncludedInOutput: true,
        },
        reportedUsd: null,
        source: 'codex-rollout',
      }),
    );
  }
  return out;
}

// ---------- OpenCode ----------

/**
 * OpenCode's session messages (the plugin reads `client.session.messages`). `tokens.input` excludes cache, and
 * reasoning is reported apart from output. `info.cost` is the provider's figure: a positive number is reported; a
 * zero for a model the provider has no rate for is a placeholder the office estimates instead of calling free.
 */
export function parseOpencodeMessages(messages: unknown, ctx: ParseContext): UsageRecord[] {
  if (!Array.isArray(messages)) return [];
  const out: UsageRecord[] = [];
  for (const entry of messages) {
    const info = obj(obj(entry).info);
    if (info.role !== 'assistant') continue;
    const tokens = obj(info.tokens);
    const cache = obj(tokens.cache);
    const id = str(info.id) || `msg${out.length}`;
    const modelRaw = str(info.modelID) || str(info.model);
    const provider = str(info.providerID);
    const model = provider && modelRaw && !modelRaw.includes('/') ? `${provider}/${modelRaw}` : modelRaw;
    const input = numOrNull(tokens.input);
    const output = numOrNull(tokens.output);
    const reasoning = numOrNull(tokens.reasoning);
    const cached = numOrNull(cache.read);
    const cacheWrite = numOrNull(cache.write);
    const cost = numOrNull(info.cost);
    const fields = [input, output, reasoning, cached, cacheWrite];
    const hasTokens = fields.some((v) => v !== null);
    const usedTokens = fields.some((v) => (v ?? 0) > 0);
    if (!hasTokens && cost === null) continue;
    const created = atMs(obj(info.time).created ?? info.time);
    out.push(
      record({
        key: `opencode:${ctx.sessionId}:${id}`,
        sessionId: ctx.sessionId,
        scope: 'message',
        at: created,
        model: model || 'opencode',
        cli: ctx.cli ?? 'opencode',
        usage: { uncachedInput: input, cachedInput: cached, cacheWriteInput: cacheWrite, output, reasoning, reasoningIncludedInOutput: false },
        reportedUsd: cost,
        // No tokens used and a zero cost is a genuine free call, not a missing rate.
        free: cost === 0 && !usedTokens,
        source: 'opencode-session',
      }),
    );
  }
  return out;
}

// ---------- one session's summary ----------

/** A session's usage after normalization: what it used, what it's worth, and how confidently. */
export interface SessionUsage {
  records: UsageRecord[];
  resolved: ResolvedUsage[];
  rollup: CostRollup;
  /** Reported cost, or 0 when none was reported. Budget enforcement uses this and only this. */
  reportedUsd: number;
  /** Estimated cost from measured tokens and verified rates; kept separate from reported. */
  estimatedUsd: number;
  kind: CostKind;
}

const emptyRollup = (): CostRollup => ({ reportedUsd: 0, estimatedUsd: 0, freeUsd: 0, totalUsd: 0, unavailable: 0, records: 0, coverage: 1, partial: false, currency: 'USD', kind: 'none' });

/**
 * Turn a session's raw records into its cost. A provider's report covers the whole session and wins over token
 * estimates for it (so the two are never added); cumulative totals replace earlier ones on resume; anything with no
 * tokens and no rate is unavailable, never zero.
 */
export function summariseSession(records: UsageRecord[], overrides: RateOverrides = {}): SessionUsage {
  const preferred = preferReported(records);
  const kept = dedupe(preferred);
  const resolved = kept.map((r) => resolveUsage(r, overrides));
  const total = rollup(resolved);
  return { records: kept, resolved, rollup: total, reportedUsd: total.reportedUsd, estimatedUsd: total.estimatedUsd, kind: overallKind(resolved) };
}

/**
 * Within a session, a reported (or explicitly free) figure covers the session: token estimates for the same session
 * are dropped so a report and an estimate of the same work are never both counted.
 */
export function preferReported(records: UsageRecord[]): UsageRecord[] {
  const bySession = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const g = bySession.get(r.sessionId) ?? [];
    g.push(r);
    bySession.set(r.sessionId, g);
  }
  const out: UsageRecord[] = [];
  for (const list of bySession.values()) {
    // Only a cumulative session report covers the whole session; per-message reports (OpenCode) coexist with estimates.
    const reported = list.filter((r) => r.scope === 'session' && ((r.reportedUsd ?? 0) > 0 || r.free));
    out.push(...(reported.length ? reported : list));
  }
  return out;
}

function overallKind(resolved: ResolvedUsage[]): CostKind {
  if (!resolved.length) return 'unavailable';
  if (resolved.some((r) => r.kind === 'reported') && resolved.some((r) => r.kind === 'estimated')) return 'estimated';
  if (resolved.some((r) => r.kind === 'reported')) return 'reported';
  if (resolved.some((r) => r.kind === 'estimated')) return 'estimated';
  if (resolved.some((r) => r.kind === 'free')) return 'free';
  return 'unavailable';
}

/** Merge records from several sources for one session (a transcript and an SDK result, say), deduplicated. */
export const mergeSession = summariseSession;

export { emptyRollup };
