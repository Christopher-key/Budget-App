import test from 'node:test';
import assert from 'node:assert/strict';
import type { FixedPayment, Ledger } from '../contracts.js';
import { emptyLedger, monthSummary, validateLedger } from '../model.js';
import { copyCurrentPlanToForecast, forecastSummary, planningMonth } from '../forecast.js';
import { applyFixedPaymentsToMonth, recordFixedPayment, recordFixedPaymentExpense, saveFixedPayment,
  setFixedPaymentApplied, setFixedPaymentBudget, undoFixedPaymentExpense } from '../fixed-payments.js';
import { setExpenseCategoryActive } from '../categories.js';

const NOW = new Date(2026, 10, 17, 12);
const ID = '20000000-0000-4000-8000-000000000001';
const definition = (extra: Partial<FixedPayment> = {}): FixedPayment => ({ id: ID, name: 'Example payment', category: 'Car',
  monthlyAmount: '100', dueDay: 20, startMonth: '2026-11', endMonth: '', isApplied: true,
  payoffBalance: '', annualRate: '12', rateType: 'apr', history: [], ...extra });
const fixture = (extra: Partial<FixedPayment> = {}): Ledger => saveFixedPayment(emptyLedger(NOW), definition(extra), NOW);
const actual = (ledger: Ledger, amount = '100', interest?: string) => recordFixedPaymentExpense(ledger, ID,
  { monthID: '2026-11', date: '2026-11-17', amount, ...(interest === undefined ? {} : { interest }) }, NOW);
const fixedRows = (ledger: Ledger, id = '2026-11') => ledger.months.find(month => month.id === id)!.periods.flatMap(period =>
  period.budgeted.expenses.filter(entry => entry.fixedPaymentId));

test('applied reminders create no Budgeted or Realistic costs in stored months or forecast previews', () => {
  const ledger = fixture(), before = structuredClone(ledger);
  assert.equal(monthSummary(ledger.months[0]!, 'budgeted').expenses, 0n);
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 0n);
  assert.deepEqual(applyFixedPaymentsToMonth(ledger.months[0]!, ledger.fixedPayments!, NOW), ledger.months[0]);
  assert.equal(monthSummary(planningMonth(ledger, '2026-12', NOW), 'budgeted').expenses, 0n);
  assert.ok(forecastSummary(ledger, NOW).every(row => !row.planned && row.expenses === 0n));
  assert.deepEqual(ledger, before);
});

test('monthly Budgeted input is a replacement, stays independent from Actual, and zero clears only that month', () => {
  const original = fixture(), before = structuredClone(original);
  let ledger = setFixedPaymentBudget(original, ID, '2026-11', '75', NOW);
  const rowId = fixedRows(ledger)[0]!.id;
  ledger = setFixedPaymentBudget(ledger, ID, '2026-11', '80.25', NOW);
  assert.equal(fixedRows(ledger).length, 1);
  assert.equal(fixedRows(ledger)[0]!.id, rowId);
  ledger = setFixedPaymentBudget(ledger, ID, '2026-12', '120', NOW);
  ledger = actual(ledger, '90');
  assert.equal(monthSummary(ledger.months[0]!, 'budgeted').expenses, 8025n);
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 9000n);
  ledger = setFixedPaymentBudget(ledger, ID, '2026-11', '0', NOW);
  assert.equal(fixedRows(ledger).length, 0);
  assert.equal(fixedRows(ledger, '2026-12')[0]!.amount, '120.00');
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 9000n);
  assert.deepEqual(original, before);
  for (const month of ['2026-10', '2027-04']) assert.throws(() => setFixedPaymentBudget(ledger, ID, month, '100', NOW));
});

