import type { FixedPayment, FixedPaymentRecord, Ledger, MonthlyBudget } from './contracts.js';
import { daysInMonth, monthId, moneyText, newMonth, parseMoney, validateLedger, windows } from './model.js';
import { recordEstimatedPayment, recordPaymentWithInterest } from './payoff.js';
import { activeExpenseCategories, applyExpenseCategoriesToMonth } from './categories.js';

export function appliedFixedPayments(ledger: Ledger, identifier: string): FixedPayment[] {
  return (ledger.fixedPayments ?? []).filter(payment => payment.isApplied && payment.startMonth <= identifier
    && (!payment.endMonth || identifier <= payment.endMonth));
}

/** Definitions are reminders. Only explicit monthly entry creates a planned cost. */
export function applyFixedPaymentsToMonth(month: MonthlyBudget, _payments: FixedPayment[], _now = new Date()): MonthlyBudget {
  return structuredClone(month);
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

/** Definition edits retain every entered monthly plan and actual record. */
export function saveFixedPayment(input: Ledger, payment: FixedPayment, now = new Date()): Ledger {
  const ledger = validateLedger(input), payments = ledger.fixedPayments ?? [];
  const saved = structuredClone(payment);
  const previous = payments.find(value => value.id === payment.id);
  finishPayoff(saved, now);
  if (saved.isApplied && !activeExpenseCategories(ledger).includes(saved.category)) {
    throw new Error('Restore this expense category or choose an active category before applying the fixed payment.');
  }
  ledger.fixedPayments = [...payments.filter(value => value.id !== payment.id), saved];
  const normalized = validateLedger(ledger);
  const normalizedSaved = normalized.fixedPayments!.find(value => value.id === saved.id.toLowerCase())!;
  if (previous && JSON.stringify(previous.history) !== JSON.stringify(normalizedSaved.history)) {
    throw new Error('Use the monthly payment entry to change or undo a recorded payment.');
  }
  return syncPlans(normalized, now);
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
  // Preserve every entered plan while stopping later reminders.
  finishPayoff(payment, now);
  return syncPlans(ledger, now);
}

function paymentIn(ledger: Ledger, identifier: string): FixedPayment {
  const payment = ledger.fixedPayments?.find(value => value.id === identifier);
  if (!payment) throw new Error('Choose an existing fixed payment.');
  return payment;
}

function positiveAmount(value: string): bigint {
  const parsed = parseMoney(value);
  if (parsed === null || parsed <= 0n) throw new Error('Enter a positive payment amount.');
  return parsed;
}

function editableBudgetMonth(identifier: string, now: Date): void {
  daysInMonth(identifier);
  const current = monthId(now);
  const ordinal = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5));
  const distance = ordinal(identifier) - ordinal(current);
  if (distance < 0 || distance > 4) throw new Error('Choose the current month or one of the next four months.');
}

function requireAvailable(ledger: Ledger, payment: FixedPayment, identifier: string): void {
  if (!appliedFixedPayments(ledger, identifier).some(value => value.id === payment.id)) {
    throw new Error('Apply this fixed payment for the selected month before entering an amount.');
  }
  if (!activeExpenseCategories(ledger).includes(payment.category)) {
    throw new Error('Restore this expense category or choose an active category before applying the fixed payment.');
  }
}

/** Enter or replace one monthly Budgeted amount. Zero clears that monthly entry. */
export function setFixedPaymentBudget(input: Ledger, identifier: string, budgetMonth: string, value: string, now = new Date()): Ledger {
  const ledger = validateLedger(input), payment = paymentIn(ledger, identifier);
  editableBudgetMonth(budgetMonth, now);
  const parsed = parseMoney(value);
  if (parsed === null) throw new Error('Enter a non-negative payment amount.');
  let month = ledger.months.find(value => value.id === budgetMonth);
  const existing = month?.periods.flatMap(period => period.budgeted.expenses).find(entry => entry.fixedPaymentId === identifier);
  if (parsed === 0n) {
    if (month) for (const period of month.periods) period.budgeted.expenses = period.budgeted.expenses.filter(entry => entry.fixedPaymentId !== identifier);
    return validateLedger(ledger);
  }
  if (existing) existing.amount = moneyText(parsed);
  else {
    requireAvailable(ledger, payment, budgetMonth);
    if (!month) {
      month = applyExpenseCategoriesToMonth(ledger, newMonth(budgetMonth, ledger.payFrequency), now);
      ledger.months.push(month);
    }
    const day = Math.min(payment.dueDay, daysInMonth(budgetMonth));
    const period = windows(month).find(value => day >= value.startDay && day <= value.endDay)!;
    month.periods[period.index]!.budgeted.expenses.push({ id: crypto.randomUUID(), name: payment.category,
      amount: moneyText(parsed), fixedPaymentId: payment.id, fixedPaymentName: payment.name, fixedDueDay: payment.dueDay });
  }
  return validateLedger(ledger);
}

export interface FixedPaymentExpenseInput { monthID: string; date: string; amount: string; interest?: string }

