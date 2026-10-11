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

  it('crosses 80% and 100% on the unrounded ratio, rounding only for display', () => {
    // just below / exactly at / just above 80%
    expect(budgetStatus(10, 7.99)).toMatchObject({ level: 'ok' });
    expect(budgetStatus(10, 8)).toMatchObject({ level: 'warning' });
    expect(budgetStatus(10, 8.01)).toMatchObject({ level: 'warning' });
    // just below / exactly at / just above 100%
    expect(budgetStatus(10, 9.99)).toMatchObject({ level: 'warning' }); // not over: 99.9% rounds to 100% for display only
    expect(budgetStatus(10, 10)).toMatchObject({ level: 'over' });
    expect(budgetStatus(10, 10.01)).toMatchObject({ level: 'over' });
    // pct is the rounded display value, whatever the level
    expect(budgetStatus(10, 7.99).pct).toBe(80);
    expect(budgetStatus(10, 9.99).pct).toBe(100);
  });
});

describe('budgetBlocksNewWork', () => {
  it('holds only a floor that is at or over its cap, on the unrounded ratio', () => {
    expect(budgetBlocksNewWork(budgetStatus(0, 999))).toBe(false);
    expect(budgetBlocksNewWork(budgetStatus(10, null))).toBe(false); // unknown spend never blocks on its own
    expect(budgetBlocksNewWork(budgetStatus(10, 9))).toBe(false);
    expect(budgetBlocksNewWork(budgetStatus(10, 9.99))).toBe(false); // just below the cap is not the cap
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
