// Cost accounting (#15): what a coding agent's sessions actually used and what that is worth. One normalized shape
// for every CLI (tokens with cache and reasoning kept apart, a timestamp and where the numbers came from), a small
// table of verified rates, and the arithmetic that turns measured tokens into dollars. Pure, so the server and the
// office read a session's cost the same way.
//
// Rules that matter:
// - Prefer a provider's reported cost and label it "reported" (a usage value, not an invoice). Otherwise estimate from
//   measured tokens and a verified rate. Unknown tokens or rates are "unavailable" — never a zero.
// - A verified genuine zero is "free": kept as a real value, not treated as missing.
// - OpenCode reports 0 for a model it has no rate for: that zero is a placeholder, not free.
// - Never count a token twice: cached input and reasoning may already sit inside input/output.
// - Deduplicate by session/message and by session total, so resumes and cumulative reports don't inflate anything.
// - Rates are pinned to a date: a later rate change never rewrites what something already cost.

/** Who ran and who billed: Claude Code and Codex are subscriptions (values are API-equivalent), DeepSeek is metered. */
export type CostProvider = 'claude' | 'openai' | 'deepseek' | 'unknown';

/** Where a session's usage came from, for provenance in the UI. */
export type UsageSource = 'claude-transcript' | 'claude-sdk' | 'claude-statusline' | 'opencode-session' | 'codex-rollout' | 'legacy';

/** What a cost number is: measured by the provider, worked out from tokens, genuinely zero, or not known. */
export type CostKind = 'reported' | 'estimated' | 'free' | 'unavailable';

/** A message's usage is one API call; a session's is a cumulative lifetime total a CLI repeats on every report. */
export type UsageScope = 'message' | 'session';

/**
 * Tokens as a provider reports them, kept apart so nothing is counted twice. null means "not reported", which is not
 * a zero. `reasoningIncludedInOutput` records whether the provider already folded reasoning into output (Claude,
 * Codex, DeepSeek do) or reports it separately (OpenCode).
 */
export interface TokenUsage {
  uncachedInput: number | null;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  output: number | null;
  reasoning: number | null;
  reasoningIncludedInOutput: boolean;
}

/** A verified or overridden rate, all prices per million tokens in `currency`. */
export interface RateEntry {
  provider: CostProvider;
  model: string; // canonical id (see modelKey)
  currency: string;
  input: number; // uncached input
  cacheRead: number; // cached input
  cacheWrite: number; // cache creation/write
  output: number; // output (reasoning included unless reasoningRate is set)
  reasoningRate?: number; // only when billed apart from output
  /**
   * Priced windows by time of day (UTC), e.g. DeepSeek's peak hours. Half-open [fromHourUtc, toHourUtc), may wrap
   * midnight; `weekdaysOnly` skips Saturday and Sunday. When no window matches, `offPeakMultiplier` applies.
   */
  tiers?: { fromHourUtc: number; toHourUtc: number; multiplier: number; label: string; weekdaysOnly?: boolean }[];
  /** Multiplier outside every tier window (DeepSeek's off-peak half price). Default 1: no discount. */
  offPeakMultiplier?: number;
  /** Dates (UTC 'YYYY-MM-DD') priced off-peak regardless of the tiers, e.g. Chinese public holidays. */
  holidays?: string[];
  source: string; // where the rate was verified
  verifiedAt: string; // ISO date the rate was checked
  note?: string;
  /** A subscription product: the estimate is the API-equivalent usage value, not an extra charge. */
  subscription?: boolean;
}

/**
 * One measured piece of usage. `key` identifies it for deduplication (a message id, or a session for a cumulative
 * total); `sessionId` groups the messages of one CLI session. `reportedUsd` is the provider's own figure, null when
 * it reported none (and, for OpenCode, 0 is a placeholder meaning it had no rate: never free unless `free` is set).
 */
export interface UsageRecord {
  key: string;
  sessionId: string;
  scope: UsageScope;
  at: number | null; // epoch ms
  provider: CostProvider;
  model: string; // canonical id
  modelRaw: string; // the id the provider printed
  cli?: string; // the office's CLI id when known
  usage: TokenUsage;
  reportedUsd: number | null;
  free?: boolean; // a verified genuine zero: kept, not treated as unknown
  source: UsageSource;
  /** The office floor this usage belongs to ('' for the CEO); set by the swarm, never by a parser. */
  repo?: string;
}

