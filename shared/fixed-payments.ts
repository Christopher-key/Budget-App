import type { ExpenseEntry, FixedPayment, Ledger, MonthlyBudget } from './contracts.js';
import { daysInMonth, monthId, moneyText, newMonth, parseMoney, validateLedger, windows } from './model.js';
import { recordEstimatedPayment, recordPaymentWithInterest } from './payoff.js';
import { activeExpenseCategories, applyExpenseCategoriesToMonth } from './categories.js';

export function appliedFixedPayments(ledger: Ledger, identifier: string): FixedPayment[] {
  return (ledger.fixedPayments ?? []).filter(payment => payment.isApplied && payment.startMonth <= identifier
    && (!payment.endMonth || identifier <= payment.endMonth));
}

/** One snapshotted Budgeted expense, assigned to its due-date pay period. */
export function applyFixedPaymentsToMonth(month: MonthlyBudget, payments: FixedPayment[], now = new Date()): MonthlyBudget {
  const result = structuredClone(month);
  if (result.id < monthId(now)) return result;
  const existing = new Map<string, ExpenseEntry>();
  for (const period of result.periods) {
    for (const entry of period.budgeted.expenses) if (entry.fixedPaymentId) existing.set(entry.fixedPaymentId, entry);
    period.budgeted.expenses = period.budgeted.expenses.filter(entry => !entry.fixedPaymentId);
  }
  const periods = windows(result);
  for (const payment of payments) {
    if (!payment.isApplied || payment.startMonth > result.id || (payment.endMonth && result.id > payment.endMonth)) continue;
    const day = Math.min(payment.dueDay, daysInMonth(result.id));
    const period = periods.find(value => day >= value.startDay && day <= value.endDay);
    if (!period) throw new Error('Choose a valid fixed-payment due day.');
    result.periods[period.index]!.budgeted.expenses.push({
      id: existing.get(payment.id)?.id ?? crypto.randomUUID(), name: payment.category, amount: payment.monthlyAmount,
      fixedPaymentId: payment.id, fixedPaymentName: payment.name, fixedDueDay: payment.dueDay,
    });
  }
  return result;
}

function syncPlans(ledger: Ledger, now: Date): Ledger {
  const current = monthId(now);
  if (!ledger.months.some(month => month.id === current)) ledger.months.push(newMonth(current, ledger.payFrequency));
  ledger.months = ledger.months.map(month => applyExpenseCategoriesToMonth(ledger, applyFixedPaymentsToMonth(month, ledger.fixedPayments ?? [], now), now));
  return validateLedger(ledger);
}

function finishPayoff(payment: FixedPayment, now: Date) {
  if (!payment.payoffBalance.trim() || parseMoney(payment.payoffBalance) !== 0n) return;
  const current = monthId(now);
  if (payment.startMonth > current) payment.isApplied = false;
  else if (!payment.endMonth || payment.endMonth > current) payment.endMonth = current;
}

/** Definitions change current and saved future plans; past snapshots stay intact. */
export function saveFixedPayment(input: Ledger, payment: FixedPayment, now = new Date()): Ledger {
  const ledger = validateLedger(input), payments = ledger.fixedPayments ?? [];
  const saved = structuredClone(payment);
  finishPayoff(saved, now);
  if (saved.isApplied && !activeExpenseCategories(ledger).includes(saved.category)) {
    throw new Error('Restore this expense category or choose an active category before applying the fixed payment.');
  }
  ledger.fixedPayments = [...payments.filter(value => value.id !== payment.id), saved];
  return syncPlans(validateLedger(ledger), now);
}

export function setFixedPaymentApplied(input: Ledger, identifier: string, applied: boolean, now = new Date()): Ledger {
  const ledger = validateLedger(input), payment = ledger.fixedPayments?.find(value => value.id === identifier);
  if (!payment || typeof applied !== 'boolean') throw new Error('Choose an existing fixed payment.');
  payment.isApplied = applied;
  if (applied) finishPayoff(payment, now);
  if (payment.isApplied && !activeExpenseCategories(ledger).includes(payment.category)) {
    throw new Error('Restore this expense category or choose an active category before applying the fixed payment.');
  }
  return syncPlans(ledger, now);
}

/** Update the self-reported payoff tracker only; spending remains in Transactions. */
export function recordFixedPayment(input: Ledger, identifier: string, paid: string, now = new Date(), includedInterest?: string): Ledger {
  const ledger = validateLedger(input), payment = ledger.fixedPayments?.find(value => value.id === identifier);
  if (!payment || !payment.payoffBalance.trim()) throw new Error('Enter a payoff balance before recording a payment.');
  const estimate = includedInterest === undefined
    ? recordEstimatedPayment(payment.payoffBalance, paid, payment.annualRate, payment.rateType)
    : recordPaymentWithInterest(payment.payoffBalance, paid, includedInterest);
  if (estimate.chargedPayment === 0n) throw new Error('This payoff is already complete.');
  payment.payoffBalance = moneyText(estimate.nextBalance);
  payment.history.push({ id: crypto.randomUUID(), date: now.toISOString(), amount: moneyText(estimate.chargedPayment),
    interest: moneyText(estimate.interest), principal: moneyText(estimate.principal), balanceAfter: payment.payoffBalance });
  // Preserve this month's planned expense while stopping later recurring plans.
  finishPayoff(payment, now);
  return syncPlans(ledger, now);
}
