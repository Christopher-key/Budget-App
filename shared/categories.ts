import type { ExpenseCategory, Ledger, MonthlyBudget } from './contracts.js';
import { expenseCategories, monthId, parseMoney, validateLedger } from './model.js';

const key = (value: string) => value.toLocaleLowerCase('en-US');

/** The current entry choices; retired definitions remain saved for old records. */
export function activeExpenseCategories(ledger: Ledger): string[] {
  return ledger.expenseCategories?.filter(category => category.isActive).map(category => category.name)
    ?? [...expenseCategories];
}

/** A saved month owns its category list; current definitions never rewrite history. */
export function monthExpenseCategories(month: MonthlyBudget): string[] {
  if (month.expenseCategories !== undefined) return [...month.expenseCategories];
  return [...new Set([...month.periods.flatMap(period =>
    [...period.realistic.expenses, ...period.budgeted.expenses].map(entry => entry.name)),
  ...month.transactions.map(transaction => transaction.category)])];
}

/** Hide retired entry fields without discarding their recorded nonzero amounts. */
export function applyExpenseCategoriesToMonth(ledger: Ledger, month: MonthlyBudget, now = new Date()): MonthlyBudget {
  const result = structuredClone(month);
  if (ledger.expenseCategories === undefined || result.id < monthId(now)) return result;
  const names = activeExpenseCategories(ledger), active = new Set(names);
  result.expenseCategories = names;
  for (const period of result.periods) for (const plan of [period.realistic, period.budgeted]) {
    plan.expenses = plan.expenses.filter(entry => entry.fixedPaymentId || active.has(entry.name)
      || parseMoney(entry.amount) !== 0n);
    for (const name of names) if (!plan.expenses.some(entry => !entry.fixedPaymentId && entry.name === name)) {
      plan.expenses.push({ id: crypto.randomUUID(), name, amount: '' });
    }
  }
  return result;
}

function prepare(input: Ledger): Ledger {
  const ledger = validateLedger(input);
  if (ledger.expenseCategories === undefined) {
    const names = [...new Set([...expenseCategories, ...ledger.months.flatMap(monthExpenseCategories)])];
    ledger.expenseCategories = names.map(name => ({ name, isActive: true }));
  }
  // Freeze every existing field set before current/future definitions change.
  for (const month of ledger.months) month.expenseCategories ??= monthExpenseCategories(month);
  return ledger;
}

function finish(ledger: Ledger, now: Date): Ledger {
  ledger.months = ledger.months.map(month => applyExpenseCategoriesToMonth(ledger, month, now));
  return validateLedger(ledger);
}

export function addExpenseCategory(input: Ledger, name: string, now = new Date()): Ledger {
  const ledger = prepare(input), trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || [...trimmed].length > 80 || /[\p{Cc}\p{Cf}]/u.test(trimmed)) throw new Error('Enter an expense name of 1–80 characters.');
  if (ledger.expenseCategories!.some(category => key(category.name) === key(trimmed))) {
    throw new Error('This expense category already exists. Restore it if it is removed.');
  }
  if (ledger.expenseCategories!.length >= 100) throw new Error('A budget can contain up to 100 expense categories, including removed categories.');
  ledger.expenseCategories!.push({ name: trimmed, isActive: true });
  return finish(ledger, now);
}

export function setExpenseCategoryActive(input: Ledger, name: string, active: boolean, now = new Date()): Ledger {
  const ledger = prepare(input), category = ledger.expenseCategories!.find(category => category.name === name);
  if (!category || typeof active !== 'boolean') throw new Error('Choose an existing expense category.');
  if (!active && ledger.fixedPayments?.some(payment => payment.isApplied && payment.category === name)) {
    throw new Error('Unapply or move fixed payments using this category before removing it.');
  }
  category.isActive = active;
  return finish(ledger, now);
}

/** Definitions shown by management UI without introducing optional ledger fields. */
export function expenseCategoryDefinitions(ledger: Ledger): ExpenseCategory[] {
  return ledger.expenseCategories?.map(category => ({ ...category }))
    ?? expenseCategories.map(name => ({ name, isActive: true }));
}
