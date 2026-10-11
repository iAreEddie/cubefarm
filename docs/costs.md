# Costs

The office shows what the coding agents used and what it is worth, whichever CLI ran the session. It never scrapes a
terminal: every number comes from a CLI's structured session data or its own reported figure.

## What is measured

| CLI | Where the numbers come from | Reported cost? |
| --- | --- | --- |
| Claude Code (Agent SDK) | the SDK result's per-model `modelUsage` totals | yes, `costUSD` per model |
| Claude Code (terminal) | its status line (`total_cost_usd`) and the session transcript's assistant turns | yes, the status line total |
| OpenCode | the plugin reads `client.session.messages` and forwards each assistant message's tokens, model and `cost` | yes, per message |
| Codex | the thread's rollout file (`token_count` events) | no: estimated from tokens |

Tokens are normalized so nothing is counted twice: cached input and cache creation are kept apart from uncached input,
and reasoning is added only when a provider reports it outside output. Each record carries a timestamp, a model
(normalized from whatever the CLI printed) and the source it came from.

## Reported, estimated, free, unavailable

- **Reported** — the provider's own figure, labelled as a usage value (for a subscription it is the API-equivalent
  value, not an extra charge).
- **Estimated** — no reported cost, but measured tokens and a *verified* rate: `shared/cost.ts` pins each rate to a
  currency, a source URL and the date it was checked, so a later rate change never rewrites history. DeepSeek's
  off-peak window is applied when the record's time is known; otherwise the peak rate is assumed and a range is shown.
- **Free** — a provider that said, in effect, that the call cost nothing (for example a local model with no tokens).
- **Unavailable** — no tokens or no rate. This is never a zero: a session the office cannot measure does not look free.
  OpenCode's `cost: 0` for a model it has no rate for is treated as a placeholder, not as free.

Models the office has no verified rate for (Codex's Sol ids among them) stay unavailable rather than borrowing a
similarly named model's rate. A manager can supply a rate for a custom or unpublished id to the accounting API
(`rateFor`, `RateOverrides`).

## Where it shows

Mission control's cost screen and the manager's console → **Mission control** show the office's last-24-hour total
with its provenance, each floor's, and, by model, tokens/hour and dollars/hour. The hourly figures divide by the
elapsed wall-clock hours of the window (idle hours included) and say when the office's history starts inside it.

## Deduplication

Usage is deduplicated by session and message. A cumulative session report replaces the previous one, so a resumed
session's lifetime total is never added again, and a message seen again (streaming, or a replayed turn) keeps only its
fuller report.

## Budgets

A floor's budget (`#7`) still counts only *reported* spend: estimates are shown separately and never silently hold
back new work. Missing telemetry blocks nothing.

## Demo

`--demo` seeds a week of made-up usage in three models (Claude reported, DeepSeek estimated, Sol unavailable) so the
boards can be seen offline with no paid calls. The parsers' fixtures live in `server/fixtures/cost/` and are read by
`server/telemetry.test.ts`.