test('retained monthly plans can be edited and cleared after a reminder or category is removed', () => {
  let ledger = setFixedPaymentBudget(fixture(), ID, '2026-11', '80', NOW);
  ledger = setFixedPaymentApplied(ledger, ID, false, NOW);
  ledger = setExpenseCategoryActive(ledger, 'Car', false, NOW);
  ledger = setFixedPaymentBudget(ledger, ID, '2026-11', '70', NOW);
  assert.equal(fixedRows(ledger)[0]!.amount, '70.00');
  assert.throws(() => setFixedPaymentBudget(ledger, ID, '2026-12', '100', NOW));
  assert.equal(fixedRows(setFixedPaymentBudget(ledger, ID, '2026-11', '0', NOW)).length, 0);
});

test('recurring actual entry has one paired expense, no invented payoff fields, and is safely replaced or undone', () => {
  const original = fixture();
  let ledger = actual(original, '90');
  const first = ledger.fixedPayments![0]!.history[0]!;
  assert.equal(first.kind, 'recurring');
  assert.equal(first.budgetMonth, '2026-11');
  for (const field of ['interest', 'principal', 'balanceAfter', 'previousEndMonth']) assert.equal(Object.hasOwn(first, field), false);
  assert.equal(ledger.months[0]!.transactions[0]!.id, first.id);
  assert.equal(ledger.months[0]!.transactions[0]!.fixedPaymentId, ID);
  ledger = recordFixedPaymentExpense(ledger, ID, { monthID: '2026-11', date: '2026-11-16', amount: '95' }, NOW);
  assert.equal(ledger.fixedPayments![0]!.history.length, 1);
  assert.equal(ledger.months[0]!.transactions.length, 1);
  assert.equal(ledger.months[0]!.transactions[0]!.id, first.id);
  assert.equal(ledger.months[0]!.transactions[0]!.dayOfMonth, 16);
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 9500n);
  const undone = undoFixedPaymentExpense(ledger, ID, '2026-11', NOW);
  assert.equal(undone.months[0]!.transactions.length, 0);
  assert.equal(undone.fixedPayments![0]!.history.length, 0);
  assert.equal(undone.fixedPayments![0]!.payoffBalance, '');
  assert.deepEqual(original.fixedPayments![0]!.history, []);
});

test('adding a payoff balance later does not turn an existing recurring expense into a principal payment', () => {
  let ledger = actual(fixture(), '90');
  ledger = saveFixedPayment(ledger, { ...ledger.fixedPayments![0]!, payoffBalance: '500' }, NOW);
  ledger = actual(ledger, '100');
  assert.equal(ledger.fixedPayments![0]!.history[0]!.kind, 'recurring');
  assert.equal(ledger.fixedPayments![0]!.payoffBalance, '500.00');
  ledger = undoFixedPaymentExpense(ledger, ID, '2026-11', NOW);
  assert.equal(ledger.fixedPayments![0]!.payoffBalance, '500.00');
});

test('tracked actual replaces monthly spending and replays principal against the original balance once', () => {
  const original = fixture({ payoffBalance: '1000' });
  let ledger = actual(original, '100', '10');
  const recordId = ledger.fixedPayments![0]!.history[0]!.id;
  assert.equal(ledger.fixedPayments![0]!.payoffBalance, '910.00');
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 10000n);
  ledger = actual(ledger, '120', '9');
  const record = ledger.fixedPayments![0]!.history[0]!;
  assert.equal(record.id, recordId);
  assert.equal(record.principal, '111.00');
  assert.equal(record.balanceAfter, '889.00');
  assert.equal(ledger.fixedPayments![0]!.payoffBalance, '889.00');
  assert.equal(ledger.months[0]!.transactions.length, 1);
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 12000n);
  assert.deepEqual(actual(ledger, '120', '9'), ledger, 'repeated entry must be idempotent');
  ledger = undoFixedPaymentExpense(ledger, ID, '2026-11', NOW);
  assert.equal(ledger.fixedPayments![0]!.payoffBalance, '1000.00');
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 0n);
  assert.equal(original.fixedPayments![0]!.payoffBalance, '1000.00');
});

