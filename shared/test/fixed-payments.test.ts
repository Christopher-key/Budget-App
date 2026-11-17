import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FixedPayment, Ledger, MonthlyBudget } from '../contracts.js';
import { applySchedule, emptyLedger, monthSummary, newMonth, parseMoney, validateLedger } from '../model.js';
import { copyCurrentPlanToForecast, planningMonth, savePlanningMonth } from '../forecast.js';
import { appliedFixedPayments, applyFixedPaymentsToMonth, recordFixedPayment,
  saveFixedPayment, setFixedPaymentApplied } from '../fixed-payments.js';
import { exportWorkbook } from '../xlsx.js';

const NOW = new Date(2026, 10, 17, 12);
const PAYMENT_ID = '20000000-0000-4000-8000-000000000001';

function payment(overrides: Partial<FixedPayment> = {}): FixedPayment {
  return { id: PAYMENT_ID, name: 'Synthetic car payment', category: 'Car', monthlyAmount: '300',
    dueDay: 20, startMonth: '2026-11', endMonth: '', isApplied: true,
    payoffBalance: '', annualRate: '0', rateType: 'apr', history: [], ...overrides };
}

function fixture(): Ledger {
  const ledger = emptyLedger(NOW);
  const current = ledger.months[0]!;
  current.periods[0]!.budgeted.payroll = '1000';
  current.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Car')!.amount = '50';
  current.periods[0]!.realistic.expenses.find(entry => entry.name === 'Car')!.amount = '7';
  ledger.months.push(newMonth('2026-12'));
  return ledger;
}

const managed = (month: MonthlyBudget) => month.periods.flatMap(period =>
  period.budgeted.expenses.filter(entry => entry.fixedPaymentId));
const cents = (value: string) => parseMoney(value)!;

test('legacy encrypted-ledger content remains valid without introducing fixed-payment fields', () => {
  const ledger = emptyLedger(NOW);
  assert.deepEqual(validateLedger(ledger), ledger);
  assert.equal(Object.hasOwn(validateLedger(ledger), 'fixedPayments'), false);
});

test('unapplied definitions stay out of Home selection and every Budgeted expense total', () => {
  const ledger = saveFixedPayment(fixture(), payment({ isApplied: false }), NOW);
  assert.equal(ledger.fixedPayments!.length, 1);
  assert.equal(appliedFixedPayments(ledger, '2026-11').length, 0);
  assert.equal(managed(ledger.months[0]!).length, 0);
  assert.equal(managed(ledger.months[1]!).length, 0);
  assert.equal(monthSummary(ledger.months[0]!, 'budgeted').expenses, 5000n);
});

test('fixed payments are allocated once to the due-date period with exact monthly totals', () => {
  const original = fixture(), before = structuredClone(original);
  const saved = saveFixedPayment(original, payment(), NOW);
  const current = saved.months[0]!;
  assert.equal(managed(current).length, 1);
  assert.equal(current.periods[0]!.budgeted.expenses.some(entry => entry.fixedPaymentId), false);
  assert.equal(current.periods[1]!.budgeted.expenses.find(entry => entry.fixedPaymentId)!.fixedPaymentName,
    'Synthetic car payment');
  assert.equal(monthSummary(current, 'budgeted').expenses, 35000n);
  assert.equal(monthSummary(current, 'budgeted').remaining, 65000n);
  assert.equal(monthSummary(current, 'realistic').expenses, 700n);
  assert.deepEqual(current.periods.map(period => period.realistic),
    validateLedger(before).months[0]!.periods.map(period => period.realistic));
  assert.deepEqual(original, before);
  const again = applyFixedPaymentsToMonth(current, saved.fixedPayments!, NOW);
  assert.deepEqual(again, current, 'reapplying must not regenerate or duplicate managed entries');
});

