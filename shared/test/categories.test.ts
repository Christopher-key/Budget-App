import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixedPayment } from '../contracts.js';
import { activeExpenseCategories, addExpenseCategory, applyExpenseCategoriesToMonth,
  monthExpenseCategories, setExpenseCategoryActive } from '../categories.js';
import { applySchedule, emptyLedger, expenseCategories, monthSummary, newMonth, validateLedger } from '../model.js';
import { copyCurrentPlanToForecast, planningMonth, savePlanningMonth } from '../forecast.js';
import { saveFixedPayment, setFixedPaymentApplied } from '../fixed-payments.js';

const now = new Date(2026, 10, 17, 12);

test('legacy documents keep their shape until category management is used', () => {
  const legacy = emptyLedger(now);
  assert.deepEqual(validateLedger(legacy), legacy);
  assert.deepEqual(activeExpenseCategories(legacy), expenseCategories);
  assert.deepEqual(applyExpenseCategoriesToMonth(legacy, legacy.months[0]!, now), legacy.months[0]);
  assert.equal(Object.hasOwn(legacy, 'expenseCategories'), false);
});

test('new categories affect current and future plans without adding fields to historical months', () => {
  const before = emptyLedger(now); before.months.unshift(newMonth('2026-10')); before.months.push(newMonth('2026-12'));
  const historical = structuredClone(before.months[0]!);
  const saved = addExpenseCategory(before, 'Pets', now);
  assert.ok(activeExpenseCategories(saved).includes('Pets'));
  assert.deepEqual(saved.months[0]!.periods, historical.periods);
  assert.equal(monthExpenseCategories(saved.months[0]!).includes('Pets'), false);
  for (const month of saved.months.slice(1)) for (const period of month.periods) {
    for (const kind of ['budgeted', 'realistic'] as const) {
      assert.equal(period[kind].expenses.filter(entry => entry.name === 'Pets').length, 1);
      assert.equal(period[kind].expenses.find(entry => entry.name === 'Pets')!.amount, '');
    }
  }
  assert.equal(monthExpenseCategories(planningMonth(saved, '2027-01', now)).includes('Pets'), true);
  assert.deepEqual(before.months[0], historical, 'the input ledger must not be mutated');
});

test('removing a category keeps recorded spending and entered plans in exact totals', () => {
  const before = emptyLedger(now); before.months.unshift(newMonth('2026-10'));
  const current = before.months[1]!;
  current.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Home')!.amount = '900';
  current.periods[0]!.realistic.expenses.find(entry => entry.name === 'Home')!.amount = '850';
  current.transactions.push({ id: crypto.randomUUID(), date: now.toISOString(), dayOfMonth: 17, category: 'Home', amount: '25', note: '' });
  const saved = setExpenseCategoryActive(before, 'Home', false, now), month = saved.months[1]!;
  assert.equal(monthExpenseCategories(month).includes('Home'), false);
  assert.equal(monthExpenseCategories(saved.months[0]!).includes('Home'), true);
  assert.equal(monthSummary(month, 'budgeted').expenses, 90000n);
  assert.equal(monthSummary(month, 'realistic').expenses, 87500n);
  assert.equal(month.transactions.length, 1);
  assert.ok(month.periods[0]!.budgeted.expenses.some(entry => entry.name === 'Home'));
  assert.equal(month.periods[1]!.budgeted.expenses.some(entry => entry.name === 'Home'), false);
  const future = planningMonth(saved, '2026-12', now);
  assert.equal(future.periods.some(period => period.budgeted.expenses.some(entry => entry.name === 'Home')), false);
  assert.equal(monthSummary(future, 'budgeted').expenses, 0n);
});

