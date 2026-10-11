import { describe, expect, it } from 'vitest';
import { budgetAlert, budgetBlocksNewWork, budgetStatus, clampBudgetUsd, MAX_BUDGET_USD, usd } from './budget.ts';

describe('clampBudgetUsd', () => {
  it('keeps whole cents inside the cap, and reads 0 or blank as no budget', () => {
    expect(clampBudgetUsd(10)).toBe(10);
    expect(clampBudgetUsd('12.345')).toBe(12.35);
    expect(clampBudgetUsd(MAX_BUDGET_USD + 1)).toBe(MAX_BUDGET_USD);
    expect(clampBudgetUsd(0)).toBe(0);
    expect(clampBudgetUsd(-5)).toBe(0);
    expect(clampBudgetUsd('')).toBe(0);
    expect(clampBudgetUsd('lots')).toBe(0);
    expect(clampBudgetUsd(undefined)).toBe(0);
  });
});

describe('budgetStatus', () => {
  it('is none without a cap, and never a number when nothing is reported', () => {
    expect(budgetStatus(0, null)).toEqual({ level: 'none', pct: null, spent: null, budget: 0 });
    expect(budgetStatus(10, null)).toEqual({ level: 'ok', pct: null, spent: null, budget: 10 });
  });

  it('reads ok, warning at 80% and over at 100%', () => {
    expect(budgetStatus(10, 7.9)).toMatchObject({ level: 'ok', pct: 79 });
    expect(budgetStatus(10, 8)).toMatchObject({ level: 'warning', pct: 80 });
    expect(budgetStatus(10, 9.5)).toMatchObject({ level: 'warning', pct: 95 });
    expect(budgetStatus(10, 10)).toMatchObject({ level: 'over', pct: 100 });
    expect(budgetStatus(10, 12)).toMatchObject({ level: 'over', pct: 120 });
  });
});

describe('budgetBlocksNewWork', () => {
  it('holds only a floor that is at or over its cap', () => {
    expect(budgetBlocksNewWork(budgetStatus(0, 999))).toBe(false);
    expect(budgetBlocksNewWork(budgetStatus(10, null))).toBe(false);
    expect(budgetBlocksNewWork(budgetStatus(10, 9))).toBe(false);
    expect(budgetBlocksNewWork(budgetStatus(10, 10))).toBe(true);
  });
});

it('writes dollars the office way and says which line was crossed', () => {
  expect(usd(8.5)).toBe('$8.50');
  expect(usd(125.4)).toBe('$125');
  expect(budgetAlert('warning', 2, 'acme/app', 8.5, 10)).toContain('⚠️ Floor 2 (acme/app)');
  expect(budgetAlert('warning', 2, 'acme/app', 8.5, 10)).toContain('over 80%');
  expect(budgetAlert('over', 2, 'acme/app', 10.5, 10)).toContain('🛑');
  expect(budgetAlert('over', 2, 'acme/app', 10.5, 10)).toContain('no new issues start');
});