test('day 31 clamps to February month end and schedule changes relocate rather than merge fixed costs', () => {
  const now = new Date(2028, 1, 4, 12), definition = payment({ dueDay: 31, startMonth: '2028-02' });
  const first = applyFixedPaymentsToMonth(newMonth('2028-02', 'weekly'), [definition], now);
  assert.equal(first.periods[3]!.budgeted.expenses.filter(entry => entry.fixedPaymentId).length, 1);
  const monthly = applySchedule(first, { frequency: 'monthly', days: [1] });
  assert.equal(managed(monthly).length, 1);
  assert.equal(monthSummary(monthly, 'budgeted').expenses, 30000n);
  const biweekly = applySchedule(monthly, { frequency: 'biWeekly', days: [1, 25] });
  assert.equal(biweekly.periods[0]!.budgeted.expenses.some(entry => entry.fixedPaymentId), false);
  assert.equal(biweekly.periods[1]!.budgeted.expenses.filter(entry => entry.fixedPaymentId).length, 1);
  assert.equal(monthSummary(biweekly, 'budgeted').expenses, 30000n);
  const earlier = applySchedule(biweekly, { frequency: 'biWeekly', days: [1, 15] });
  assert.equal(managed(earlier).length, 1);
  assert.equal(monthSummary(earlier, 'budgeted').expenses, 30000n);
});

test('start/end months control application and a missing current month is prepared on explicit save', () => {
  let ledger = fixture();
  ledger.months = [newMonth('2026-10'), newMonth('2026-12')];
  ledger = saveFixedPayment(ledger, payment({ startMonth: '2026-12', endMonth: '2026-12' }), NOW);
  assert.ok(ledger.months.some(month => month.id === '2026-11'));
  assert.equal(appliedFixedPayments(ledger, '2026-11').length, 0);
  assert.equal(appliedFixedPayments(ledger, '2026-12').length, 1);
  assert.equal(appliedFixedPayments(ledger, '2027-01').length, 0);
  assert.equal(managed(ledger.months.find(month => month.id === '2026-12')!).length, 1);
});

test('edits and unapplying affect current/future plans while historical snapshots and actual records survive', () => {
  const definition = payment({ startMonth: '2026-10' });
  const prior = applyFixedPaymentsToMonth(newMonth('2026-10'), [definition], new Date(2026, 9, 17, 12));
  const ledger = fixture(); ledger.months.unshift(prior); ledger.fixedPayments = [definition];
  const first = saveFixedPayment(ledger, definition, NOW), historical = structuredClone(first.months[0]);
  const changed = saveFixedPayment(first, { ...definition, name: 'Updated synthetic payment', monthlyAmount: '450', dueDay: 5 }, NOW);
  assert.deepEqual(changed.months[0], historical);
  const current = changed.months.find(month => month.id === '2026-11')!;
  assert.equal(current.periods[0]!.budgeted.expenses.find(entry => entry.fixedPaymentId)!.fixedPaymentName,
    'Updated synthetic payment');
  assert.equal(monthSummary(current, 'budgeted').expenses, 50000n);
  assert.equal(monthSummary(current, 'realistic').expenses, 700n);
  const off = setFixedPaymentApplied(changed, PAYMENT_ID, false, NOW);
  assert.deepEqual(off.months[0], historical);
  assert.ok(off.months.filter(month => month.id >= '2026-11').every(month => managed(month).length === 0));
  assert.equal(appliedFixedPayments(off, '2026-11').length, 0);
});

test('recording a payoff payment updates only the payoff tracker with interest-aware remaining balance', () => {
  const ledger = saveFixedPayment(fixture(), payment({ monthlyAmount: '100', payoffBalance: '1000', annualRate: '12' }), NOW);
  const monthsBefore = structuredClone(ledger.months);
  const recorded = recordFixedPayment(ledger, PAYMENT_ID, '100', NOW);
  const value = recorded.fixedPayments![0]!;
  assert.equal(cents(value.payoffBalance), 91000n);
  assert.equal(value.history.length, 1);
  assert.equal(cents(value.history[0]!.amount), 10000n);
  assert.equal(cents(value.history[0]!.interest), 1000n);
  assert.equal(cents(value.history[0]!.principal), 9000n);
  assert.equal(cents(value.history[0]!.balanceAfter), 91000n);
  assert.deepEqual(recorded.months, monthsBefore, 'a tracker event must not manufacture spending or revise the plan');
  assert.equal(ledger.fixedPayments![0]!.history.length, 0);
});

