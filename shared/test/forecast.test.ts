import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCurrentPlanToForecast, forecastMonthIds, forecastSummary, planningMonth, savePlanningMonth } from '../forecast.js';
import { bucketBalances, emptyLedger, monthSummary, newMonth } from '../model.js';

const now = new Date(2026, 10, 3, 12);
function fixture() {
  const ledger = emptyLedger(now);
  ledger.months[0].periods[0].budgeted.payroll = '1000.10';
  ledger.months[0].periods[1].budgeted.payroll = '1000.20';
  ledger.months[0].periods[0].budgeted.expenses[1].amount = '80.05';
  ledger.months[0].periods[0].realistic.payroll = '900.00';
  return ledger;
}

test('forecast covers exactly four following calendar months across a year boundary', () => {
  assert.deepEqual(forecastMonthIds(now), ['2026-12', '2027-01', '2027-02', '2027-03']);
  assert.deepEqual(forecastMonthIds(new Date(2023, 11, 20)), ['2024-01', '2024-02', '2024-03', '2024-04']);
});

test('previewing forecasts creates no saved months or invented financial amounts', () => {
  const ledger = emptyLedger(now), before = structuredClone(ledger);
  const rows = forecastSummary(ledger, now);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => !row.planned && row.remaining === 0n));
  assert.deepEqual(ledger, before);
  const month = planningMonth(ledger, '2027-03', now);
  assert.equal(month.transactions.length, 0);
  assert.ok(month.periods.every(period => period.realistic.payroll === '' && period.budgeted.payroll === ''));
});

test('copying a current plan preserves the original and copies no actual income, spending or transactions', () => {
  const ledger = fixture(), before = structuredClone(ledger);
  const bucket = { id: crypto.randomUUID(), name: 'Invented goal', target: '500.00', isActive: true };
  ledger.savingsBuckets.push(bucket);
  ledger.months[0].periods[0].budgeted.bucketEntries.push({ id: bucket.id, name: bucket.name, contribution: '30.00', withdrawal: '5.00' });
  ledger.months[0].periods[0].realistic.bucketEntries.push({ id: bucket.id, name: bucket.name, contribution: '20.00', withdrawal: '' });
  ledger.months[0].transactions.push({ id: crypto.randomUUID(), date: now.toISOString(), dayOfMonth: 3, category: 'Home', amount: '12.34', note: 'Synthetic only' });
  const original = structuredClone(ledger), copied = copyCurrentPlanToForecast(ledger, '2026-12', now);
  const future = copied.months.find(month => month.id === '2026-12')!;
  assert.equal(monthSummary(future, 'budgeted').income, 200030n);
  assert.equal(monthSummary(future, 'budgeted').expenses, 8005n);
  assert.equal(monthSummary(future, 'realistic').income, 0n);
  assert.equal(monthSummary(future, 'realistic').expenses, 0n);
  assert.equal(future.transactions.length, 0);
  assert.equal(future.periods[0].budgeted.bucketEntries[0].id, bucket.id);
  assert.notEqual(future.periods[0].budgeted.expenses[0].id, ledger.months[0].periods[0].budgeted.expenses[0].id);
  assert.deepEqual(bucketBalances(copied), bucketBalances(ledger));
  assert.deepEqual(ledger, original);
  assert.deepEqual(copied.months[0], original.months[0]);
  assert.equal(before.months.length, 1);
});

test('an existing forecast, including an explicitly entered zero, is never overwritten by copying', () => {
  const ledger = copyCurrentPlanToForecast(fixture(), '2026-12', now), before = structuredClone(ledger);
  assert.throws(() => copyCurrentPlanToForecast(ledger, '2026-12', now), /already has a plan/);
  assert.deepEqual(ledger, before);
  const zero = fixture(), future = newMonth('2026-12');
  future.periods[0].budgeted.payroll = '0'; zero.months.push(future);
  assert.throws(() => copyCurrentPlanToForecast(zero, '2026-12', now), /already has a plan/);
});

test('copy respects an existing target schedule and preserves its actual records', () => {
  const ledger = fixture(), future = newMonth('2026-12', 'weekly');
  future.paySchedule.days = [1, 8, 15, 22];
  future.periods[3].realistic.extra = '42.50';
  future.transactions.push({ id: crypto.randomUUID(), date: '2026-12-01T12:00:00.000Z', dayOfMonth: 1, category: 'Home', amount: '2.25', note: '' });
  ledger.months.push(future);
  const copied = copyCurrentPlanToForecast(ledger, '2026-12', now).months[1];
  assert.deepEqual(copied.paySchedule, future.paySchedule);
  assert.deepEqual(copied.periods.map(period => period.realistic), future.periods.map(period => period.realistic));
  assert.deepEqual(copied.transactions, future.transactions);
  assert.equal(monthSummary(copied, 'budgeted').income, 200030n);
});

test('copying into fewer target periods combines planned totals without rounding or discarding money', () => {
  const ledger = fixture(), current = newMonth('2026-11', 'weekly');
  current.periods.forEach((period, index) => { period.budgeted.payroll = `${index + 1}.01`; });
  ledger.months = [current, newMonth('2026-12', 'monthly')];
  const future = copyCurrentPlanToForecast(ledger, '2026-12', now).months[1];
  assert.equal(future.periods.length, 1);
  assert.equal(monthSummary(future, 'budgeted').income, 1004n);
  assert.equal(monthSummary(future, 'realistic').income, 0n);
});

test('pay dates invalid in a shorter month are cleared while planned amounts are retained', () => {
  const january = new Date(2027, 0, 10), ledger = emptyLedger(january);
  ledger.months[0].paySchedule.days = [1, 31];
  ledger.months[0].periods[0].budgeted.payroll = '150.00';
  const future = copyCurrentPlanToForecast(ledger, '2027-02', january).months[1];
  assert.deepEqual(future.paySchedule.days, []);
  assert.equal(monthSummary(future, 'budgeted').income, 15000n);
});

test('only an edited forecast is saved, and new months beyond the four-month window are rejected', () => {
  const ledger = fixture(), month = planningMonth(ledger, '2027-03', now);
  month.periods[0].budgeted.savings = '75.25';
  const saved = savePlanningMonth(ledger, month, now);
  assert.equal(saved.months.length, 2);
  assert.equal(saved.months[1].periods[0].budgeted.savings, '75.25');
  assert.throws(() => savePlanningMonth(ledger, newMonth('2027-04'), now));
  assert.throws(() => copyCurrentPlanToForecast(ledger, '2027-04', now));
  assert.equal(ledger.months.length, 1);
});

test('forecast summaries use planned amounts and never present realistic spending as a prediction', () => {
  const ledger = copyCurrentPlanToForecast(fixture(), '2026-12', now);
  ledger.months[1].periods[0].realistic.payroll = '9999.99';
  const first = forecastSummary(ledger, now)[0];
  assert.equal(first.income, 200030n);
  assert.equal(first.remaining, 192025n);
  assert.ok(first.planned);
  assert.ok(forecastSummary(ledger, now).slice(1).every(row => !row.planned));
});

test('invalid amounts fail without mutating saved data, and copying requires an entered current plan', () => {
  const ledger = fixture(), before = structuredClone(ledger), future = planningMonth(ledger, '2026-12', now);
  future.periods[0].budgeted.payroll = '-1';
  assert.throws(() => savePlanningMonth(ledger, future, now));
  assert.deepEqual(ledger, before);
  assert.throws(() => copyCurrentPlanToForecast(emptyLedger(now), '2026-12', now), /Enter the current/);
});