test('actual payment requires confirmed interest, supports interest-only, and rejects uncapped overpayment', () => {
  const ledger = fixture({ payoffBalance: '100' }), before = structuredClone(ledger);
  for (const interest of [undefined, '', '-1', '1.001']) assert.throws(() => actual(ledger, '20', interest), /interest/i);
  assert.throws(() => actual(ledger, '110', '1'), /cannot exceed/);
  assert.throws(() => actual(ledger, '1', '2'), /cover.*interest/);
  const recorded = actual(ledger, '1', '1');
  assert.equal(recorded.fixedPayments![0]!.history[0]!.principal, '0.00');
  assert.equal(recorded.fixedPayments![0]!.payoffBalance, '100.00');
  assert.equal(monthSummary(recorded.months[0]!, 'realistic').expenses, 100n);
  assert.equal(undoFixedPaymentExpense(recorded, ID, '2026-11', NOW).fixedPayments![0]!.payoffBalance, '100.00');
  assert.deepEqual(ledger, before);
});

test('final actual payoff snapshots the previous end month and undo restores it without deleting manual plans', () => {
  let ledger = fixture({ payoffBalance: '100', endMonth: '2027-02' });
  ledger = setFixedPaymentBudget(ledger, ID, '2026-12', '100', NOW);
  const completed = actual(ledger, '101', '1');
  assert.equal(completed.fixedPayments![0]!.endMonth, '2026-11');
  assert.equal(completed.fixedPayments![0]!.history[0]!.previousEndMonth, '2027-02');
  assert.equal(fixedRows(completed, '2026-12')[0]!.amount, '100.00');
  const edited = actual(completed, '50', '1');
  assert.equal(edited.fixedPayments![0]!.payoffBalance, '51.00');
  assert.equal(edited.fixedPayments![0]!.endMonth, '2027-02');
  const undone = undoFixedPaymentExpense(completed, ID, '2026-11', NOW);
  assert.equal(undone.fixedPayments![0]!.payoffBalance, '100.00');
  assert.equal(undone.fixedPayments![0]!.endMonth, '2027-02');
  const rescheduled = saveFixedPayment(completed, { ...completed.fixedPayments![0]!, payoffBalance: '0', endMonth: '2026-10', startMonth: '2026-10' }, NOW);
  assert.equal(undoFixedPaymentExpense(rescheduled, ID, '2026-11', NOW).fixedPayments![0]!.endMonth, '2026-10');
});

test('a later tracker payment or changed statement balance prevents unsafe tracked update and undo', () => {
  const ledger = actual(fixture({ payoffBalance: '1000' }), '100', '10');
  const later = recordFixedPayment(ledger, ID, '50', NOW, '0');
  assert.throws(() => actual(later, '90', '10'), /latest payment/);
  assert.throws(() => undoFixedPaymentExpense(later, ID, '2026-11', NOW), /latest payment/);
  const changed = saveFixedPayment(ledger, { ...ledger.fixedPayments![0]!, payoffBalance: '800' }, NOW);
  assert.throws(() => actual(changed, '90', '10'), /remaining balance/);
  assert.throws(() => undoFixedPaymentExpense(changed, ID, '2026-11', NOW), /remaining balance/);
});

test('actual dates must belong to the current month and cannot be future calendar dates', () => {
  const ledger = fixture(), before = structuredClone(ledger);
  for (const [monthID, date] of [['2026-12', '2026-12-01'], ['2026-10', '2026-10-17'],
    ['2026-11', '2026-11-18'], ['2026-11', '2026-11-31'], ['2026-11', '2026-11-00'],
    ['2026-11', '2026-11-17T12:00:00Z']]) {
    assert.throws(() => recordFixedPaymentExpense(ledger, ID, { monthID, date, amount: '100' }, NOW));
  }
  assert.deepEqual(ledger, before);
});

