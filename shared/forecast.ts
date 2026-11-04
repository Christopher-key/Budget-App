import type { BudgetPlan, Ledger, MonthlyBudget, PayFrequency } from './contracts.js';
import { applySchedule, daysInMonth, monthId, monthSummary, newMonth, validateLedger } from './model.js';

/** Four calendar months AFTER the current month, including year rollovers. */
export function forecastMonthIds(now = new Date()): string[] {
  const current = monthId(now), base = Number(current.slice(0, 4)) * 12 + Number(current.slice(5)) - 1;
  return Array.from({ length: 4 }, (_, index) => {
    const value = base + index + 1, year = Math.floor(value / 12);
    if (year < 1 || year > 9999) throw new Error('The forecast date is outside the supported calendar.');
    return `${String(year).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
  });
}

/** Missing forecast months are previews until an explicit edit or copy saves one. */
export function planningMonth(ledger: Ledger, id: string, now = new Date()): MonthlyBudget {
  const existing = ledger.months.find(month => month.id === id);
  if (existing) return structuredClone(existing);
  if (![monthId(now), ...forecastMonthIds(now)].includes(id)) throw new Error('Choose the current month or one of the next four months.');
  return newMonth(id, ledger.payFrequency);
}

export function savePlanningMonth(ledger: Ledger, month: MonthlyBudget, now = new Date()): Ledger {
  const result = structuredClone(ledger), index = result.months.findIndex(value => value.id === month.id);
  if (index < 0) {
    if (![monthId(now), ...forecastMonthIds(now)].includes(month.id)) throw new Error('Choose one of the next four months.');
    result.months.push(structuredClone(month));
  } else result.months[index] = structuredClone(month);
  // Check the complete ledger without replacing an in-progress entry such as
  // "3" or "3." with "3.00" after each keystroke. Encryption normalizes the
  // persisted representation separately.
  validateLedger(result);
  return result;
}

function hasInput(plan: BudgetPlan): boolean {
  return [plan.payroll, plan.extra, plan.savings, plan.savingsWithdrawn,
    ...plan.expenses.map(entry => entry.amount),
    ...plan.bucketEntries.flatMap(entry => [entry.contribution, entry.withdrawal])].some(value => value.trim() !== '');
}

export function hasBudgetedPlan(month: MonthlyBudget): boolean {
  return month.periods.some(period => hasInput(period.budgeted));
}

const defaultDays = (frequency: PayFrequency): number[] => frequency === 'monthly' ? [1]
  : frequency === 'weekly' ? [1, 8, 15, 22] : [1, 15];

/** Copy plans only. Existing forecast amounts are never overwritten. */
export function copyCurrentPlanToForecast(ledger: Ledger, id: string, now = new Date()): Ledger {
  if (!forecastMonthIds(now).includes(id)) throw new Error('Choose one of the next four months.');
  const input = validateLedger(ledger), source = input.months.find(month => month.id === monthId(now));
  if (!source || !hasBudgetedPlan(source)) throw new Error('Enter the current month’s Budgeted plan before copying it.');
  const existing = input.months.find(month => month.id === id);
  if (existing && hasBudgetedPlan(existing)) throw new Error('This month already has a plan. Edit its amounts below.');
  let copied = newMonth(id, source.paySchedule.frequency);
  copied.periods.forEach((period, index) => {
    period.budgeted = structuredClone(source.periods[index].budgeted);
    period.budgeted.expenses = period.budgeted.expenses.map(entry => ({ ...entry, id: crypto.randomUUID() }));
  });
  // Invalid paydays in shorter months are cleared for explicit selection.
  copied.paySchedule.days = source.paySchedule.days.every(day => day <= daysInMonth(id))
    ? [...source.paySchedule.days] : [];
  if (existing) {
    // Preserve the target's actual records and chosen pay dates. Resize only the
    // detached copied plans, combining amounts when fewer periods are needed.
    if (copied.periods.length !== existing.periods.length) {
      copied = applySchedule(copied, { frequency: existing.paySchedule.frequency,
        days: defaultDays(existing.paySchedule.frequency) });
    }
    const target = structuredClone(existing);
    target.periods = target.periods.map((period, index) => ({ ...period, budgeted: copied.periods[index].budgeted }));
    return savePlanningMonth(input, target, now);
  }
  return savePlanningMonth(input, copied, now);
}

export function forecastSummary(ledger: Ledger, now = new Date()) {
  return forecastMonthIds(now).map(id => {
    const month = ledger.months.find(value => value.id === id);
    if (!month) return { id, planned: false, income: 0n, expenses: 0n, savings: 0n, withdrawn: 0n, remaining: 0n };
    return { id, planned: hasBudgetedPlan(month), ...monthSummary(month, 'budgeted') };
  });
}
