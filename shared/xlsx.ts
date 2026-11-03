import type { BudgetPlan, Ledger, MonthlyBudget, ReportedExpense } from './contracts.js';
import { expenseCategories, monthId, monthSummary, moneyText, parseMoney, summary, transactionsIn, validateLedger, windows } from './model.js';

type Cell = { kind: 'text'; value: string } | { kind: 'money'; value: bigint } |
  { kind: 'number'; value: number } | null;
interface Sheet {
  name: string; rows: Cell[][]; cy?: boolean; headers?: Set<number>;
  widths?: number[]; merges?: string[]; comparisons?: { actual: string; projected: string }[];
}
export interface WorkbookOptions { monthIds: string[]; includeNotes: boolean; createdAt?: Date }

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CENTS = 999_999_999_999_999n;
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const text = (value: string): Cell => ({ kind: 'text', value });
const money = (value: bigint): Cell => ({ kind: 'money', value });
const number = (value: number): Cell => ({ kind: 'number', value });
const has = (value: string): boolean => value.trim() !== '';
const amount = (value: string): bigint => {
  const result = parseMoney(value);
  if (result === null) throw new Error('Correct invalid monetary entries before exporting.');
  return result;
};
const raw = (value: string): Cell => has(value) ? money(amount(value)) : null;
const sheet = (name: string, headers: string[]): Sheet => ({ name, rows: [headers.map(text)] });

function savingsCell(plan: BudgetPlan, withdrawal: boolean, negative = false): Cell {
  const inputs = withdrawal
    ? [plan.savingsWithdrawn, ...plan.bucketEntries.map(entry => entry.withdrawal)]
    : [plan.savings, ...plan.bucketEntries.map(entry => entry.contribution)];
  if (!inputs.some(has)) return null;
  return money(inputs.reduce((total, value) => total + amount(value), 0n) * (negative ? -1n : 1n));
}

function hasPlanInput(plan: BudgetPlan): boolean {
  return [plan.payroll, plan.extra, plan.savings, plan.savingsWithdrawn,
    ...plan.expenses.map(entry => entry.amount),
    ...plan.bucketEntries.flatMap(entry => [entry.contribution, entry.withdrawal])].some(has);
}

function expenses(plan: BudgetPlan): bigint {
  return plan.expenses.reduce((total, entry) => total + amount(entry.amount), 0n);
}

function groupedTransactions(transactions: ReportedExpense[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const transaction of transactions) {
    totals.set(transaction.category, (totals.get(transaction.category) ?? 0n) + amount(transaction.amount));
  }
  return totals;
}