test('restoring a category preserves its retained amount and does not rewrite history', () => {
  let saved = addExpenseCategory(emptyLedger(now), 'Pets', now);
  saved.months[0]!.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Pets')!.amount = '80';
  saved = setExpenseCategoryActive(saved, 'Pets', false, now);
  const restored = setExpenseCategoryActive(saved, 'Pets', true, now);
  assert.equal(restored.months[0]!.periods[0]!.budgeted.expenses.filter(entry => entry.name === 'Pets').length, 1);
  assert.equal(restored.months[0]!.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Pets')!.amount, '80.00');
  assert.throws(() => addExpenseCategory(saved, 'pets', now));
});

test('custom categories can hold self-reported transactions and fixed monthly payments', () => {
  let ledger = addExpenseCategory(emptyLedger(now), 'Student loan', now);
  const payment: FixedPayment = { id: crypto.randomUUID(), name: 'Synthetic loan', category: 'Student loan', monthlyAmount: '100',
    dueDay: 20, startMonth: '2026-11', endMonth: '', isApplied: true, payoffBalance: '', annualRate: '0', rateType: 'apr', history: [] };
  ledger = saveFixedPayment(ledger, payment, now);
  ledger.months[0]!.transactions.push({ id: crypto.randomUUID(), date: now.toISOString(), dayOfMonth: 17, category: 'Student loan', amount: '40', note: '' });
  assert.doesNotThrow(() => validateLedger(ledger));
  assert.equal(monthSummary(ledger.months[0]!, 'budgeted').expenses, 10000n);
  assert.throws(() => setExpenseCategoryActive(ledger, 'Student loan', false, now), /Unapply or move/);
  ledger = setFixedPaymentApplied(ledger, payment.id, false, now);
  ledger = setExpenseCategoryActive(ledger, 'Student loan', false, now);
  assert.throws(() => setFixedPaymentApplied(ledger, payment.id, true, now), /Restore this expense category/);
  assert.equal(monthSummary(ledger.months[0]!, 'realistic').expenses, 4000n);
});

test('changing pay schedules creates only this month’s active fields and retains retired amounts', () => {
  let ledger = emptyLedger(now);
  ledger.months[0]!.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Home')!.amount = '25';
  ledger = addExpenseCategory(ledger, 'Pets', now);
  ledger = setExpenseCategoryActive(ledger, 'Home', false, now);
  const monthly = applySchedule(ledger.months[0]!, { frequency: 'monthly', days: [1] });
  const weekly = applySchedule(monthly, { frequency: 'weekly', days: [1, 8, 15, 22] });
  assert.equal(monthSummary(weekly, 'budgeted').expenses, 2500n);
  assert.equal(weekly.periods[3]!.budgeted.expenses.some(entry => entry.name === 'Pets'), true);
  assert.equal(weekly.periods[3]!.budgeted.expenses.some(entry => entry.name === 'Home'), false);
  assert.equal(monthExpenseCategories(weekly).includes('Home'), false);
});

test('copying a current plan never reintroduces retired planned costs into a future month', () => {
  let ledger = emptyLedger(now);
  const current = ledger.months[0]!;
  current.periods[0]!.budgeted.payroll = '1000';
  current.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Home')!.amount = '700';
  current.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Grocery')!.amount = '50';
  ledger = setExpenseCategoryActive(ledger, 'Home', false, now);
  const copied = copyCurrentPlanToForecast(ledger, '2026-12', now), target = copied.months.find(month => month.id === '2026-12')!;
  assert.equal(monthSummary(copied.months[0]!, 'budgeted').expenses, 75000n);
  assert.equal(monthSummary(target, 'budgeted').expenses, 5000n);
  assert.equal(target.periods.some(period => period.budgeted.expenses.some(entry => entry.name === 'Home')), false);
  assert.equal(monthExpenseCategories(target).includes('Home'), false);
});

test('saved forecast entries and raw typing are preserved while retired rows stay out of new periods', () => {
  let ledger = addExpenseCategory(emptyLedger(now), 'Pets', now);
  const future = planningMonth(ledger, '2026-12', now);
  future.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Home')!.amount = '12';
  ledger = savePlanningMonth(ledger, future, now);
  ledger = setExpenseCategoryActive(ledger, 'Home', false, now);
  assert.equal(monthSummary(ledger.months.find(month => month.id === '2026-12')!, 'budgeted').expenses, 1200n);
  assert.throws(() => copyCurrentPlanToForecast(ledger, '2026-12', now));
  const edit = planningMonth(ledger, '2026-12', now);
  edit.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Pets')!.amount = '3.';
  const saved = savePlanningMonth(ledger, edit, now);
  assert.equal(saved.months.find(month => month.id === '2026-12')!.periods[0]!.budgeted.expenses.find(entry => entry.name === 'Pets')!.amount, '3.');
});

test('category schema rejects malformed, duplicate, overlong and oversized definitions', () => {
  const legacy = emptyLedger(now);
  for (const name of ['', '  ', 'Pets\ncare', 'x'.repeat(81), 'home']) assert.throws(() => addExpenseCategory(legacy, name, now));
  const saved = addExpenseCategory(legacy, 'Pets', now);
  const duplicate = structuredClone(saved); duplicate.expenseCategories!.push({ name: 'pets', isActive: true });
  assert.throws(() => validateLedger(duplicate));
  const snapshot = structuredClone(saved); snapshot.months[0]!.expenseCategories!.push('Pets');
  assert.throws(() => validateLedger(snapshot));
  const excessive = structuredClone(saved); excessive.expenseCategories = Array.from({ length: 101 }, (_, i) => ({ name: 'Category ' + i, isActive: true }));
  assert.throws(() => validateLedger(excessive));
});
