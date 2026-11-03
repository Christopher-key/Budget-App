import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emptyLedger, newMonth } from '../model.js';
import { exportWorkbook } from '../xlsx.js';
import type { Ledger } from '../contracts.js';

const TRIP = '10000000-0000-4000-8000-000000000001';
const FIRST = '10000000-0000-4000-8000-000000000002';
const SECOND = '10000000-0000-4000-8000-000000000003';
const DATE = new Date('2026-11-01T12:00:00.000Z');
const NOTE = '=HYPERLINK("https://example.invalid","PRIVATE-NOTE") & < > 😀\u0001end';

function fixture(): Ledger {
  const ledger = emptyLedger(new Date('2026-01-15T12:00:00.000Z'));
  const month = ledger.months.find(m => m.id === '2026-01')!;
  const real = month.periods[0]!.realistic;
  const plan = month.periods[0]!.budgeted;
  real.payroll = '1000.10'; real.extra = '25.50';
  real.savings = '100'; real.savingsWithdrawn = '10';
  real.expenses.find(e => e.name === 'Home')!.amount = '100.10';
  real.expenses.find(e => e.name === 'Electric')!.amount = '20.20';
  plan.payroll = '1000'; plan.savings = '100'; plan.savingsWithdrawn = '10';
  plan.expenses.find(e => e.name === 'Home')!.amount = '100';
  plan.expenses.find(e => e.name === 'Electric')!.amount = '50';
  month.periods[1]!.budgeted.expenses.find(e => e.name === 'Gas')!.amount = '0';
  ledger.savingsBuckets.push({ id: TRIP, name: 'Trip', target: '913579.31', isActive: true });
  real.bucketEntries.push({ id: TRIP, name: '=1+1', contribution: '25', withdrawal: '5' });
  plan.bucketEntries.push({ id: TRIP, name: 'Trip', contribution: '50', withdrawal: '' });
  month.transactions.push(
    { id: FIRST, date: '2026-01-14T12:00:00.000Z', dayOfMonth: 14, category: 'Home', amount: '0.10', note: NOTE },
    { id: SECOND, date: '2026-01-15T12:00:00.000Z', dayOfMonth: 15, category: 'Grocery', amount: '0.20', note: 'SECOND-PRIVATE-NOTE' },
  );
  return ledger;
}