/** Creates a local report only. Does not transmit, persist, or mutate the ledger. */
export function exportWorkbook(input: Ledger, options: WorkbookOptions): Uint8Array {
  const ledger = validateLedger(input);
  if (!Array.isArray(options.monthIds) || !options.monthIds.length ||
      new Set(options.monthIds).size !== options.monthIds.length) {
    throw new Error('Select one or more distinct months to export.');
  }
  const selectedIds = new Set(options.monthIds);
  const months = ledger.months.filter(month => selectedIds.has(month.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (months.length !== selectedIds.size) throw new Error('An export month is not present in this budget.');
  const createdAt = options.createdAt ?? new Date();
  if (!Number.isFinite(createdAt.getTime())) throw new Error('The export timestamp is invalid.');
  const includeNotes = options.includeNotes === true;
  const currentId = monthId(createdAt);
  const monthly = sheet('Monthly Summary', [
    'Month', 'Currency', 'State', 'Budgeted Income', 'Budgeted Expenses',
    'Budgeted Savings Deposits', 'Budgeted Savings Withdrawals', 'Budgeted Remaining',
    'Realistic Income', 'Unlogged Expenses', 'Logged Expenses', 'Realistic Expenses',
    'Savings Deposits', 'Savings Withdrawals', 'Savings Change', 'Realistic Remaining', 'Expense Budget Remaining',
  ]);
  const payPeriods = sheet('Pay Periods', [
    'Month', 'Period', 'Start Day', 'End Day', 'Payday', 'Plan', 'Payroll', 'Extra', 'Income',
    'Unlogged Expenses', 'Logged Expenses', 'Total Expenses', 'Savings Deposits', 'Savings Withdrawals',
    'Savings Change', 'Remaining',
  ]);
  const categories = sheet('Categories', [
    'Month', 'Period', 'Start Day', 'End Day', 'Plan', 'Category', 'Manual Amount', 'Logged Amount', 'Total Amount',
  ]);
  const reported = sheet('Transactions', ['Date', 'Month', 'Period', 'Category', 'Amount', ...(includeNotes ? ['Notes'] : [])]);
  const buckets = sheet('Savings Buckets', [
    'Month', 'Period', 'Start Day', 'End Day', 'Plan', 'Bucket', 'Contribution', 'Withdrawal', 'NetContribution',
  ]);

  for (const month of months) {
    const budgeted = monthSummary(month, 'budgeted');
    const actual = monthSummary(month, 'realistic');
    const logged = month.transactions.reduce((total, transaction) => total + amount(transaction.amount), 0n);
    const manual = month.periods.reduce((total, period) => total + expenses(period.realistic), 0n);
    monthly.rows.push([
      text(month.id), text('USD'), text(month.id === currentId ? 'Current / in progress' : month.id < currentId ? 'Historical' : 'Future / planned'),
      money(budgeted.income), money(budgeted.expenses), money(budgeted.savings), money(budgeted.withdrawn), money(budgeted.remaining),
      money(actual.income), money(manual), money(logged), money(actual.expenses), money(actual.savings), money(actual.withdrawn),
      money(actual.savings - actual.withdrawn), money(actual.remaining), money(budgeted.expenses - actual.expenses),
    ]);
    for (const window of windows(month)) {
      const transactions = transactionsIn(month, window);
      const loggedByCategory = groupedTransactions(transactions);
      for (const [label, plan, included] of [
        ['Budgeted', month.periods[window.index]!.budgeted, []],
        ['Realistic', month.periods[window.index]!.realistic, transactions],
      ] as [string, BudgetPlan, ReportedExpense[]][]) {
        const value = summary(plan, included);
        const recorded = included.reduce((total, transaction) => total + amount(transaction.amount), 0n);
        payPeriods.rows.push([
          text(month.id), number(window.index + 1), number(window.startDay), number(window.endDay),
          window.payDay === null ? null : number(window.payDay), text(label), raw(plan.payroll), raw(plan.extra),
          money(value.income), money(expenses(plan)), money(recorded), money(value.expenses),
          savingsCell(plan, false), savingsCell(plan, true), money(value.savings - value.withdrawn), money(value.remaining),
        ]);
        for (const entry of plan.bucketEntries) {
          if (!has(entry.contribution) && !has(entry.withdrawal)) continue;
          buckets.rows.push([
            text(month.id), number(window.index + 1), number(window.startDay), number(window.endDay), text(label), text(entry.name),
            raw(entry.contribution), raw(entry.withdrawal), money(amount(entry.contribution) - amount(entry.withdrawal)),
          ]);
        }
        const known = new Set([...plan.expenses.map(entry => entry.name), ...included.map(transaction => transaction.category)]);
        const names = [...expenseCategories.filter(name => known.has(name)), ...[...known].filter(name => !expenseCategories.includes(name)).sort()];
        for (const name of names) {
          const entries = plan.expenses.filter(entry => entry.name === name);
          const manualAmount = entries.reduce((total, entry) => total + amount(entry.amount), 0n);
          const recordedAmount = label === 'Realistic' ? loggedByCategory.get(name) ?? 0n : 0n;
          categories.rows.push([
            text(month.id), number(window.index + 1), number(window.startDay), number(window.endDay), text(label), text(name),
            entries.some(entry => has(entry.amount)) ? money(manualAmount) : null,
            money(recordedAmount), money(manualAmount + recordedAmount),
          ]);
        }
      }
    }
    for (const transaction of [...month.transactions].sort((a, b) =>
      a.dayOfMonth - b.dayOfMonth || a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      const window = windows(month).find(value => transaction.dayOfMonth >= value.startDay && transaction.dayOfMonth <= value.endDay);
      if (!window) throw new Error('A transaction has no matching pay period.');
      reported.rows.push([
        text(`${month.id}-${String(transaction.dayOfMonth).padStart(2, '0')}`), text(month.id),
        number(window.index + 1), text(transaction.category), money(amount(transaction.amount)),
        ...(includeNotes ? [text(transaction.note)] : []),
      ]);
    }
  }
  const readMe: Sheet = { name: 'Read Me', rows: [
    ['Report', 'Budget App web export; schema 1'], ['Created (UTC)', createdAt.toISOString()],
    ['Selected months', months.map(month => month.id).join(', ')],
    ['Currency', 'USD; financial cells have two decimal places.'],
    ['Scope', 'Only selected months are included. Internal identifiers, global targets, account details, and all-time goal progress are omitted.'],
    ['Snapshot', 'Financial totals are calculated when exported. Editing this workbook does not recalculate them or update the app.'],
    ['CY layout', 'Projected is Budgeted; Actual is Realistic. Negative CY amounts are outflows. Other detail sheets show positive spending and deposits.'],
    ['CY savings', 'Savings withdrawals are explicitly recorded; no savings carryover or opening balance is inferred.'],
    ['CY comparison', 'Actual Left Over compares to the same period\'s Projected value: red below, green at or above. Untouched plans have no comparison coloring.'],
    ['Realistic expenses', 'Unlogged manual spending plus reported transactions, counted once. Detail sheets are breakdowns, not additional expenses.'],
    ['Remaining', 'Income + general and bucket withdrawals - expenses - general and bucket savings deposits.'],
    ['Savings Buckets', 'Selected-period funding only. Contributions and withdrawals already enter summary totals; do not add this detail sheet again.'],
    ['Blank versus zero', 'Blank raw inputs remain blank; an entered zero is numeric zero. Calculated totals treat blanks as zero.'],
    ['Current month', 'Current-month results are in progress. Planned categories are not bill due dates or payment-status records.'],
    ['Notes', includeNotes ? 'Transaction notes explicitly included as literal text, never executable formulas.' : 'Transaction notes excluded.'],
    ['Copies', 'The file is not password-encrypted. Saved/shared copies follow the destination\'s policies and are not removed by account deletion.'],
  ].map(row => row.map(text)) };
  return workbook([...yearlySheets(months), readMe, monthly, payPeriods, categories, reported, ...(buckets.rows.length > 1 ? [buckets] : [])]);
}

function yearlySheets(months: MonthlyBudget[]): Sheet[] {
  const groups = new Map<string, MonthlyBudget[]>();
  for (const month of months) groups.set(month.id.slice(0, 4), [...(groups.get(month.id.slice(0, 4)) ?? []), month]);
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([yearString, records]) => {
    const year = Number(yearString);
    const known = new Set<string>(expenseCategories);
    const allNames = new Set(records.flatMap(month => month.periods.flatMap(period =>
      [...period.realistic.expenses, ...period.budgeted.expenses].map(entry => entry.name)).concat(month.transactions.map(transaction => transaction.category))));
    const extra = [...allNames].filter(name => !known.has(name)).sort();
    const lines: [string, string | null][] = [
      ['Home / Rent', 'Home'], ['Car', 'Car'], ['Insurance', 'Insurance'], ['Phone', 'Phone'],
      ['Grocery / Food', 'Grocery'], ['Gas', 'Gas'], ['Electric', 'Electric'], ['Savings deposits', null],
      ['Credit Card', 'Credit Card'], ['Misc.', 'Misc.'], ['Going-out', 'Going-out'], ...extra.map(name => [name, name] as [string, string]),
    ];
    const totalRow = 6 + lines.length;
    const leftRow = totalRow + 1;
    const blocks = records.reduce((total, month) => total + windows(month).length, 0);
    const width = blocks * 4;
    if (!width || width > 16384 || width * (leftRow + 1) > 200000) throw new Error('Select fewer months or categories for this export.');
    const result: Sheet = {
      name: year >= 2000 && year <= 2099 ? `CY${String(year % 100).padStart(2, '0')} Data` : `CY${yearString} Data`,
      cy: true, rows: Array.from({ length: leftRow + 1 }, () => Array<Cell>(width).fill(null)),
      headers: new Set([0, 1, 5, totalRow, leftRow]), widths: Array.from({ length: width }, (_, i) => i % 4 === 2 ? 22 : i % 4 === 3 ? 1.5 : 11),
      merges: [], comparisons: [],
    };
    let block = 0;
    for (const month of records) {
      const name = monthNames[Number(month.id.slice(5, 7)) - 1]!;
      for (const window of windows(month)) {
        const col = block++ * 4;
        const set = (row: number, column: number, value: Cell): void => { result.rows[row]![column] = value; };
        set(0, col, text(`${name} ${year} · Days ${window.startDay}–${window.endDay} · ${window.payDay === null ? 'Payday not set' : `Payday ${name} ${window.payDay}`}`));
        result.merges!.push(`${columnName(col)}1:${columnName(col + 2)}1`);
        for (const row of [1, 5]) ['Projected', 'Actual', 'Line Item'].forEach((label, index) => set(row, col + index, text(label)));
        set(2, col + 2, text('Income')); set(3, col + 2, text('Additional income')); set(4, col + 2, text('Savings withdrawals'));
        set(totalRow, col + 2, text('Total Due')); set(leftRow, col + 2, text('Left Over'));
        const reported = transactionsIn(month, window);
        const actual = month.periods[window.index]!.realistic;
        const projected = month.periods[window.index]!.budgeted;
        for (const [offset, plan, included] of [[0, projected, []], [1, actual, reported]] as [number, BudgetPlan, ReportedExpense[]][]) {
          const value = summary(plan, included);
          set(2, col + offset, raw(plan.payroll)); set(3, col + offset, raw(plan.extra)); set(4, col + offset, savingsCell(plan, true));
          const logged = groupedTransactions(included);
          for (const [index, [label, category]] of lines.entries()) {
            set(6 + index, col + 2, text(label));
            if (category === null) { set(6 + index, col + offset, savingsCell(plan, false, true)); continue; }
            const entries = plan.expenses.filter(entry => entry.name === category);
            if (entries.some(entry => has(entry.amount)) || logged.has(category)) {
              set(6 + index, col + offset, money(-(entries.reduce((total, entry) => total + amount(entry.amount), 0n) + (logged.get(category) ?? 0n))));
            }
          }
          set(totalRow, col + offset, money(-(value.expenses + value.savings)));
          set(leftRow, col + offset, money(value.remaining));
        }
        if (hasPlanInput(projected) && (hasPlanInput(actual) || reported.length > 0)) {
          result.comparisons!.push({ actual: `${columnName(col + 1)}${leftRow + 1}`, projected: `${columnName(col)}${leftRow + 1}` });
        }
      }
    }
    return result;
  });
}

function xml(input: string): string {
  if (input.length > 32767) throw new Error('A text entry exceeds Excel\'s cell limit.');
  let result = '';
  for (const character of input) {
    const point = character.codePointAt(0)!;
    if (point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff)) result += character;
  }
  return result.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function columnName(index: number): string {
  let result = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result;
  return result;
}

function workbook(sheets: Sheet[]): Uint8Array {
  const archive = new StoredZip();
  archive.add('[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
  archive.add('_rels/.rels', XML + `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  archive.add('xl/workbook.xml', XML + `<workbook xmlns="${M}" xmlns:r="${R}"><sheets>` + sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') + '</sheets></workbook>');
  archive.add('xl/_rels/workbook.xml.rels', XML + `<Relationships xmlns="${P}">` + sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${R}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`);
  archive.add('xl/styles.xml', XML + styles());
  for (const [index, sheet] of sheets.entries()) {
    const cols = sheet.rows[0]!.length;
    if (cols < 1 || cols > 16384 || sheet.rows.length > 1048576) throw new Error('The worksheet is too large.');
    const last = `${columnName(cols - 1)}${sheet.rows.length}`;
    const fragments = [XML, `<worksheet xmlns="${M}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.cy ? 2 : 1}" topLeftCell="A${sheet.cy ? 3 : 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="${sheet.cy ? 18 : 15}"/><cols>`];
    if (sheet.widths) sheet.widths.forEach((width, column) => fragments.push(`<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`));
    else fragments.push(`<col min="1" max="${cols}" width="22" customWidth="1"/>`);
    fragments.push('</cols><sheetData>');
    let characters = fragments.join('').length;
    for (const [rowIndex, row] of sheet.rows.entries()) {
      const header = sheet.headers?.has(rowIndex) ?? rowIndex === 0;
      const cells = [`<row r="${rowIndex + 1}"${sheet.cy && header ? ` ht="${rowIndex === 0 ? 42 : 22}" customHeight="1"` : ''}>`];
      for (const [column, cell] of row.entries()) {
        const reference = `${columnName(column)}${rowIndex + 1}`;
        if (cell === null) {
          if (sheet.cy && header && column % 4 !== 3) cells.push(`<c r="${reference}" s="5"/>`);
          continue;
        }
        if (cell.kind === 'text') {
          cells.push(`<c r="${reference}" t="inlineStr" s="${sheet.cy ? header ? 5 : 3 : header ? 1 : 0}"><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`);
        } else {
          const isMoney = cell.kind === 'money';
          if (isMoney && (cell.value > MAX_CENTS || cell.value < -MAX_CENTS)) throw new Error('An exported total exceeds Excel\'s exact-cent precision.');
          if (!isMoney && !Number.isSafeInteger(cell.value)) throw new Error('An exported numeric field is invalid.');
          const style = sheet.cy ? isMoney ? header ? 6 : 4 : header ? 5 : 3 : isMoney ? 2 : 0;
          cells.push(`<c r="${reference}" s="${style}"><v>${isMoney ? moneyText(cell.value) : cell.value}</v></c>`);
        }
      }
      cells.push('</row>');
      const fragment = cells.join('');
      characters += fragment.length;
      if (characters > MAX_BYTES) throw new Error('Select fewer months for this export.');
      fragments.push(fragment);
    }
    fragments.push('</sheetData>');
    if (!sheet.cy && sheet.rows.length > 1 && sheet.name !== 'Read Me') fragments.push(`<autoFilter ref="A1:${last}"/>`);
    if (sheet.merges?.length) fragments.push(`<mergeCells count="${sheet.merges.length}">` + sheet.merges.map(range => `<mergeCell ref="${range}"/>`).join('') + '</mergeCells>');
    sheet.comparisons?.forEach((comparison, i) => fragments.push(`<conditionalFormatting sqref="${comparison.actual}"><cfRule type="cellIs" dxfId="0" priority="${i * 2 + 1}" operator="lessThan"><formula>${comparison.projected}</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="${i * 2 + 2}" operator="greaterThanOrEqual"><formula>${comparison.projected}</formula></cfRule></conditionalFormatting>`));
    fragments.push('</worksheet>');
    archive.add(`xl/worksheets/sheet${index + 1}.xml`, fragments.join(''));
  }
  return archive.finish();
}

function styles(): string {
  return `<styleSheet xmlns="${M}"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="12"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="2" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="2" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFC5E0B4"/><bgColor indexed="64"/></patternFill></fill></dxf></dxfs></styleSheet>`;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
function concat(parts: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
class StoredZip {
  private entries: { name: Uint8Array; content: Uint8Array; crc: number; offset: number }[] = [];
  private length = 0;
  private directoryLength = 0;
  add(path: string, content: string): void {
    const encoder = new TextEncoder();
    const name = encoder.encode(path);
    const bytes = encoder.encode(content);
    const localLength = 30 + name.length + bytes.length;
    const directoryLength = 46 + name.length;
    if (this.entries.length >= 65535 || name.length > 65535 ||
        this.length + localLength + this.directoryLength + directoryLength + 22 > MAX_BYTES) throw new Error('Select fewer months for this export.');
    this.entries.push({ name, content: bytes, crc: crc32(bytes), offset: this.length });
    this.length += localLength;
    this.directoryLength += directoryLength;
  }
  finish(): Uint8Array {
    const local: Uint8Array[] = [], directory: Uint8Array[] = [];
    for (const entry of this.entries) {
      const header = new Uint8Array(30), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(12, 0x21, true);
      h.setUint32(14, entry.crc, true); h.setUint32(18, entry.content.length, true); h.setUint32(22, entry.content.length, true); h.setUint16(26, entry.name.length, true);
      local.push(header, entry.name, entry.content);
      const central = new Uint8Array(46), c = new DataView(central.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 0x21, true);
      c.setUint32(16, entry.crc, true); c.setUint32(20, entry.content.length, true); c.setUint32(24, entry.content.length, true); c.setUint16(28, entry.name.length, true); c.setUint32(42, entry.offset, true);
      directory.push(central, entry.name);
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.entries.length, true); e.setUint16(10, this.entries.length, true);
    e.setUint32(12, this.directoryLength, true); e.setUint32(16, this.length, true);
    return concat([...local, ...directory, end], this.length + this.directoryLength + 22);
  }
}