test('final payoff caps the payment, keeps this month planned, and stops future applied payments', () => {
  const ledger = saveFixedPayment(fixture(), payment({ monthlyAmount: '100', payoffBalance: '50', annualRate: '12' }), NOW);
  const recorded = recordFixedPayment(ledger, PAYMENT_ID, '100', NOW);
  const value = recorded.fixedPayments![0]!;
  assert.equal(cents(value.payoffBalance), 0n);
  assert.equal(cents(value.history[0]!.amount), 5050n);
  assert.equal(cents(value.history[0]!.principal), 5000n);
  assert.equal(value.endMonth, '2026-11');
  assert.equal(managed(recorded.months.find(month => month.id === '2026-11')!).length, 1);
  assert.equal(managed(recorded.months.find(month => month.id === '2026-12')!).length, 0);
  assert.equal(appliedFixedPayments(recorded, '2026-12').length, 0);
  assert.ok(recorded.months.every(month => month.transactions.length === 0));
});

test('a zero statement balance stops future plans and an early completed payoff cannot create an invalid date range', () => {
  const paid = saveFixedPayment(fixture(), payment({ payoffBalance: '0' }), NOW);
  assert.equal(paid.fixedPayments![0]!.endMonth, '2026-11');
  assert.equal(appliedFixedPayments(paid, '2026-12').length, 0);
  const future = saveFixedPayment(fixture(), payment({ startMonth: '2026-12', payoffBalance: '50', annualRate: '0' }), NOW);
  const completed = recordFixedPayment(future, PAYMENT_ID, '100', NOW);
  assert.equal(completed.fixedPayments![0]!.isApplied, false);
  assert.equal(completed.fixedPayments![0]!.payoffBalance, '0.00');
  assert.doesNotThrow(() => validateLedger(completed));
  assert.equal(appliedFixedPayments(completed, '2026-12').length, 0);
  const reapplied = setFixedPaymentApplied(completed, PAYMENT_ID, true, NOW);
  assert.equal(reapplied.fixedPayments![0]!.isApplied, false);
  assert.equal(appliedFixedPayments(reapplied, '2026-12').length, 0);
});

test('a recorded principal-only payment changes the tracker without touching Realistic spending', () => {
  const saved = saveFixedPayment(fixture(), payment({ monthlyAmount: '100', payoffBalance: '1000', annualRate: '12' }), NOW);
  const first = recordFixedPayment(saved, PAYMENT_ID, '100', NOW);
  const extra = recordFixedPayment(first, PAYMENT_ID, '100', NOW, '0');
  assert.equal(extra.fixedPayments![0]!.payoffBalance, '810.00');
  assert.equal(extra.fixedPayments![0]!.history[1]!.interest, '0.00');
  assert.equal(extra.fixedPayments![0]!.history[1]!.principal, '100.00');
  assert.deepEqual(extra.months, first.months);
});

test('invalid payoff records never mutate the saved definitions or actual records', () => {
  const untracked = saveFixedPayment(fixture(), payment(), NOW), before = structuredClone(untracked);
  assert.throws(() => recordFixedPayment(untracked, PAYMENT_ID, '100', NOW));
  assert.deepEqual(untracked, before);
  const tooSmall = saveFixedPayment(fixture(), payment({ payoffBalance: '1000', annualRate: '100' }), NOW);
  const original = structuredClone(tooSmall);
  for (const amount of ['0', '-1', '0.001', '1']) {
    assert.throws(() => recordFixedPayment(tooSmall, PAYMENT_ID, amount, NOW));
  }
  assert.deepEqual(tooSmall, original);
});