test('schema requires matching history and transaction owner, id, month, date, day and amount in both directions', () => {
  const ledger = actual(fixture({ payoffBalance: '1000' }), '100', '10');
  const changes: ((value: Ledger) => void)[] = [
    value => { value.months[0]!.transactions = []; },
    value => { value.fixedPayments![0]!.history = []; },
    value => { delete value.months[0]!.transactions[0]!.fixedPaymentId; },
    value => { value.months[0]!.transactions[0]!.fixedPaymentId = crypto.randomUUID(); },
    value => { value.months[0]!.transactions[0]!.id = crypto.randomUUID(); },
    value => { value.months[0]!.transactions[0]!.amount = '99'; },
    value => { value.months[0]!.transactions[0]!.date = '2026-11-16T12:00:00.000Z'; },
    value => { value.months[0]!.transactions[0]!.dayOfMonth = 16; },
    value => { value.fixedPayments![0]!.history[0]!.budgetMonth = '2026-12'; },
    value => { value.fixedPayments![0]!.history[0]!.amount = '99'; },
    value => { value.fixedPayments![0]!.history[0]!.principal = '89'; },
    value => { value.fixedPayments![0]!.history[0]!.kind = 'recurring'; },
  ];
  changes.forEach((change, index) => { const invalid = structuredClone(ledger); change(invalid); assert.throws(() => validateLedger(invalid), String(index)); });
  const duplicate = structuredClone(ledger), record = { ...duplicate.fixedPayments![0]!.history[0]!, id: crypto.randomUUID() };
  duplicate.fixedPayments![0]!.history.push(record);
  duplicate.months[0]!.transactions.push({ ...duplicate.months[0]!.transactions[0]!, id: record.id });
  assert.throws(() => validateLedger(duplicate));
  const recurring = actual(fixture()); recurring.fixedPayments![0]!.history[0]!.principal = '0';
  assert.throws(() => validateLedger(recurring));
});

test('definition edits preserve paid records and their expense snapshots and cannot rewrite history', () => {
  const ledger = actual(fixture({ payoffBalance: '1000' }), '100', '10'), prior = structuredClone(ledger);
  const changed = saveFixedPayment(ledger, { ...ledger.fixedPayments![0]!, name: 'Changed name', category: 'Home',
    monthlyAmount: '150', annualRate: '6', dueDay: 3 }, NOW);
  assert.deepEqual(changed.fixedPayments![0]!.history, prior.fixedPayments![0]!.history);
  assert.deepEqual(changed.months, prior.months);
  assert.equal(actual(changed, '90', '10').months[0]!.transactions[0]!.category, 'Car');
  const altered = structuredClone(changed.fixedPayments![0]!); altered.history[0]!.interest = '9'; altered.history[0]!.principal = '91';
  assert.throws(() => saveFixedPayment(changed, altered, NOW), /monthly payment entry/);
});

test('explicit forecast copy includes eligible manually entered fixed costs once and never replaces target input', () => {
  let ledger = setFixedPaymentBudget(fixture(), ID, '2026-11', '85', NOW);
  const copied = copyCurrentPlanToForecast(ledger, '2026-12', NOW);
  assert.equal(fixedRows(copied, '2026-12').length, 1);
  assert.equal(fixedRows(copied, '2026-12')[0]!.amount, '85.00');
  assert.equal(monthSummary(copied.months.find(month => month.id === '2026-12')!, 'realistic').expenses, 0n);
  assert.throws(() => copyCurrentPlanToForecast(copied, '2026-12', NOW), /already has a plan/);
  ledger = setFixedPaymentApplied(ledger, ID, false, NOW);
  const unapplied = copyCurrentPlanToForecast(ledger, '2026-12', NOW);
  assert.equal(fixedRows(unapplied, '2026-12').length, 0);
  assert.equal(fixedRows(unapplied)[0]!.amount, '85.00');
});
