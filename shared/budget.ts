import type { BudgetLevel } from './types.ts';

// Per-floor budgets (#7): the manager caps a floor's reported spend; the office warns at 80% and, at 100%, holds
// that floor's new issues until the cap is raised. Work already in flight (running agents, QA, fixes) carries on.
// Pure, so the server and its tests read a floor's budget the same way.

/** The most a budget may be, in dollars. */
export const MAX_BUDGET_USD = 1_000_000;

/** A floor's cap from the console or the API: whole cents, 0 to MAX_BUDGET_USD; 0 or blank means no cap. */
export function clampBudgetUsd(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_BUDGET_USD, Math.round(n * 100) / 100);
}

/** Dollars as the office writes them: "$4.20", "$125". */
export const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

/** How a floor stands against its cap. */
export interface BudgetStatus {
  level: BudgetLevel;
  pct: number | null; // 0-100; null without a cap, or without any reported spend
  spent: number | null; // null: no session has reported a cost, so it's "not reported" (never a zero)
  budget: number;
}

/** A floor's cap and reported spend as a status. `spent` null means nothing has been reported, never a zero. */
export function budgetStatus(budget: number, spent: number | null): BudgetStatus {
  if (!(budget > 0)) return { level: 'none', pct: null, spent, budget: 0 };
  if (spent === null) return { level: 'ok', pct: null, spent: null, budget };
  const pct = Math.round((spent / budget) * 100);
  return { level: pct >= 100 ? 'over' : pct >= 80 ? 'warning' : 'ok', pct, spent, budget };
}

/** True when a floor at 100% of its cap must hold new issues. A floor with no cap, or nothing reported, never blocks. */
export const budgetBlocksNewWork = (s: BudgetStatus) => s.level === 'over';

/** The office's phone message when a floor crosses a budget line. */
export function budgetAlert(level: 'warning' | 'over', floor: number, fullName: string, spent: number, budget: number): string {
  const base = `Floor ${floor} (${fullName}) has reported ${usd(spent)} against its ${usd(budget)} budget`;
  return level === 'over'
    ? `🛑 ${base}: no new issues start on it until you raise the budget. Work in flight — QA, fixes, running agents — carries on.`
    : `⚠️ ${base} (over 80%). At 100% it stops starting new issues until you raise the budget.`;
}
