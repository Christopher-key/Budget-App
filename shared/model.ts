import type {
  BudgetPlan, BucketEntry, ExpenseEntry, ExportAudit, Ledger, MonthlyBudget,
  PayFrequency, PeriodBudget, ReportedExpense, SavingsBucket,
} from './contracts.js';

export const expenseCategories = [
  'Home', 'Electric', 'Gas', 'Credit Card', 'Misc.', 'Car', 'Insurance', 'Phone', 'Going-out', 'Grocery',
];
export const MAX_MONEY_CENTS = 999_999_999_999_999n;
export const MAX_LEDGER_BYTES = 1_048_576;
export interface BudgetWindow { index: number; startDay: number; endDay: number; payDay: number | null; title: string }
export interface BudgetSummary { income: bigint; expenses: bigint; savings: bigint; withdrawn: bigint; remaining: bigint }
export interface CategoryWarning { category: string; remaining: bigint; level: 'approaching' | 'reached' | 'exceeded' }

/** Parse entered dollars into exact cents. Empty input is zero; invalid input is never silently zero. */
export function parseMoney(input: string): bigint | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return 0n;
  if (text.length > 32 || !/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) return null;
  const [whole = '', fraction = ''] = text.split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= MAX_MONEY_CENTS ? cents : null;
}