function actualDate(budgetMonth: string, date: string, now: Date): string {
  const current = monthId(now);
  if (budgetMonth !== current) throw new Error('Record actual fixed payments in the current month.');
  const today = `${current}-${String(now.getDate()).padStart(2, '0')}`;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== budgetMonth ||
      Number(date.slice(8)) < 1 || Number(date.slice(8)) > daysInMonth(budgetMonth) || date > today) {
    throw new Error('Choose a valid date in this month that is not in the future.');
  }
  return `${date}T12:00:00.000Z`;
}

function restoreTrackedPayment(payment: FixedPayment, record: FixedPaymentRecord): void {
  const latest = [...payment.history].reverse().find(value => value.kind !== 'recurring');
  if (latest?.id !== record.id || !payment.payoffBalance.trim() ||
      parseMoney(record.balanceAfter ?? '') !== parseMoney(payment.payoffBalance)) {
    throw new Error('Only the latest payment can be changed while its remaining balance is unchanged.');
  }
  payment.payoffBalance = moneyText(parseMoney(payment.payoffBalance)! + parseMoney(record.principal!)!);
  if (record.previousEndMonth !== undefined && payment.endMonth === record.budgetMonth &&
      (!record.previousEndMonth || record.previousEndMonth >= payment.startMonth)) payment.endMonth = record.previousEndMonth;
}

/** One explicit actual expense updates Realistic spending and its payoff tracker together. */
export function recordFixedPaymentExpense(input: Ledger, identifier: string, entry: FixedPaymentExpenseInput, now = new Date()): Ledger {
  const ledger = validateLedger(input), payment = paymentIn(ledger, identifier);
  const date = actualDate(entry.monthID, entry.date, now), paid = positiveAmount(entry.amount);
  let month = ledger.months.find(value => value.id === entry.monthID);
  const existing = payment.history.find(record => record.budgetMonth === entry.monthID);
  const previousTransaction = month?.transactions.find(transaction => transaction.id === existing?.id);
  if (!existing) requireAvailable(ledger, payment, entry.monthID);
  if (existing && existing.kind !== 'recurring') restoreTrackedPayment(payment, existing);
  const record: FixedPaymentRecord = { id: existing?.id ?? crypto.randomUUID(), date, amount: moneyText(paid), budgetMonth: entry.monthID };
  const tracked = existing ? existing.kind !== 'recurring' : payment.payoffBalance.trim() !== '';
  if (tracked) {
    const balance = parseMoney(payment.payoffBalance), interest = parseMoney(entry.interest ?? '');
    if (entry.interest === undefined || !entry.interest.trim() || interest === null) {
      throw new Error('Confirm the interest included in this payment; use 0 for a principal-only payment.');
    }
    if (balance === null || balance <= 0n) throw new Error('This payoff is already complete.');
    if (paid > balance + interest) throw new Error('The payment cannot exceed the remaining balance plus confirmed interest.');
    if (paid < interest) throw new Error('The payment must cover its confirmed interest.');
    const principal = paid - interest, nextBalance = balance - principal;
    record.interest = moneyText(interest); record.principal = moneyText(principal);
    record.balanceAfter = moneyText(nextBalance);
    payment.payoffBalance = record.balanceAfter;
    if (nextBalance === 0n && (!payment.endMonth || payment.endMonth > entry.monthID)) {
      record.previousEndMonth = payment.endMonth;
      payment.endMonth = entry.monthID;
    }
  } else record.kind = 'recurring';
  if (!month) { month = applyExpenseCategoriesToMonth(ledger, newMonth(entry.monthID, ledger.payFrequency), now); ledger.months.push(month); }
  if (existing) payment.history[payment.history.findIndex(value => value.id === existing.id)] = record;
  else payment.history.push(record);
  const transaction = { id: record.id, date, dayOfMonth: Number(entry.date.slice(8)),
    category: previousTransaction?.category ?? payment.category, amount: record.amount,
    note: previousTransaction?.note ?? payment.name, fixedPaymentId: payment.id };
  const transactionIndex = month.transactions.findIndex(value => value.id === record.id);
  if (transactionIndex < 0) month.transactions.push(transaction);
  else month.transactions[transactionIndex] = transaction;
  return validateLedger(ledger);
}

/** Undo both sides of a monthly actual entry, restoring only its recorded principal. */
export function undoFixedPaymentExpense(input: Ledger, identifier: string, budgetMonth: string, now = new Date()): Ledger {
  const ledger = validateLedger(input), payment = paymentIn(ledger, identifier);
  if (budgetMonth !== monthId(now)) throw new Error('Undo actual fixed payments in the current month.');
  const record = payment.history.find(value => value.budgetMonth === budgetMonth);
  if (!record) throw new Error('There is no fixed-payment expense to undo for this month.');
  if (record.kind !== 'recurring') restoreTrackedPayment(payment, record);
  payment.history = payment.history.filter(value => value.id !== record.id);
  const month = ledger.months.find(value => value.id === budgetMonth)!;
  month.transactions = month.transactions.filter(value => value.id !== record.id);
  return validateLedger(ledger);
}