/** A record with its cost resolved: what it is, what it's worth, and how that was worked out. */
export interface ResolvedUsage extends UsageRecord {
  kind: CostKind;
  usd: number; // 0 when unavailable/free
  rate?: RateEntry;
  tier?: string;
  /** present when the time of day wasn't known and a peak/off-peak rate could apply: [off-peak, peak]. */
  range?: [number, number];
}

export const EMPTY_USAGE: TokenUsage = { uncachedInput: null, cachedInput: null, cacheWriteInput: null, output: null, reasoning: null, reasoningIncludedInOutput: true };

// ---------- canonical models and aliases ----------

const CLAUDE_FAMILY = /(opus|sonnet|haiku|fable|mythos)/;

/**
 * A Claude model id's canonical form: family plus the exact version it names, so versions the page prices
 * differently are never collapsed into one another. "anthropic/claude-opus-5-5" -> "claude-opus-5-5"; the older
 * "claude-3-5-sonnet-20241022" -> "claude-sonnet-3-5". A trailing date is ignored. A bare family name ("sonnet") has
 * no version to pin a price to, so it becomes "claude-sonnet" and stays unrateable until a manager overrides it.
 */
function claudeKey(tail: string): string | null {
  const s = tail.toLowerCase();
  // The version leads the family: claude-3-5-sonnet, claude-3-opus.
  let m = /(\d{1,2})[-_.](\d{1,2})[-_.]?(opus|sonnet|haiku|fable|mythos)/.exec(s);
  if (m) return `claude-${m[3]}-${m[1]}-${m[2]}`;
  // The version follows the family: claude-opus-5-5, claude-sonnet-5, claude-haiku-4.5 (a date suffix is not a version).
  m = /(opus|sonnet|haiku|fable|mythos)[-_. ]?(\d{1,2})(?:[-_.](\d{1,2}))?/.exec(s);
  if (m) return `claude-${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
  m = CLAUDE_FAMILY.exec(s);
  return m ? `claude-${m[1]}` : null;
}

const OPENAI_ALIASES: [RegExp, string][] = [
  [/gpt[-_.\s]?6[.\-]1[-_.\s]?sol/i, 'gpt-6.1-sol'],
  [/gpt[-_.\s]?5[.\-]6[-_.\s]?sol/i, 'gpt-5.6-sol'],
  [/gpt[-_.\s]?6[-_.\s]?astra/i, 'gpt-6-astra'],
  [/gpt[-_.\s]?6[-_.\s]?sol/i, 'gpt-6-sol'],
];
const DEEPSEEK_ALIASES: [RegExp, string][] = [
  [/deepseek[-_.\s]?flash/i, 'deepseek-flash'],
  [/deepseek[-_.\s]?v4[-_.\s]?flash/i, 'deepseek-flash'],
  [/deepseek[-_.\s]?v4[-_.\s]?pro/i, 'deepseek-v4-pro'],
  [/deepseek[-_.\s]?reasoner/i, 'deepseek-reasoner'],
  [/deepseek[-_.\s]?chat/i, 'deepseek-chat'],
];

function alias(list: [RegExp, string][], raw: string): string | null {
  for (const [re, id] of list) if (re.test(raw)) return id;
  return null;
}

/** The provider a printed model id belongs to, or 'unknown'. */
export function providerFor(raw: string): CostProvider {
  const s = raw.trim();
  if (!s) return 'unknown';
  if (/(^|\/)deepseek/i.test(s) || /deepseek/i.test(s)) return 'deepseek';
  if (/gpt|(^|\/)o[134]\b|codex/i.test(s)) return 'openai';
  if (/claude|opus|sonnet|haiku|fable|anthropic/i.test(s)) return 'claude';
  return 'unknown';
}

/**
 * A printed model id's canonical form. Claude keeps the exact version it names (`claudeKey`); DeepSeek's legacy
 * Flash names fold into `deepseek-flash`; anything else passes through lowercased and stays unrateable.
 */
export function modelKey(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const tail = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
  return claudeKey(tail) ?? alias(DEEPSEEK_ALIASES, tail) ?? alias(OPENAI_ALIASES, tail) ?? tail.toLowerCase();
}

// ---------- verified rates ----------

/**
 * Chinese public holidays the office prices off-peak (UTC dates), from the State Council's 2026 notice. Lunar-calendar
 * feasts move each year; a later year's list is a manager override (`RateOverrides`) until it is verified here.
 */
const CN_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
];

const CLAUDE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const DEEPSEEK_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
const VERIFIED_AT = '2026-10-11';

/**
 * One exact Claude model version at the cited page, in USD per MTok. `cacheWrite` is the 5-minute write and
 * `cacheRead` the page's cache-hit price. A version not listed here has no rate: the office shows it unavailable
 * rather than borrowing a sibling version's price, and a manager `RateOverrides` entry can supply one.
 */
function claudeRate(model: string, input: number, cacheRead: number, cacheWrite: number, output: number): RateEntry {
  return {
    provider: 'claude',
    model,
    currency: 'USD',
    input,
    cacheRead,
    cacheWrite,
    output,
    source: CLAUDE_SOURCE,
    verifiedAt: VERIFIED_AT,
    subscription: true,
    note: 'API-equivalent value of a Claude Code subscription session; not an extra charge per session.',
  };
}

/** DeepSeek's peak price and the shared peak/off-peak tier rule (off-peak is half, weekends and Chinese holidays too). */
function deepseekRate(model: string, input: number, cacheRead: number, output: number, note: string): RateEntry {
  return {
    provider: 'deepseek',
    model,
    currency: 'USD',
    input,
    cacheRead,
    cacheWrite: input, // DeepSeek has no separate cache-write price: a write is a cache miss
    output,
    source: DEEPSEEK_SOURCE,
    verifiedAt: VERIFIED_AT,
    note,
    tiers: [
      { fromHourUtc: 1, toHourUtc: 4, multiplier: 1, label: 'peak', weekdaysOnly: true },
      { fromHourUtc: 6, toHourUtc: 10, multiplier: 1, label: 'peak', weekdaysOnly: true },
    ],
    offPeakMultiplier: 0.5,
    holidays: CN_HOLIDAYS_2026,
  };
}

/**
 * Rates verified at implementation time, per exact model version. Claude's family regexes once collapsed versions, so
 * Opus 5 borrowed Opus 5.5's price; each version now carries its own entry. Codex's Sol ids have no published rate the
 * office could verify, so they carry none: the cost shows as unavailable rather than guessed from a similar name.
 */
export const RATES: RateEntry[] = [
  // Claude, current versions first, then older ones the page still prices (retired versions keep their own rate).
  claudeRate('claude-fable-5-1', 10, 0.25, 12.5, 50),
  claudeRate('claude-fable-5', 10, 1, 12.5, 50),
  claudeRate('claude-opus-5-5', 4, 0.2, 5, 20),
  claudeRate('claude-opus-5', 5, 0.5, 6.25, 25),
  claudeRate('claude-opus-4-8', 5, 0.5, 6.25, 25),
  claudeRate('claude-opus-4-7', 5, 0.5, 6.25, 25),
  claudeRate('claude-opus-4-6', 5, 0.5, 6.25, 25),
  claudeRate('claude-opus-4-5', 5, 0.5, 6.25, 25),
  claudeRate('claude-opus-4-1', 15, 1.5, 18.75, 75),
  claudeRate('claude-opus-4', 15, 1.5, 18.75, 75),
  claudeRate('claude-sonnet-5-5', 2, 0.1, 2.5, 10),
  claudeRate('claude-sonnet-5', 2, 0.2, 2.5, 10),
  claudeRate('claude-sonnet-4-6', 3, 0.3, 3.75, 15),
  claudeRate('claude-sonnet-4-5', 3, 0.3, 3.75, 15),
  claudeRate('claude-sonnet-4', 3, 0.3, 3.75, 15),
  claudeRate('claude-haiku-5-5', 0.1, 0.01, 0.125, 0.5),
  claudeRate('claude-haiku-4-5', 1, 0.1, 1.25, 5),
  claudeRate('claude-haiku-3-5', 0.8, 0.08, 1, 4),
  deepseekRate('deepseek-flash', 0.3, 0.006, 1.2, 'deepseek-flash (DeepSeek-V4.1-Flash) peak price; off-peak is half. Legacy names deepseek-v4-flash and deepseek-v4-flash-vision-exp bill at this rate. Peak 01:00-04:00 and 06:00-10:00 UTC Mon-Fri, excluding Chinese public holidays.'),
  deepseekRate('deepseek-v4-pro', 1.32, 0.044, 3.96, 'deepseek-v4-pro (DeepSeek-V4-Pro-0813) peak price; off-peak is half. Peak 01:00-04:00 and 06:00-10:00 UTC Mon-Fri, excluding Chinese public holidays.'),
];

const byModel = new Map(RATES.map((r) => [r.model, r]));

/** A manager's rate for a custom or unpublished id: the diff applied on top of any verified entry. */
export type RateOverrides = Record<string, Partial<RateEntry>>;

/**
 * The rate for a canonical model id, with a manager's override merged in. An override for an id with no verified rate
 * must carry the prices itself. null: no rate, so an estimate is unavailable.
 */
export function rateFor(model: string, overrides: RateOverrides = {}): RateEntry | null {
  const base = byModel.get(model);
  const over = overrides[model];
  if (base && !over) return base;
  if (base && over) return { ...base, ...over, model };
  if (!over || over.input == null || over.output == null) return null;
  return {
    provider: over.provider ?? providerFor(model),
    model,
    currency: over.currency ?? 'USD',
    input: over.input,
    cacheRead: over.cacheRead ?? over.input,
    cacheWrite: over.cacheWrite ?? over.input,
    output: over.output,
    source: over.source ?? 'manager override',
    verifiedAt: over.verifiedAt ?? new Date().toISOString().slice(0, 10),
  } as RateEntry;
}

// ---------- the arithmetic ----------

/** The multiplier and label for a record's time (UTC): a tier window, off-peak, or the peak when the hour is unknown. */
export function tierFor(rate: RateEntry, at: number | null): { multiplier: number; label: string } {
  if (!rate.tiers?.length) return { multiplier: 1, label: 'standard' };
  const peak = Math.max(...rate.tiers.map((t) => t.multiplier));
  const off = rate.offPeakMultiplier ?? 1;
  if (at === null) return { multiplier: peak, label: 'peak (time unknown)' };
  const d = new Date(at);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const day = d.getUTCDay(); // 0 Sunday … 6 Saturday
  const date = d.toISOString().slice(0, 10);
  if (rate.holidays?.includes(date)) return { multiplier: off, label: 'off-peak (holiday)' };
  for (const t of rate.tiers) {
    if (t.weekdaysOnly && (day === 0 || day === 6)) continue;
    const inTier = t.fromHourUtc <= t.toHourUtc ? hour >= t.fromHourUtc && hour < t.toHourUtc : hour >= t.fromHourUtc || hour < t.toHourUtc;
    if (inTier) return { multiplier: t.multiplier, label: t.label };
  }
  return { multiplier: off, label: 'off-peak' };
}

/** All token categories are missing: there's nothing to price. */
export const hasTokens = (u: TokenUsage) =>
  u.uncachedInput !== null || u.cachedInput !== null || u.cacheWriteInput !== null || u.output !== null || u.reasoning !== null;

/** Tokens as a single count for display and per-hour rates: reasoning is added only when it isn't already in output. */
export function totalTokens(u: TokenUsage): number {
  const n = (x: number | null) => (x && x > 0 ? x : 0);
  return n(u.uncachedInput) + n(u.cachedInput) + n(u.cacheWriteInput) + n(u.output) + (u.reasoningIncludedInOutput ? 0 : n(u.reasoning));
}

/**
 * Price measured tokens with a rate, in `rate.currency`. null when there are no tokens. Cache read/write use their
 * own prices; reasoning is billed at output's rate only when the provider reports it outside output.
 */
export function estimateTokensUsd(usage: TokenUsage, rate: RateEntry, at: number | null): { usd: number; tier: string } | null {
  if (!hasTokens(usage)) return null;
  const per = (tokens: number | null, price: number) => ((tokens && tokens > 0 ? tokens : 0) * price) / 1_000_000;
  const reasoningPrice = rate.reasoningRate ?? rate.output;
  const reasoning = usage.reasoningIncludedInOutput ? 0 : per(usage.reasoning, reasoningPrice);
  const usd = per(usage.uncachedInput, rate.input) + per(usage.cachedInput, rate.cacheRead) + per(usage.cacheWriteInput, rate.cacheWrite) + per(usage.output, rate.output) + reasoning;
  const tier = tierFor(rate, at);
  return { usd: usd * tier.multiplier, tier: tier.label };
}

/** True when a verified rate or a manager override exists for this canonical id. */
function hasRate(model: string, overrides: RateOverrides): boolean {
  return byModel.has(model) || !!overrides[model];
}

/**
 * The canonical model to price a record by: its own id when it has a rate, otherwise one recovered from the id the
 * provider printed (an older record may have stored a bare family). Never invents a version it can't identify.
 */
function pricedModel(record: UsageRecord, overrides: RateOverrides): string {
  if (hasRate(record.model, overrides)) return record.model;
  const fromRaw = record.modelRaw ? modelKey(record.modelRaw) : '';
  return fromRaw && hasRate(fromRaw, overrides) ? fromRaw : record.model;
}

/**
 * Resolve one record: reported cost wins and is labelled as reported; a provider's zero is free only when it said so;
 * otherwise estimate from measured tokens and a verified rate; anything else is unavailable (never zero).
 */
export function resolveUsage(record: UsageRecord, overrides: RateOverrides = {}): ResolvedUsage {
  const model = pricedModel(record, overrides);
  const rate = rateFor(model, overrides) ?? undefined;
  const base = model === record.model ? record : { ...record, model };
  if (base.reportedUsd !== null && base.reportedUsd > 0) return { ...base, kind: 'reported', usd: round4(base.reportedUsd), rate };
  if (base.reportedUsd === 0 && base.free) return { ...base, kind: 'free', usd: 0, rate };
  // A reported 0 with tokens and a known rate is OpenCode's "no rate" placeholder: estimate it instead.
  if (rate) {
    const e = estimateTokensUsd(base.usage, rate, base.at);
    if (e) {
      const resolved: ResolvedUsage = { ...base, kind: 'estimated', usd: round4(e.usd), rate, tier: e.tier };
      if (base.at === null && rate.tiers?.length) {
        // The peak applied: expose [off-peak, peak] so an unknown-time estimate is honest about the spread.
        const peak = Math.max(...rate.tiers.map((t) => t.multiplier));
        const off = Math.min(peak, rate.offPeakMultiplier ?? 1);
        resolved.range = [round4(e.usd * (off / peak)), round4(e.usd)];
      }
      return resolved;
    }
  }
  return { ...base, kind: 'unavailable', usd: 0, rate };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------- deduplication ----------

/** Total tokens as a rough size, to pick the fuller of two records reporting the same message. */
const sizeOf = (r: UsageRecord) => totalTokens(r.usage) + (r.reportedUsd ?? 0);

/**
 * Collapse repeated reports of the same usage. Messages are deduplicated by key (a message seen again replaces the
 * earlier, partial one); cumulative session totals are deduplicated by session, keeping the latest, so a resumed
 * session's lifetime total is never added a second time. A session that has a cumulative total keeps only that,
 * never its individual messages as well.
 */
export function dedupe(records: UsageRecord[]): UsageRecord[] {
  const sessions = new Map<string, UsageRecord>(); // key: session + model, so a session's models stay apart
  const messages = new Map<string, UsageRecord>();
  for (const r of records) {
    if (r.scope === 'session') {
      const k = `${r.sessionId}|${r.model}`;
      const prev = sessions.get(k);
      if (!prev || (r.at ?? 0) >= (prev.at ?? 0) || sizeOf(r) > sizeOf(prev)) sessions.set(k, r);
    } else {
      const prev = messages.get(r.key);
      if (!prev || sizeOf(r) > sizeOf(prev)) messages.set(r.key, r);
    }
  }
  const out: UsageRecord[] = [];
  for (const r of messages.values()) if (!sessions.has(`${r.sessionId}|${r.model}`)) out.push(r);
  for (const r of sessions.values()) out.push(r);
  return out;
}

// ---------- roll-ups ----------

export interface CostRollup {
  reportedUsd: number;
  estimatedUsd: number;
  freeUsd: number;
  totalUsd: number; // reported + estimated (free adds nothing)
  unavailable: number; // records with no usable cost, by count
  records: number;
  coverage: number; // share of records that have a cost (including a genuine zero): 0-1
  partial: boolean; // any record unavailable
  currency: string;
  kind: CostKind | 'mixed' | 'none'; // the provenance of the total ("mixed": reported + estimated)
}

/** The provenance of a set of resolved records, or 'none' when there are none. */
export function kindOfResolved(resolved: ResolvedUsage[]): CostKind | 'mixed' | 'none' {
  const kinds = new Set(resolved.map((r) => r.kind));
  if (!kinds.size) return 'none';
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

/** Sum resolved records, keeping reported and estimated apart so a mixed total can say so. */
export function rollup(resolved: ResolvedUsage[], currency = 'USD'): CostRollup {
  let reported = 0;
  let estimated = 0;
  let unavailable = 0;
  for (const r of resolved) {
    if (r.kind === 'reported') reported += r.usd;
    else if (r.kind === 'estimated') estimated += r.usd;
    else if (r.kind === 'unavailable') unavailable += 1;
  }
  const n = resolved.length;
  return {
    reportedUsd: round4(reported),
    estimatedUsd: round4(estimated),
    freeUsd: 0,
    totalUsd: round4(reported + estimated),
    unavailable,
    records: n,
    coverage: n ? (n - unavailable) / n : 1,
    partial: unavailable > 0,
    currency,
    kind: kindOfResolved(resolved),
  };
}

// ---------- hourly averages ----------

export interface ModelHourRow {
  model: string;
  provider: CostProvider;
  tokens: number;
  tokensPerHour: number | null;
  usd: number;
  usdPerHour: number | null;
  kind: CostKind | 'mixed'; // the dominant provenance of this model's records
  records: number;
  unavailable: number;
  partial: boolean; // some of this model's records had no cost, or history starts inside the window
}

export interface HourlyCost {
  hours: number;
  elapsedHours: number; // wall-clock hours actually covered, idle hours included
  partial: boolean; // history starts inside the window, or some records were unavailable
  rows: ModelHourRow[];
  total: { usdPerHour: number | null; tokensPerHour: number | null; usd: number; tokens: number };
}

/**
 * The last `hours` by model: tokens/hour and USD/hour, divided by the elapsed wall-clock hours of the stated window
 * (idle hours included, so a quiet hour pulls the average down). `historySince` is when the office's record starts;
 * before the window's start it's partial history, and an average over too little time is disclosed rather than shown
 * as a full day's.
 */
export function hourlyByModel(resolved: ResolvedUsage[], now: number, hours = 24, historySince: number | null = null): HourlyCost {
  const windowStart = now - hours * 3_600_000;
  const from = historySince === null ? windowStart : Math.max(windowStart, historySince);
  const elapsedHours = Math.max(0, (now - from) / 3_600_000);
  const partialWindow = historySince !== null && historySince > windowStart;
  const groups = new Map<string, ResolvedUsage[]>();
  for (const r of resolved) {
    if (r.at === null || r.at < windowStart) continue;
    const g = groups.get(r.model) ?? [];
    g.push(r);
    groups.set(r.model, g);
  }
  const rows: ModelHourRow[] = [];
  let allUsd = 0;
  let allTokens = 0;
  let anyUnavailable = false;
  for (const [model, list] of groups) {
    const usd = round4(list.reduce((s, r) => s + r.usd, 0));
    const tokens = list.reduce((s, r) => s + totalTokens(r.usage), 0);
    const unavailable = list.filter((r) => r.kind === 'unavailable').length;
    allUsd += usd;
    allTokens += tokens;
    if (unavailable) anyUnavailable = true;
    rows.push({
      model,
      provider: list[0].provider,
      tokens,
      tokensPerHour: elapsedHours > 0 ? tokens / elapsedHours : null,
      usd,
      usdPerHour: elapsedHours > 0 ? usd / elapsedHours : null,
      kind: kindOf(list),
      records: list.length,
      unavailable,
      partial: unavailable > 0 || partialWindow,
    });
  }
  rows.sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
  return {
    hours,
    elapsedHours,
    partial: partialWindow || anyUnavailable,
    rows,
    total: {
      usd: round4(allUsd),
      tokens: allTokens,
      usdPerHour: elapsedHours > 0 ? allUsd / elapsedHours : null,
      tokensPerHour: elapsedHours > 0 ? allTokens / elapsedHours : null,
    },
  };
}

function kindOf(list: ResolvedUsage[]): CostKind | 'mixed' {
  const kinds = new Set(list.map((r) => r.kind));
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

/** How a cost number is labelled in the UI. */
export function costLabel(kind: CostKind | 'mixed' | 'none'): string {
  switch (kind) {
    case 'reported':
      return 'reported';
    case 'estimated':
      return 'estimated';
    case 'free':
      return 'free';
    case 'unavailable':
      return 'unavailable';
    case 'mixed':
      return 'reported + estimated';
    default:
      return 'no data';
  }
}

/** Parse an ISO date string or epoch ms into ms, or null. */
export function atMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalize a provider's token block, allowing either included-in-input or separate cache/reasoning fields. */
export function normalizeTokens(raw: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; reasoning?: unknown; reasoningIncludedInOutput?: boolean }): TokenUsage {
  return {
    uncachedInput: numOrNull(raw.input),
    output: numOrNull(raw.output),
    cachedInput: numOrNull(raw.cacheRead),
    cacheWriteInput: numOrNull(raw.cacheWrite),
    reasoning: numOrNull(raw.reasoning),
    reasoningIncludedInOutput: raw.reasoningIncludedInOutput ?? true,
  };
}