interface Inspection {
  sheetNames: string[];
  sheets: Record<string, { cells: Record<string, string | null>; merges: string[]; widths: number[]; comparisons: Record<string, string[]> }>;
}
function inspect(bytes: Uint8Array): Inspection {
  const directory = mkdtempSync(join(tmpdir(), 'budget-web-xlsx-'));
  try {
    const path = join(directory, 'synthetic.xlsx');
    writeFileSync(path, bytes);
    const python = spawnSync('python3', [fileURLToPath(new URL('./validate_xlsx.py', import.meta.url)), path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(python.status, 0, python.stderr);
    return JSON.parse(python.stdout) as Inspection;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function row(table: Record<string, string | null>, match: Record<string, string>): Record<string, string | null> {
  const headers = Object.entries(table).filter(([ref]) => /^[A-Z]+1$/.test(ref));
  const rows = new Map<string, Record<string, string | null>>();
  for (const [ref, value] of Object.entries(table)) {
    const [col, n] = /^([A-Z]+)([0-9]+)$/.exec(ref)!.slice(1);
    if (n === '1') continue;
    const header = headers.find(([r]) => r === `${col}1`)?.[1];
    if (typeof header !== 'string') continue;
    const current = rows.get(n!) ?? {};
    current[header] = value; rows.set(n!, current);
  }
  const matches = [...rows.values()].filter(r => Object.entries(match).every(([key, value]) => r[key] === value));
  assert.equal(matches.length, 1, `Expected one matching synthetic row: ${JSON.stringify(match)}`);
  return matches[0]!;
}

test('real ZIP/XML workbook reconciles exact money and CY signed outflows', () => {
  const ledger = fixture(), before = JSON.stringify(ledger);
  const bytes = exportWorkbook(ledger, { monthIds: ['2026-01'], includeNotes: false, createdAt: DATE });
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const report = inspect(bytes);
  assert.deepEqual(report.sheetNames, ['CY26 Data', 'Read Me', 'Monthly Summary', 'Pay Periods', 'Categories', 'Transactions', 'Savings Buckets']);
  const monthly = row(report.sheets['Monthly Summary']!.cells, { Month: '2026-01' });
  assert.equal(Number(monthly['Realistic Income']), 1025.60);
  assert.equal(Number(monthly['Realistic Expenses']), 120.60);
  assert.equal(Number(monthly['Savings Deposits']), 125);
  assert.equal(Number(monthly['Savings Withdrawals']), 15);
  assert.equal(Number(monthly['Realistic Remaining']), 795);
  assert.equal(Number(monthly['Budgeted Remaining']), 710);
  const cy = report.sheets['CY26 Data']!;
  assert.deepEqual(cy.merges, ['A1:C1', 'E1:G1']);
  assert.deepEqual(cy.widths, [11, 11, 22, 1.5, 11, 11, 22, 1.5]);
  assert.equal(cy.cells['A2'], 'Projected'); assert.equal(cy.cells['B2'], 'Actual');
  assert.equal(cy.cells['C2'], 'Line Item');
  assert.equal(Number(cy.cells['B5']), 15);
  assert.equal(Number(cy.cells['B7']), -100.20);
  assert.equal(Number(cy.cells['B14']), -125);
  assert.equal(Number(cy.cells['B18']), -245.40);
  assert.equal(Number(cy.cells['B19']), 795.20);
  assert.equal(Number(cy.cells['F19']), -0.20);
  assert.deepEqual(cy.comparisons['B19'], ['A19', 'A19']);
  assert.deepEqual(cy.comparisons['F19'], ['E19', 'E19']);
  assert.equal(cy.cells['A12'] ?? null, null);
  assert.equal(Number(cy.cells['E12']), 0);
  assert.equal(JSON.stringify(ledger), before);
});

test('selected scope, note opt-in, literal strings, and private identifier exclusion', () => {
  const ledger = fixture();
  const other = newMonth('2025-12');
  other.periods[0]!.realistic.extra = '913579.11';
  ledger.months.push(other);
  const hidden = exportWorkbook(ledger, { monthIds: ['2026-01'], includeNotes: false, createdAt: DATE });
  const hiddenText = Buffer.from(hidden).toString('utf8');
  assert.equal(hiddenText.includes('PRIVATE-NOTE'), false);
  assert.equal(hiddenText.includes('2025-12'), false);
  assert.equal(hiddenText.includes('913579.11'), false);
  assert.equal(hiddenText.includes('913579.31'), false);
  assert.equal(hiddenText.includes(TRIP), false);
  assert.equal(hiddenText.includes(FIRST), false);
  const included = inspect(exportWorkbook(ledger, { monthIds: ['2026-01'], includeNotes: true, createdAt: DATE }));
  const transaction = row(included.sheets['Transactions']!.cells, { Category: 'Home' });
  assert.equal(transaction['Notes'], NOTE.replace('\u0001', ''));
  const bucket = row(included.sheets['Savings Buckets']!.cells, { Plan: 'Realistic', Bucket: '=1+1' });
  assert.equal(Number(bucket['Contribution']), 25);
  assert.equal(Number(bucket['Withdrawal']), 5);
  assert.equal(Number(bucket['NetContribution']), 20);
});

test('empty funding omits optional sheet; chosen years and period counts follow the ledger', () => {
  const ledger = fixture();
  ledger.savingsBuckets = [];
  for (const period of ledger.months[0]!.periods) {
    period.realistic.bucketEntries = []; period.budgeted.bucketEntries = [];
  }
  const prior = newMonth('2025-12', 'monthly'); ledger.months.push(prior);
  const current = newMonth('2026-02', 'weekly'); ledger.months.push(current);
  const report = inspect(exportWorkbook(ledger, { monthIds: ['2026-02', '2025-12'], includeNotes: false, createdAt: DATE }));
  assert.deepEqual(report.sheetNames, ['CY25 Data', 'CY26 Data', 'Read Me', 'Monthly Summary', 'Pay Periods', 'Categories', 'Transactions']);
  assert.equal(report.sheets['CY25 Data']!.merges.length, 1);
  assert.equal(report.sheets['CY26 Data']!.merges.length, 4);
  assert.deepEqual(report.sheets['CY26 Data']!.comparisons, {});
  const raw = JSON.stringify(report);
  assert.equal(raw.includes('2026-01'), false);
});

test('selection failures cannot export an unintended full ledger', () => {
  const ledger = fixture();
  for (const ids of [[], ['2026-01', '2026-01'], ['2026-02']]) {
    assert.throws(() => exportWorkbook(ledger, { monthIds: ids, includeNotes: false, createdAt: DATE }));
  }
  assert.throws(() => exportWorkbook(ledger, { monthIds: ['2026-01'], includeNotes: false, createdAt: new Date(NaN) }));
});