export function moneyText(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function formatMoney(cents: bigint): string {
  const text = moneyText(cents < 0n ? -cents : cents);
  const [whole, fraction] = text.split('.');
  return `${cents < 0n ? '-' : ''}$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

function amount(input: string): bigint {
  const value = parseMoney(input);
  if (value === null) throw new Error('Correct invalid monetary entries.');
  return value;
}
const blank = (value: string): boolean => value.trim() === '';
const countFor = (frequency: PayFrequency): number => ({ monthly: 1, biWeekly: 2, weekly: 4 })[frequency];

export function emptyPlan(): BudgetPlan {
  return {
    payroll: '', extra: '', savings: '', savingsWithdrawn: '',
    expenses: expenseCategories.map(name => ({ id: crypto.randomUUID(), name, amount: '' })), bucketEntries: [],
  };
}

export function monthId(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date.');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function parts(identifier: string): { year: number; month: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(identifier)) throw new Error('Invalid calendar month.');
  const year = Number(identifier.slice(0, 4)), month = Number(identifier.slice(5));
  if (year < 1) throw new Error('Invalid calendar year.');
  return { year, month };
}
export function daysInMonth(identifier: string): number {
  const { year, month } = parts(identifier);
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function newMonth(id: string, frequency: PayFrequency = 'biWeekly'): MonthlyBudget {
  const { year, month } = parts(id);
  if (!Object.hasOwn({ monthly: 1, biWeekly: 1, weekly: 1 }, frequency)) throw new Error('Invalid pay frequency.');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, 1); date.setUTCHours(12, 0, 0, 0);
  return {
    id, date: date.toISOString(), periods: Array.from({ length: countFor(frequency) }, () => ({ realistic: emptyPlan(), budgeted: emptyPlan() })),
    paySchedule: { frequency, days: [] }, transactions: [],
  };
}

export function emptyLedger(now = new Date()): Ledger {
  return { schemaVersion: 1, months: [newMonth(monthId(now))], savingsBuckets: [], payFrequency: 'biWeekly', exportHistory: [] };
}

export function windows(month: MonthlyBudget): BudgetWindow[] {
  const count = countFor(month.paySchedule.frequency);
  if (!count) throw new Error('Invalid pay frequency.');
  const dayCount = daysInMonth(month.id), chosen = [...month.paySchedule.days].sort((a, b) => a - b);
  const configured = chosen.length === count && new Set(chosen).size === count && chosen.every(day => Number.isInteger(day) && day >= 1 && day <= dayCount);
  const starts = configured ? [1, ...chosen.slice(1)]
    : month.paySchedule.frequency === 'monthly' ? [1] : month.paySchedule.frequency === 'weekly' ? [1, 8, 15, 22] : [1, 15];
  return starts.map((startDay, index) => {
    const endDay = starts[index + 1] === undefined ? dayCount : starts[index + 1]! - 1;
    return { index, startDay, endDay, payDay: configured ? chosen[index]! : null, title: `${startDay}–${endDay}` };
  });
}

export function transactionsIn(month: MonthlyBudget, window: BudgetWindow): ReportedExpense[] {
  return month.transactions.filter(transaction => transaction.dayOfMonth >= window.startDay && transaction.dayOfMonth <= window.endDay);
}

export function summary(plan: BudgetPlan, transactions: ReportedExpense[] = []): BudgetSummary {
  const income = amount(plan.payroll) + amount(plan.extra);
  const expenses = plan.expenses.reduce((total, entry) => total + amount(entry.amount), 0n)
    + transactions.reduce((total, entry) => total + amount(entry.amount), 0n);
  const savings = amount(plan.savings) + plan.bucketEntries.reduce((total, entry) => total + amount(entry.contribution), 0n);
  const withdrawn = amount(plan.savingsWithdrawn) + plan.bucketEntries.reduce((total, entry) => total + amount(entry.withdrawal), 0n);
  return { income, expenses, savings, withdrawn, remaining: income + withdrawn - expenses - savings };
}

export function monthSummary(month: MonthlyBudget, kind: 'realistic' | 'budgeted'): BudgetSummary {
  const total: BudgetSummary = { income: 0n, expenses: 0n, savings: 0n, withdrawn: 0n, remaining: 0n };
  for (const period of month.periods) {
    const value = summary(period[kind]);
    for (const key of Object.keys(total) as (keyof BudgetSummary)[]) total[key] += value[key];
  }
  if (kind === 'realistic') {
    const logged = month.transactions.reduce((sum, transaction) => sum + amount(transaction.amount), 0n);
    total.expenses += logged; total.remaining -= logged;
  }
  return total;
}

export function bucketBalances(ledger: Ledger): Map<string, bigint> {
  const balances = new Map<string, bigint>(ledger.savingsBuckets.map(bucket => [bucket.id, 0n]));
  for (const month of ledger.months) for (const period of month.periods) for (const entry of period.realistic.bucketEntries) {
    balances.set(entry.id, (balances.get(entry.id) ?? 0n) + amount(entry.contribution) - amount(entry.withdrawal));
  }
  return balances;
}

function addInput(first: string, second: string): string {
  return blank(first) && blank(second) ? '' : moneyText(amount(first) + amount(second));
}
function combine(first: BudgetPlan, second: BudgetPlan): BudgetPlan {
  const result = structuredClone(first);
  for (const key of ['payroll', 'extra', 'savings', 'savingsWithdrawn'] as const) result[key] = addInput(first[key], second[key]);
  for (const entry of second.expenses) {
    const current = result.expenses.find(item => item.name === entry.name);
    if (current) current.amount = addInput(current.amount, entry.amount);
    else result.expenses.push(structuredClone(entry));
  }
  for (const entry of second.bucketEntries) {
    const current = result.bucketEntries.find(item => item.id === entry.id);
    if (current) {
      current.contribution = addInput(current.contribution, entry.contribution);
      current.withdrawal = addInput(current.withdrawal, entry.withdrawal);
    } else result.bucketEntries.push(structuredClone(entry));
  }
  return result;
}

/** Change section count without discarding contributions, withdrawals, or spending. */
export function applySchedule(month: MonthlyBudget, schedule: MonthlyBudget['paySchedule']): MonthlyBudget {
  const normalized = validateSchedule(schedule, month.id);
  if (normalized.days.length !== countFor(normalized.frequency)) throw new Error('Choose every pay date before saving.');
  const result = structuredClone(month), desired = countFor(normalized.frequency);
  if (desired < result.periods.length) {
    const last = result.periods[desired - 1]!;
    for (const extra of result.periods.slice(desired)) {
      last.realistic = combine(last.realistic, extra.realistic);
      last.budgeted = combine(last.budgeted, extra.budgeted);
    }
    result.periods = result.periods.slice(0, desired);
  } else while (result.periods.length < desired) result.periods.push({ realistic: emptyPlan(), budgeted: emptyPlan() });
  result.paySchedule = normalized;
  // Check combined field limits after consolidation rather than silently round or overflow.
  for (const period of result.periods) { validatePlan(period.realistic, undefined); validatePlan(period.budgeted, undefined); }
  return result;
}

export function categoryWarnings(month: MonthlyBudget, window: BudgetWindow): CategoryWarning[] {
  const period = month.periods[window.index];
  if (!period) return [];
  const totals = (entries: ExpenseEntry[]) => {
    const map = new Map<string, { cents: bigint; entered: boolean; valid: boolean }>();
    for (const entry of entries) {
      const value = map.get(entry.name) ?? { cents: 0n, entered: false, valid: true };
      value.entered ||= !blank(entry.amount);
      const parsed = parseMoney(entry.amount);
      if (parsed === null) value.valid = false; else value.cents += parsed;
      map.set(entry.name, value);
    }
    return map;
  };
  const limits = totals(period.budgeted.expenses), actual = totals(period.realistic.expenses);
  const invalid = new Set<string>(), logged = new Map<string, bigint>();
  for (const transaction of transactionsIn(month, window)) {
    const parsed = parseMoney(transaction.amount);
    if (parsed === null || parsed <= 0n) invalid.add(transaction.category);
    else logged.set(transaction.category, (logged.get(transaction.category) ?? 0n) + parsed);
  }
  const names = [...expenseCategories.filter(name => limits.has(name)), ...[...limits.keys()].filter(name => !expenseCategories.includes(name)).sort()];
  const result: CategoryWarning[] = [];
  for (const category of names) {
    const limit = limits.get(category)!, spent = actual.get(category);
    if (!limit.entered || !limit.valid || spent?.valid === false || invalid.has(category)) continue;
    const used = (spent?.cents ?? 0n) + (logged.get(category) ?? 0n);
    const level = used > limit.cents ? 'exceeded' : limit.cents > 0n && used === limit.cents ? 'reached'
      : limit.cents > 0n && used * 10n >= limit.cents * 7n ? 'approaching' : null;
    if (level) result.push({ category, remaining: limit.cents - used, level });
  }
  return result;
}

// Validation is deliberately independent of UI checks: every API save uses it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badKeys = new Set(['__proto__', 'prototype', 'constructor']);
function fail(): never { throw new Error('Invalid budget data.'); }
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || badKeys.has(key) || !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) fail();
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number, fallback = false): unknown[] {
  if (value === undefined && fallback) return [];
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail();
  return value.toLowerCase();
}
function name(value: unknown, max = 80): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\p{Cc}\p{Cf}]/u.test(value)) fail();
  return value.trim();
}
function money(value: unknown, fallback = false): string {
  if (value === undefined && fallback) return '';
  if (typeof value !== 'string') fail();
  const result = parseMoney(value);
  if (result === null) fail();
  return value.trim() ? moneyText(result) : '';
}
function frequency(value: unknown): PayFrequency {
  if (value !== 'monthly' && value !== 'biWeekly' && value !== 'weekly') fail();
  return value;
}
function integer(value: unknown, low: number, high: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < low || Number(value) > high) fail();
  return value as number;
}
function unique<T>(values: T[], key: (value: T) => string): void {
  if (new Set(values.map(key)).size !== values.length) fail();
}
function isoDate(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40) fail();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) fail();
  const identifier = `${match[1]}-${match[2]}`;
  if (Number(match[3]) < 1 || Number(match[3]) > daysInMonth(identifier) ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 ||
      (match[9] !== undefined && (Number(match[9]) > 14 || Number(match[10]) > 59 || (Number(match[9]) === 14 && Number(match[10]) !== 0)))) fail();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail();
  return date.toISOString();
}
function validateSchedule(value: unknown, month: string): MonthlyBudget['paySchedule'] {
  const input = object(value, ['frequency', 'days']);
  const type = frequency(input.frequency), maximum = daysInMonth(month);
  const days = array(input.days, 4).map(day => integer(day, 1, maximum));
  if (new Set(days).size !== days.length || (days.length !== 0 && days.length !== countFor(type))) fail();
  return { frequency: type, days: days.sort((a, b) => a - b) };
}
function validatePlan(value: unknown, bucketIds: Set<string> | undefined): BudgetPlan {
  const p = object(value, ['payroll', 'extra', 'savings', 'savingsWithdrawn', 'expenses', 'bucketEntries']);
  const expenses: ExpenseEntry[] = array(p.expenses, 1000).map(value => {
    const entry = object(value, ['id', 'name', 'amount']);
    return { id: id(entry.id), name: name(entry.name), amount: money(entry.amount) };
  });
  unique(expenses, entry => entry.id);
  const bucketEntries: BucketEntry[] = array(p.bucketEntries, 200, true).map(value => {
    const entry = object(value, ['id', 'name', 'contribution', 'withdrawal']);
    const bucketId = id(entry.id);
    if (bucketIds && !bucketIds.has(bucketId)) fail();
    return { id: bucketId, name: name(entry.name, 60), contribution: money(entry.contribution), withdrawal: money(entry.withdrawal) };
  });
  unique(bucketEntries, entry => entry.id);
  return { payroll: money(p.payroll), extra: money(p.extra), savings: money(p.savings),
    savingsWithdrawn: money(p.savingsWithdrawn, true), expenses, bucketEntries };
}

/** Validate and normalize a detached copy. User ownership is never accepted in the document. */
export function validateLedger(value: unknown): Ledger {
  const root = object(value, ['schemaVersion', 'months', 'savingsBuckets', 'payFrequency', 'exportHistory']);
  if (root.schemaVersion !== 1) fail();
  const savingsBuckets: SavingsBucket[] = array(root.savingsBuckets, 200, true).map(value => {
    const bucket = object(value, ['id', 'name', 'target', 'isActive']);
    const target = money(bucket.target);
    if (amount(target) <= 0n || typeof bucket.isActive !== 'boolean') fail();
    return { id: id(bucket.id), name: name(bucket.name, 60), target, isActive: bucket.isActive };
  });
  unique(savingsBuckets, bucket => bucket.id);
  unique(savingsBuckets, bucket => bucket.name.toLocaleLowerCase('en-US'));
  const bucketIds = new Set(savingsBuckets.map(bucket => bucket.id));
  let transactionCount = 0;
  const transactionIds = new Set<string>();
  const months: MonthlyBudget[] = array(root.months, 1200).map(value => {
    const month = object(value, ['id', 'date', 'periods', 'paySchedule', 'transactions']);
    if (typeof month.id !== 'string') fail();
    const identifier = month.id;
    parts(identifier);
    const paySchedule = validateSchedule(month.paySchedule, identifier);
    const periods: PeriodBudget[] = array(month.periods, 4).map(value => {
      const period = object(value, ['realistic', 'budgeted']);
      return { realistic: validatePlan(period.realistic, bucketIds), budgeted: validatePlan(period.budgeted, bucketIds) };
    });
    if (periods.length !== countFor(paySchedule.frequency)) fail();
    const transactions: ReportedExpense[] = array(month.transactions, 10_000, true).map(value => {
      if (++transactionCount > 10_000) fail();
      const tx = object(value, ['id', 'date', 'dayOfMonth', 'category', 'amount', 'note']);
      const txId = id(tx.id);
      if (transactionIds.has(txId)) fail();
      transactionIds.add(txId);
      const txAmount = money(tx.amount);
      if (amount(txAmount) <= 0n || (tx.note !== undefined && (typeof tx.note !== 'string' || tx.note.length > 4000))) fail();
      return { id: txId, date: isoDate(tx.date), dayOfMonth: integer(tx.dayOfMonth, 1, daysInMonth(identifier)),
        category: name(tx.category), amount: txAmount, note: (tx.note ?? '') as string };
    });
    return { id: identifier, date: isoDate(month.date), periods, paySchedule, transactions };
  });
  unique(months, month => month.id);
  const exportHistory: ExportAudit[] = array(root.exportHistory, 1000, true).map(value => {
    const audit = object(value, ['id', 'createdAt', 'monthIds', 'status']);
    if (audit.status !== 'downloadRequested') fail();
    const monthIds = array(audit.monthIds, 1200).map(value => {
      if (typeof value !== 'string') fail(); parts(value); return value;
    });
    unique(monthIds, month => month);
    return { id: id(audit.id), createdAt: isoDate(audit.createdAt), monthIds, status: 'downloadRequested' };
  });
  unique(exportHistory, audit => audit.id);
  const result: Ledger = { schemaVersion: 1, months, savingsBuckets,
    payFrequency: root.payFrequency === undefined ? 'biWeekly' : frequency(root.payFrequency), exportHistory };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_LEDGER_BYTES) fail();
  return result;
}