test('strict ledger validation rejects invalid definitions and linked expense metadata', () => {
  const base = fixture();
  for (const overrides of [
    { monthlyAmount: '0' }, { monthlyAmount: '-1' }, { monthlyAmount: '1.001' },
    { dueDay: 32 }, { dueDay: 0 }, { category: 'Not a predefined category' },
    { startMonth: '2026-13' }, { endMonth: '2026-10' }, { annualRate: '100.0001' },
    { rateType: 'other' }, { name: 'bad\u0000name' }, { unexpectedCredential: 'not-a-real-credential' },
  ]) {
    const input = { ...base, fixedPayments: [{ ...payment(), ...overrides }] };
    assert.throws(() => validateLedger(input), JSON.stringify(overrides));
  }
  assert.throws(() => validateLedger({ ...base, fixedPayments: [payment(), payment()] }));
  const valid = saveFixedPayment(base, payment(), NOW);
  for (const change of ['realistic', 'missing-reference', 'partial-metadata', 'duplicate-monthly-line'] as const) {
    const value = structuredClone(valid), current = value.months[0]!, entry = structuredClone(managed(current)[0]!);
    if (change === 'realistic') current.periods[0]!.realistic.expenses.push(entry);
    if (change === 'missing-reference') entry.fixedPaymentId = '20000000-0000-4000-8000-000000000099';
    if (change === 'partial-metadata') delete entry.fixedDueDay;
    if (change === 'duplicate-monthly-line') {
      entry.id = crypto.randomUUID(); current.periods[0]!.budgeted.expenses.push(entry);
    } else if (change !== 'realistic') {
      current.periods[1]!.budgeted.expenses = current.periods[1]!.budgeted.expenses.map(item => item.fixedPaymentId ? entry : item);
    }
    assert.throws(() => validateLedger(value), change);
  }
  const prototype = JSON.parse(JSON.stringify(payment()));
  Object.defineProperty(prototype, '__proto__', { value: {}, enumerable: true });
  assert.throws(() => validateLedger({ ...base, fixedPayments: [prototype] }));
});

test('forecast copy retains one current managed payment and preserves raw manual typing', () => {
  const ledger = saveFixedPayment(fixture(), payment(), NOW);
  const copied = copyCurrentPlanToForecast(ledger, '2026-12', NOW);
  const future = copied.months.find(month => month.id === '2026-12')!;
  assert.equal(managed(future).length, 1);
  assert.equal(monthSummary(future, 'budgeted').income, 100000n);
  assert.equal(monthSummary(future, 'budgeted').expenses, 35000n);
  const edited = planningMonth(copied, '2026-12', NOW);
  edited.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Electric' && !entry.fixedPaymentId)!.amount = '3.';
  const saved = savePlanningMonth(copied, edited, NOW);
  assert.equal(saved.months.find(month => month.id === '2026-12')!.periods[0]!.budgeted.expenses
    .find(entry => entry.name === 'Electric' && !entry.fixedPaymentId)!.amount, '3.');
  assert.equal(managed(saved.months.find(month => month.id === '2026-12')!).length, 1);
});

test('Excel category and monthly totals include applied payments exactly once without exporting private linkage IDs', () => {
  const ledger = saveFixedPayment(fixture(), payment(), NOW), before = structuredClone(ledger);
  const bytes = exportWorkbook(ledger, { monthIds: ['2026-11'], includeNotes: false, createdAt: NOW });
  const directory = mkdtempSync(join(tmpdir(), 'budget-fixed-payment-export-'));
  try {
    const path = join(directory, 'synthetic.xlsx'); writeFileSync(path, bytes);
    const inspected = spawnSync('python3', [fileURLToPath(new URL('./validate_xlsx.py', import.meta.url)), path],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(inspected.status, 0, inspected.stderr);
    const report = JSON.parse(inspected.stdout) as { sheets: Record<string, { cells: Record<string, string | null> }> };
    const monthly = report.sheets['Monthly Summary']!.cells;
    const expenseColumn = Object.entries(monthly).find(([reference, label]) => /^[A-Z]+1$/.test(reference) && label === 'Budgeted Expenses')![0].replace(/1$/, '');
    assert.equal(Number(monthly[expenseColumn + '2']), 350);
    assert.equal(Buffer.from(bytes).toString('utf8').includes(PAYMENT_ID), false);
    assert.deepEqual(ledger, before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
