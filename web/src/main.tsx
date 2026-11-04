import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { BudgetPlan, Ledger, MonthlyBudget, PayFrequency, ReportedExpense, SavingsBucket } from '../../shared/contracts.js';
import { applySchedule, bucketBalances, categoryWarnings, emptyPlan, expenseCategories, formatMoney, monthId, monthSummary, moneyText, newMonth, parseMoney, summary, transactionsIn, validateLedger, windows } from '../../shared/model.js';
import { exportWorkbook } from '../../shared/xlsx.js';
import { authenticate, validatePublicConfig, type PublicConfig } from './auth.js';
import { BudgetApi, BudgetSession } from './api.js';
import { copyCurrentPlanToForecast, forecastMonthIds, forecastSummary, hasBudgetedPlan, planningMonth, savePlanningMonth } from '../../shared/forecast.js';
import { LOCKDOWN_MESSAGE, SECURITY_UNAVAILABLE_MESSAGE } from '../../shared/security.js';
import { SecurityMonitor } from './security.js';
import './style.css';

type Page = 'home' | 'budget' | 'transactions' | 'trends' | 'goals' | 'settings';
const pageNames: [Page, string, string][] = [['home', 'Home', '⌂'], ['budget', 'Budget', '▤'], ['transactions', 'Transactions', '↗'], ['trends', 'Trends', '⌁'], ['goals', 'Savings goals', '◎'], ['settings', 'Settings', '⚙']];
const uuid = () => crypto.randomUUID();
const amount = (value: string) => parseMoney(value) ?? 0n;
const currentMonth = (ledger: Ledger) => ledger.months.find(m => m.id === monthId()) ?? newMonth(monthId(), ledger.payFrequency);
const fullMonth = (id: string) => new Date(Number(id.slice(0, 4)), Number(id.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const frequencyName = (f: PayFrequency) => ({ monthly: 'Monthly', biWeekly: 'Bi-Weekly', weekly: 'Weekly' })[f];
const localDate = (date = new Date()) => `${monthId(date)}-${String(date.getDate()).padStart(2, '0')}`;
function Money({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const invalid = parseMoney(draft) === null;
  return <label className="money-input"><span>{label}</span><span className="money-entry"><span aria-hidden="true">$</span><input aria-label={`${label} amount`} aria-invalid={invalid} inputMode="decimal" value={draft} placeholder="0.00" maxLength={24} onChange={e => { const v = e.target.value; setDraft(v); onChange(v); }}/></span>{invalid && <small className="error">Enter a non-negative amount with up to two decimal places.</small>}</label>;
}
function Pin({ label = 'App passcode', value, onChange }: { label?: string; value: string; onChange: (v: string) => void }) {
  return <label className="field">{label}<input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={value} onChange={e => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}/></label>;
}
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const heading = React.useId();
  const panel = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? []);
    (focusable().find(el => el.tagName === 'INPUT') ?? focusable()[0])?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') { const nodes = focusable(), first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', handler); return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><section ref={panel} className="modal" role="dialog" aria-modal="true" aria-labelledby={heading}><header><h2 id={heading}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></header>{children}</section></div>;
}
function Summary({ title, data }: { title: string; data: ReturnType<typeof summary> }) {
  return <section className="card summary-card"><p className="eyebrow">{title}</p><h2 className={data.remaining < 0n ? 'negative' : ''}>{formatMoney(data.remaining)}</h2><p className="muted">remaining this pay period</p><dl><div><dt>Income</dt><dd>{formatMoney(data.income)}</dd></div><div><dt>Expenses</dt><dd>{formatMoney(data.expenses)}</dd></div><div><dt>Savings added</dt><dd>{formatMoney(data.savings)}</dd></div><div><dt>Pulled from savings</dt><dd>{formatMoney(data.withdrawn)}</dd></div></dl></section>;
}
function SecurityPanel({ session, onSignOut }: { session: BudgetSession; onSignOut: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [pin, setPin] = useState(''), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false);
  const creating = state.phase === 'new';
  return <main className="entry-shell"><div className="entry-card"><div className="brand-mark">B</div><p className="eyebrow">Your private budget</p><h1>{state.phase === 'erased' ? 'Your budget was erased' : creating ? 'Make room for your goals' : 'Welcome back'}</h1><p className="muted">{state.phase === 'erased' ? 'Your account and its saved budget have been erased. Sign out to create a new account.' : creating ? 'Set an app passcode to protect your budget on every connected device.' : 'Enter your app passcode to open your budget.'}</p>{state.message && <p role="status" className="error">{state.message}</p>}{state.phase === 'checking' ? <p>Checking your account…</p> : (state.phase === 'signedOut' || state.phase === 'erased') ? <button className="primary" onClick={onSignOut}>Sign in again</button> : <form onSubmit={async e => { e.preventDefault(); setBusy(true); await session.open(pin, creating); setPin(''); setConfirm(''); setBusy(false); }}><Pin value={pin} onChange={setPin}/>{creating && <><Pin label="Confirm app passcode" value={confirm} onChange={setConfirm}/><p className="privacy-note">Three consecutive incorrect app passcodes erase this account and its budget across connected devices, without another warning. Offline devices clear their copy when they reconnect. Exported files and provider backups follow their own retention policies.</p></>}<button className="primary full" disabled={busy || pin.length !== 4 || (creating && pin !== confirm)}>{busy ? 'Please wait…' : creating ? 'Start an empty budget' : 'Unlock budget'}</button></form>}<button className="text-button" onClick={onSignOut}>Sign out</button></div></main>;
}
function Overview({ ledger }: { ledger: Ledger }) {
  const month = currentMonth(ledger), day = new Date().getDate(), window = windows(month).find(w => day >= w.startDay && day <= w.endDay) ?? windows(month)[0];
  const actual = summary(month.periods[window.index].realistic, transactionsIn(month, window));
  const planned = summary(month.periods[window.index].budgeted);
  const balances = bucketBalances(ledger), warnings = categoryWarnings(month, window);
  const savings = ledger.months.reduce((sum, m) => { const s = monthSummary(m, 'realistic'); return sum + s.savings - s.withdrawn; }, 0n);
  const hour = new Date().getHours();
  return <><div className="page-heading"><div><p className="eyebrow">{fullMonth(month.id)}</p><h1>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}<span className="accent">.</span></h1><p className="muted">A little clarity for your money.</p></div><span className="period-chip">Days {window.title}</span></div>{warnings.length > 0 && <section className={`warning ${warnings.some(w => w.level !== 'approaching') ? 'danger' : ''}`}><h3>Pay-period budget warning</h3>{warnings.map(w => <div key={w.category}><span>{w.category} budget left</span><strong>{formatMoney(w.remaining)}</strong></div>)}</section>}<section className="card bucket-preview">{ledger.savingsBuckets.filter(b => b.isActive).map(b => <div key={b.id}><strong>{b.name}</strong><span className={(balances.get(b.id) ?? 0n) < 0n ? 'negative' : ''}>{formatMoney(balances.get(b.id) ?? 0n)} <span className="muted">/ {formatMoney(amount(b.target))}</span></span></div>)}{!ledger.savingsBuckets.some(b => b.isActive) && <p className="muted">Your next big goal starts with a savings bucket. Add one in Savings goals.</p>}</section><section className="savings-hero"><div><p className="eyebrow">Total savings</p><h2>{formatMoney(savings)}</h2><p>Across your general savings and every bucket.</p></div><div className="savings-art" aria-hidden="true">↗</div></section><div className="section-heading"><h2>Your current pay period</h2><span className="muted">{frequencyName(month.paySchedule.frequency)} · Days {window.title}</span></div><div className="two-columns"><Summary title="Realistic" data={actual}/><Summary title="Budgeted" data={planned}/></div></>;
}
function BucketAmount(plan: BudgetPlan, bucket: SavingsBucket, field: 'contribution' | 'withdrawal', value: string): BudgetPlan {
  const copy = structuredClone(plan), entry = copy.bucketEntries.find(e => e.id === bucket.id) ?? { id: bucket.id, name: bucket.name, contribution: '', withdrawal: '' };
  entry.name = bucket.name; entry[field] = value; copy.bucketEntries = copy.bucketEntries.filter(e => e.id !== bucket.id);
  if (entry.contribution !== '' || entry.withdrawal !== '') copy.bucketEntries.push(entry);
  return copy;
}
function PlanEditor({ title, plan, buckets, reported, onChange }: { title: string; plan: BudgetPlan; buckets: SavingsBucket[]; reported: ReportedExpense[]; onChange: (p: BudgetPlan) => void }) {
  const [withdraw, setWithdraw] = useState(false), [source, setSource] = useState('general'), [withdrawal, setWithdrawal] = useState('');
  const data = summary(plan, reported);
  function choose(id: string) { setSource(id); setWithdrawal(id === 'general' ? plan.savingsWithdrawn : plan.bucketEntries.find(e => e.id === id)?.withdrawal ?? ''); }
  return <section className="card editor-card"><p className="eyebrow">{title}</p><h3>Income</h3><Money label="Payroll" value={plan.payroll} onChange={v => onChange({ ...plan, payroll: v })}/><Money label="Extra" value={plan.extra} onChange={v => onChange({ ...plan, extra: v })}/><h3>Expenses</h3>{plan.expenses.map(expense => { const logged = reported.filter(t => t.category === expense.name).reduce((sum, t) => sum + amount(t.amount), 0n); return <div key={expense.id}>{title === 'Realistic' && logged > 0n && <small className="muted">{expense.name}: {formatMoney(logged)} logged separately</small>}<Money label={expense.name} value={expense.amount} onChange={v => onChange({ ...plan, expenses: plan.expenses.map(e => e.id === expense.id ? { ...e, amount: v } : e) })}/></div>; })}<h3>Savings</h3><Money label="Set aside" value={plan.savings} onChange={v => onChange({ ...plan, savings: v })}/>{buckets.filter(b => b.isActive).map(bucket => <Money key={bucket.id} label={bucket.name} value={plan.bucketEntries.find(e => e.id === bucket.id)?.contribution ?? ''} onChange={v => onChange(BucketAmount(plan, bucket, 'contribution', v))}/>)}{buckets.some(b => b.isActive) && <small className="muted">Bucket contributions are additional to Set aside.</small>}{plan.bucketEntries.filter(entry => !buckets.some(b => b.id === entry.id && b.isActive) && entry.contribution.trim()).map(entry => <div className="archived-contribution" key={entry.id}><span>{buckets.find(b => b.id === entry.id)?.name ?? entry.name} <small>(archived)</small></span><strong>{formatMoney(amount(entry.contribution))}</strong></div>)}<button className="withdraw-control" onClick={() => { choose(plan.savingsWithdrawn && amount(plan.savingsWithdrawn) !== 0n ? 'general' : plan.bucketEntries.find(e => amount(e.withdrawal) !== 0n)?.id ?? 'general'); setWithdraw(true); }}><span>Pull from savings</span><strong>{formatMoney(data.withdrawn)} →</strong></button><div className="editor-total"><span>Remaining</span><strong>{formatMoney(data.remaining)}</strong></div>{withdraw && <Modal title="Pull from savings" onClose={() => setWithdraw(false)}><label className="field">Source<select aria-label="Source" value={source} onChange={e => choose(e.target.value)}><option value="general">Set aside (general)</option>{buckets.map(b => <option key={b.id} value={b.id}>{b.name}{b.isActive ? '' : ' (inactive)'}</option>)}</select></label><Money label="Total pulled this pay period" value={withdrawal} onChange={setWithdrawal}/><p className="muted small">Each location keeps its own period total. Clearing the old location and entering the correct one changes an earlier withdrawal’s location. {title === 'Realistic' ? 'Bucket withdrawals reduce saved progress.' : 'Budgeted amounts are plans.'}</p><button className="primary full" disabled={parseMoney(withdrawal) === null} onClick={() => { if (source === 'general') onChange({ ...plan, savingsWithdrawn: withdrawal }); else { const bucket = buckets.find(b => b.id === source); if (bucket) onChange(BucketAmount(plan, bucket, 'withdrawal', withdrawal)); } setWithdraw(false); }}>Save withdrawal total</button></Modal>}</section>;
}
function ForecastPanel({ ledger, select }: { ledger: Ledger; select: (id: string) => void }) {
  const rows = forecastSummary(ledger);
  return <section className="card history-table">
    <h2>Four-month forecast</h2>
    <p className="muted small">Plan the next four months. Forecasts use Budgeted amounts and do not add to recorded spending or savings.</p>
    <div className="table-scroll"><table><thead><tr><th>Month</th><th>Planned income</th><th>Planned expenses</th><th>Net savings</th><th>Remaining</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}><th><button className="text-button" onClick={() => select(row.id)}>{fullMonth(row.id)}</button>{!row.planned && <small>Not planned</small>}</th>
        <td>{row.planned ? formatMoney(row.income) : "—"}</td><td>{row.planned ? formatMoney(row.expenses) : "—"}</td>
        <td>{row.planned ? formatMoney(row.savings - row.withdrawn) : "—"}</td>
        <td className={row.remaining < 0n ? "negative" : ""}>{row.planned ? formatMoney(row.remaining) : "—"}</td></tr>)}</tbody>
    </table></div>
  </section>;
}
function Budget({ ledger, update }: { ledger: Ledger; update: (l: Ledger) => void }) {
  const [selectedMonth, selectMonth] = useState(monthId()), [error, setError] = useState("");
  const choices = [...new Set([...ledger.months.map(month => month.id), monthId(), ...forecastMonthIds()])].sort((a, b) => b.localeCompare(a));
  const selectedID = choices.includes(selectedMonth) ? selectedMonth : monthId();
  const month = useMemo(() => planningMonth(ledger, selectedID), [ledger, selectedID]);
  const all = windows(month), day = new Date().getDate();
  const [selected, select] = useState(() => all.find(w => w.startDay <= day && w.endDay >= day)?.index ?? 0);
  const window = all[selected] ?? all[0], period = month.periods[window.index], isFuture = month.id > monthId();
  const choose = (id: string) => { selectMonth(id); select(0); setError(""); };
  const change = (kind: "realistic" | "budgeted", plan: BudgetPlan) => {
    if (isFuture && kind === "realistic") return;
    try {
      const next = { ...month, periods: month.periods.map((value, index) => index === window.index ? { ...value, [kind]: plan } : value) };
      update(savePlanningMonth(ledger, next)); setError("");
    } catch { setError("Correct invalid amounts before saving this plan."); }
  };
  const copy = () => {
    try { update(copyCurrentPlanToForecast(ledger, month.id)); setError(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "This plan could not be copied."); }
  };
  return <><PageHeading title="Make a plan" subtitle="Give each pay period a little direction."/>
    <ForecastPanel ledger={ledger} select={choose}/>
    <div className="section-heading"><select aria-label="Budget month" value={month.id} onChange={event => choose(event.target.value)}>
      {choices.map(id => <option key={id} value={id}>{fullMonth(id)}{id > monthId() ? " · Forecast" : ""}</option>)}
    </select><div className="segmented" role="group" aria-label="Pay period">{all.map(value => <button key={value.index} aria-pressed={window.index === value.index} className={window.index === value.index ? "selected" : ""} onClick={() => select(value.index)}>Days {value.title}</button>)}</div></div>
    {isFuture ? <section className="card"><div className="section-heading"><h2>{fullMonth(month.id)} forecast</h2>
      {!hasBudgetedPlan(month) && <button className="primary" onClick={copy} disabled={!hasBudgetedPlan(currentMonth(ledger))}>Copy current Budgeted plan</button>}</div>
      <p className="muted small">Enter expected income, expenses and savings below. Copying keeps actual spending and transactions empty. Set this month's pay dates before relying on its period breakdown.</p>
    </section> : <p className="muted small">Realistic expenses include these unlogged amounts plus your reported transactions. Avoid entering the same purchase twice.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {isFuture && <details key={month.id}><summary>Forecast pay dates</summary><Schedule ledger={ledger} update={update} monthID={month.id}/></details>}
    <div className={isFuture ? undefined : "two-columns"}>
      {!isFuture && <PlanEditor key={month.id + "-" + window.title + "-realistic"} title="Realistic" plan={period.realistic} buckets={ledger.savingsBuckets} reported={transactionsIn(month, window)} onChange={plan => change("realistic", plan)}/>}
      <PlanEditor key={month.id + "-" + window.title + "-budgeted"} title="Budgeted" plan={period.budgeted} buckets={ledger.savingsBuckets} reported={[]} onChange={plan => change("budgeted", plan)}/>
    </div></>;
}
function PageHeading({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) { return <div className="page-heading"><div><p className="eyebrow">Your money, with a plan</p><h1>{title}</h1><p className="muted">{subtitle}</p></div>{children}</div>; }
function Transactions({ ledger, update }: { ledger: Ledger; update: (l: Ledger) => void }) {
  const [selected, select] = useState(monthId()), [draft, setDraft] = useState<ReportedExpense | null>(null), [error, setError] = useState('');
  const month = ledger.months.find(m => m.id === selected) ?? currentMonth(ledger);
  function save(e: React.FormEvent) { e.preventDefault(); if (!draft) return; try { const date = new Date(draft.date + 'T12:00:00'); const id = monthId(date); if (!Number.isFinite(date.getTime()) || localDate(date) !== draft.date || draft.date > localDate() || amount(draft.amount) <= 0n) throw new Error(); const copy = structuredClone(ledger); for (const m of copy.months) m.transactions = m.transactions.filter(t => t.id !== draft.id); if (!copy.months.some(m => m.id === id)) copy.months.push(newMonth(id, copy.payFrequency)); copy.months.find(m => m.id === id)!.transactions.push({ ...draft, date: date.toISOString(), dayOfMonth: date.getDate() }); validateLedger(copy); update(copy); setDraft(null); setError(''); } catch { setError('Choose a valid date and positive amount.'); } }
  return <><PageHeading title="The everyday details" subtitle="Small entries. A clearer picture."><button className="primary" onClick={() => setDraft({ id: uuid(), date: localDate(), dayOfMonth: new Date().getDate(), category: expenseCategories[0], amount: '', note: '' })}>+ Report expense</button></PageHeading><section className="card"><div className="section-heading"><select aria-label="Transaction month" value={month.id} onChange={e => select(e.target.value)}>{[...ledger.months].sort((a, b) => b.id.localeCompare(a.id)).map(m => <option key={m.id} value={m.id}>{fullMonth(m.id)}</option>)}</select><strong>{formatMoney(month.transactions.reduce((sum, t) => sum + amount(t.amount), 0n))} logged</strong></div>{[...month.transactions].sort((a, b) => b.dayOfMonth - a.dayOfMonth).map(t => <div className="transaction" key={t.id}><button className="transaction-main" onClick={() => setDraft({ ...t, date: `${month.id}-${String(t.dayOfMonth).padStart(2, '0')}` })}><span className="transaction-symbol">↗</span><span><strong>{t.category}</strong><small>{`${month.id}-${String(t.dayOfMonth).padStart(2, '0')}`}{t.note ? ` · ${t.note}` : ''}</small></span><strong>{formatMoney(amount(t.amount))}</strong></button><button className="icon-button muted" aria-label={`Delete ${t.category} transaction`} onClick={() => { if (confirm('Delete this reported expense?')) update({ ...ledger, months: ledger.months.map(m => ({ ...m, transactions: m.transactions.filter(x => x.id !== t.id) })) }); }}>×</button></div>)}{!month.transactions.length && <Empty title="A fresh page" text="Report a purchase when you’re ready. It will count toward Realistic spending."/>}</section>{draft && <Modal title="Report an expense" onClose={() => setDraft(null)}><form onSubmit={save}><label className="field">Category<select aria-label="Category" value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })}>{expenseCategories.map(c => <option key={c}>{c}</option>)}</select></label><label className="field">Date<input type="date" required value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })}/></label><Money label="Amount" value={draft.amount} onChange={v => setDraft({ ...draft, amount: v })}/><label className="field">Note <span className="muted">(optional)</span><input maxLength={500} value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })}/></label>{error && <p className="error">{error}</p>}<button className="primary full" disabled={parseMoney(draft.amount) === null || amount(draft.amount) <= 0n}>Save expense</button></form></Modal>}</>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><div aria-hidden="true">↗</div><h3>{title}</h3><p className="muted">{text}</p></div>; }
function Trends({ ledger }: { ledger: Ledger }) {
  const year = new Date().getFullYear();
  const points = ledger.months.filter(m => [year, year - 1].includes(Number(m.id.slice(0, 4))) && m.id <= monthId()).filter(m => m.periods.some(p => p.budgeted.expenses.some(e => e.amount.trim())) && (m.transactions.length || m.periods.some(p => p.realistic.expenses.some(e => e.amount.trim())))).map(m => ({ id: m.id, year: Number(m.id.slice(0, 4)), month: Number(m.id.slice(5, 7)), value: monthSummary(m, 'budgeted').expenses - monthSummary(m, 'realistic').expenses }));
  const extent = Math.max(100, ...points.map(p => Math.abs(Number(p.value) / 100))) * 1.15;
  const x = (m: number) => 46 + (m - 1) * 54, y = (value: bigint) => 145 - Number(value) / 100 / extent * 105;
  return <><PageHeading title="See the bigger picture" subtitle="Your progress, one month at a time."/><section className="card"><div className="section-heading"><h2>Calendar-year spending</h2><span className="chart-legend"><i className="orange-dot"/>{year}<i className="purple-dot"/>{year - 1}</span></div><p className="muted small">Budgeted expenses minus Realistic expenses. Above zero means under budget.</p><div className="chart-scroll"><svg viewBox="0 0 700 290" role="img" aria-label="Current and previous year monthly spending compared with budget"><line x1="40" x2="660" y1="145" y2="145" stroke="#9aabae" strokeDasharray="4 4"/>{[-1, 0, 1].map(v => <text x="0" y={145 - v * 105} fontSize="11" fill="#687f84" key={v}>{v === 0 ? '$0' : `${v > 0 ? '+' : '-'}$${Math.round(extent)}`}</text>)}{[year - 1, year].map(yr => { const list = points.filter(p => p.year === yr).sort((a, b) => a.month - b.month); return <g key={yr}>{list.slice(1).map((p, i) => list[i].month + 1 === p.month ? <line key={p.id} x1={x(list[i].month)} y1={y(list[i].value)} x2={x(p.month)} y2={y(p.value)} stroke={yr === year ? '#df8947' : '#9d76bc'} strokeWidth="2.5" strokeDasharray={yr === year ? undefined : '5 4'}/> : null)}{list.map(p => <circle key={p.id} cx={x(p.month)} cy={y(p.value)} r="5.5" fill={p.value >= 0n ? '#187e64' : '#c05252'}><title>{p.id}: {formatMoney(p.value)}</title></circle>)}</g>; })}{Array.from({ length: 12 }, (_, i) => <text x={x(i + 1)} y="280" textAnchor="middle" fill="#687f84" fontSize="11" key={i}>{new Date(2026, i, 1).toLocaleDateString(undefined, { month: 'short' })}</text>)}</svg></div>{!points.length && <p className="muted small">Enter budgeted expenses and Realistic spending to start your comparison.</p>}</section><section className="card history-table"><h2>Monthly history</h2><div className="table-scroll"><table><thead><tr><th>Month</th><th>Income</th><th>Expenses</th><th>Savings change</th><th>Remaining</th></tr></thead><tbody>{[...ledger.months].filter(m => m.id <= monthId()).sort((a, b) => b.id.localeCompare(a.id)).map(m => { const s = monthSummary(m, 'realistic'); return <tr key={m.id}><th>{fullMonth(m.id)}{m.id === monthId() && <small>In progress</small>}</th><td>{formatMoney(s.income)}</td><td>{formatMoney(s.expenses)}</td><td>{formatMoney(s.savings - s.withdrawn)}</td><td className={s.remaining < 0n ? 'negative' : ''}>{formatMoney(s.remaining)}</td></tr>; })}</tbody></table></div></section></>;
}

function Goals({ ledger, update }: { ledger: Ledger; update: (l: Ledger) => void }) {
  const [draft, setDraft] = useState<SavingsBucket | null>(null), [error, setError] = useState('');
  const balances = bucketBalances(ledger);
  const open = (bucket?: SavingsBucket) => { setError(''); setDraft(bucket ? { ...bucket } : { id: uuid(), name: '', target: '', isActive: true }); };
  function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft) return;
    if (!draft.name.trim() || [...draft.name.trim()].length > 60 || /[\p{Cc}\p{Cf}]/u.test(draft.name)) { setError('Use a name of 1–60 characters.'); return; }
    if (parseMoney(draft.target) === null || amount(draft.target) <= 0n) { setError('Enter a positive target amount.'); return; }
    if (ledger.savingsBuckets.some(b => b.id !== draft.id && b.name.trim().toLocaleLowerCase('en-US') === draft.name.trim().toLocaleLowerCase('en-US'))) { setError('A goal with that name already exists.'); return; }
    const next = { ...ledger, savingsBuckets: [...ledger.savingsBuckets.filter(b => b.id !== draft.id), { ...draft, name: draft.name.trim() }] };
    try { validateLedger(next); update(next); setDraft(null); } catch { setError('Check the goal name and target amount.'); }
  }
  return <><PageHeading title="Something to look forward to" subtitle="Give your savings a name and a purpose."><button className="primary" onClick={() => open()}>+ New goal</button></PageHeading><section className="card"><div className="section-heading"><h2>Your savings buckets</h2><span className="muted small">{ledger.savingsBuckets.filter(b => b.isActive).length} active</span></div><p className="muted small">Add actual contributions in Budget to build your progress. These are your recorded allocations, not verified bank balances.</p><div className="goal-list">{ledger.savingsBuckets.map(bucket => { const balance = balances.get(bucket.id) ?? 0n, target = amount(bucket.target), percent = Math.max(0, Math.min(100, Number(balance * 100n / target))); return <div className={`goal-row ${bucket.isActive ? '' : 'archived'}`} key={bucket.id}><div className="goal-icon" aria-hidden="true">{bucket.name.toLowerCase().includes('car') ? '↗' : '◎'}</div><button className="goal-copy" onClick={() => open(bucket)}><strong>{bucket.name}{!bucket.isActive && <small>Archived</small>}</strong><span className={balance < 0n ? 'negative' : ''}>{formatMoney(balance)} <span className="muted">/ {formatMoney(target)}</span></span><progress className="goal-progress" max="100" value={percent} aria-label={`${bucket.name}: ${Math.round(percent)} percent saved`}/></button><div className="goal-actions"><button className="text-button" onClick={() => open(bucket)}>Edit</button><button className="text-button" onClick={() => update({ ...ledger, savingsBuckets: ledger.savingsBuckets.map(b => b.id === bucket.id ? { ...b, isActive: !b.isActive } : b) })}>{bucket.isActive ? 'Archive' : 'Reactivate'}</button></div></div>; })}</div>{!ledger.savingsBuckets.length && <Empty title="Dream a little" text="A car, a holiday, a rainy day. Create a goal and start with your next pay period."/>}</section><p className="footer-note">Archiving keeps every contribution and withdrawal. You can still pull from an archived goal in Budget.</p>{draft && <Modal title={ledger.savingsBuckets.some(b => b.id === draft.id) ? 'Edit savings goal' : 'New savings goal'} onClose={() => setDraft(null)}><form onSubmit={save}><label className="field">Goal name<input required maxLength={60} placeholder="A new car" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><Money label="Target" value={draft.target} onChange={target => setDraft({ ...draft, target })}/><label className="check-row"><input type="checkbox" checked={draft.isActive} onChange={e => setDraft({ ...draft, isActive: e.target.checked })}/>Active goal</label>{error && <p className="error" role="alert">{error}</p>}<button className="primary full" disabled={!draft.name.trim() || parseMoney(draft.target) === null || amount(draft.target) <= 0n}>Save goal</button></form></Modal>}</>;
}

function Schedule({ ledger, update, monthID }: { ledger: Ledger; update: (l: Ledger) => void; monthID?: string }) {
  const month = monthID ? planningMonth(ledger, monthID) : currentMonth(ledger);
  const [frequency, setFrequency] = useState<PayFrequency>(month.paySchedule.frequency), [days, setDays] = useState<string[]>(month.paySchedule.days.map(String)), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const count = { monthly: 1, biWeekly: 2, weekly: 4 }[frequency];
  return <section className="card settings-card"><h2>Pay schedule · {fullMonth(month.id)}</h2>
    <p className="muted small">Choose pay dates for this month. Each forecast month keeps its own schedule.</p>
    <form onSubmit={event => { event.preventDefault(); setError(""); try {
      const next = applySchedule(month, { frequency, days: Array.from({ length: count }, (_, i) => Number(days[i] ?? "")) });
      const copy = savePlanningMonth(ledger, next);
      if (month.id === monthId()) copy.payFrequency = frequency;
      validateLedger(copy); update(copy); setSaved(true);
    } catch { setError("Choose a different valid day for every pay date in this month."); } }}>
      <label className="field">Frequency<select aria-label="Frequency" value={frequency} onChange={event => { setFrequency(event.target.value as PayFrequency); setDays([]); setSaved(false); }}>
        <option value="monthly">Monthly · 1 period</option><option value="biWeekly">Bi-Weekly · 2 periods</option><option value="weekly">Weekly · 4 periods</option>
      </select></label>
      <div className="schedule-days">{Array.from({ length: count }, (_, i) => <label className="field" key={i}>Pay date {i + 1}<input type="number" min="1" max="31" required value={days[i] ?? ""} placeholder="Day" onChange={event => { setDays(previous => Array.from({ length: count }, (_, n) => n === i ? event.target.value : previous[n] ?? "")); setSaved(false); }}/></label>)}</div>
      <p className="muted small">The first period begins on day 1; later pay dates begin the next periods. Reducing periods combines existing amounts without discarding them.</p>
      {error && <p className="error" role="alert">{error}</p>}{saved && <p className="success" role="status">Schedule updated.</p>}<button className="primary">Save schedule</button>
    </form></section>;
}

function ExportPanel({ session, ledger }: { session: BudgetSession; ledger: Ledger }) {
  const [selected, setSelected] = useState<string[]>([currentMonth(ledger).id]), [notes, setNotes] = useState(false), [pin, setPin] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function download(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (!selected.length || pin.length !== 4) throw new Error('Select a month and enter your app passcode.');
      // Recheck the PIN on the server. The page never stores it or counts failed attempts locally.
      if (!await session.reauthenticate(pin)) return;
      setPin(''); await session.flush();
      const before = session.snapshot();
      if (before.phase !== 'ready' || !before.ledger || before.saving) throw new Error('Unlock your latest budget before exporting.');
      const audit = { id: uuid(), createdAt: new Date().toISOString(), monthIds: [...selected], status: 'downloadRequested' as const };
      if (before.ledger.exportHistory.length >= 1000) throw new Error('The export audit history is full. Contact the application owner.');
      session.edit({ ...before.ledger, exportHistory: [...before.ledger.exportHistory, audit] });
      await session.flush();
      const after = session.snapshot();
      if (after.phase !== 'ready' || !after.ledger || after.saving || after.epoch !== before.epoch || !after.ledger.exportHistory.some(item => item.id === audit.id)) throw new Error('The export request could not be saved. Unlock and try again.');
      const bytes = exportWorkbook(after.ledger, { monthIds: selected, includeNotes: notes, createdAt: new Date(audit.createdAt) });
      const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `Budget-${selected.length === 1 ? selected[0] : 'selected-months'}.xlsx`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Download requested. Your browser controls where the file is saved.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The export could not be created.'); }
    finally { setPin(''); setBusy(false); }
  }
  return <section className="card settings-card"><h2>Export to Excel</h2><p className="muted small">Select only the months you want to share. Notes are excluded unless you choose to include them.</p><form onSubmit={download}><div className="export-months" role="group" aria-label="Months to export">{[...ledger.months].sort((a, b) => b.id.localeCompare(a.id)).map(month => <label className="check-row" key={month.id}><input type="checkbox" checked={selected.includes(month.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, month.id] : previous.filter(id => id !== month.id))}/>{fullMonth(month.id)}</label>)}</div><label className="check-row"><input type="checkbox" checked={notes} onChange={e => setNotes(e.target.checked)}/>Include transaction notes</label><Pin label="Confirm app passcode to export" value={pin} onChange={setPin}/><p className="privacy-note">The file contains financial information and is not encrypted. Account deletion cannot remove downloaded copies. A metadata-only export request is saved to your account before the download starts.</p><button className="primary" disabled={busy || !selected.length || pin.length !== 4}>{busy ? 'Preparing report…' : 'Download .xlsx'}</button>{message && <p className="small" role="status">{message}</p>}</form>{ledger.exportHistory.length > 0 && <p className="muted small">{ledger.exportHistory.length} export request{ledger.exportHistory.length === 1 ? '' : 's'} recorded · Last request {new Date(ledger.exportHistory.at(-1)!.createdAt).toLocaleDateString()}</p>}</section>;
}

function Settings({ session, ledger, signOut }: { session: BudgetSession; ledger: Ledger; signOut: () => void }) {
  const [pin, setPin] = useState(''), [next, setNext] = useState(''), [confirmPin, setConfirmPin] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [erase, setErase] = useState(false), [phrase, setPhrase] = useState('');
  return <><PageHeading title="A little housekeeping" subtitle="Your schedule, security, and data. All in one place."/><div className="setting-grid"><Schedule ledger={ledger} update={l => session.edit(l)}/><section className="card settings-card"><h2>App passcode</h2><p className="muted small">Your account password connects your devices. Your four-digit app passcode unlocks your financial records.</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); setMessage(''); const changed = await session.setPin(pin, next); setPin(''); setNext(''); setConfirmPin(''); setBusy(false); if (changed) setMessage('Your app passcode has been changed on all devices.'); }}><Pin label="Current app passcode" value={pin} onChange={setPin}/><div className="inline-fields"><Pin label="New app passcode" value={next} onChange={setNext}/><Pin label="Confirm new passcode" value={confirmPin} onChange={setConfirmPin}/></div><p className="privacy-note">Three consecutive incorrect app passcodes erase this account and its budget across connected devices. Wrong account passwords are rate-limited instead.</p><button className="primary" disabled={busy || pin.length !== 4 || next.length !== 4 || next !== confirmPin}>{busy ? 'Updating…' : 'Change passcode'}</button>{message && <p className="success small" role="status">{message}</p>}</form></section><ExportPanel session={session} ledger={ledger}/><section className="card settings-card"><h2>Private by design</h2><ul className="privacy-list"><li>Your account token, encryption key, and open budget stay in this page’s memory. Signing out removes them from the app.</li><li>Hiding the page clears the open budget and its unlock grant. Your encryption key stays in memory until you sign out or close the page.</li><li>Your account is checked every 15 seconds while visible. Erased or changed records clear the open budget.</li><li>Budgets are encrypted on this device before syncing. Your password and decryption key are never uploaded. No bank or AI service is connected.</li></ul><div className="form-actions"><button onClick={() => session.lock()}>Lock budget</button><button onClick={signOut}>Sign out</button></div><hr/><h3 className="negative">Erase account budget data</h3><p className="muted small">Erase your account login, encrypted budget, goals, passcode, and export request history across connected devices. Exported files and provider backups follow their own retention policies.</p><button className="danger-button" onClick={() => { setPhrase(''); setErase(true); }}>Erase budget data…</button></section></div>{erase && <Modal title="Erase your budget data?" onClose={() => setErase(false)}><p>This permanently erases your account login and encrypted budget. You will need to create an account again to start an empty budget. Connected devices discard their old records when they next reach the server.</p><label className="field">Type ERASE to confirm<input autoComplete="off" value={phrase} onChange={e => setPhrase(e.target.value)}/></label><button className="danger-button full" disabled={phrase !== 'ERASE' || busy} onClick={async () => { setBusy(true); await session.erase(); setBusy(false); setErase(false); }}>Erase account budget data</button></Modal>}</>;
}

function BudgetApp({ session, signOut }: { session: BudgetSession; signOut: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot), [page, setPage] = useState<Page>('home');
  useEffect(() => {
    void session.checkStatus();
    const poll = window.setInterval(() => { if (!document.hidden) void session.checkStatus(); }, 15_000);
    const visibility = () => { if (document.hidden) session.lock(); else void session.checkStatus(); };
    const leave = () => session.lock();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', leave);
    return () => { clearInterval(poll); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', leave); session.dispose(); };
  }, [session]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [page]);
  if (state.phase !== 'ready' || !state.ledger) return <SecurityPanel session={session} onSignOut={signOut}/>;
  const ledger = state.ledger;
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="#home" onClick={e => { e.preventDefault(); setPage('home'); }}><span className="brand-mark">B</span><span>Budget<small>A little more possible.</small></span></a><nav className="navigation" aria-label="Main navigation">{pageNames.map(([id, name, icon]) => <button key={id} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{name}</span></button>)}</nav><div className="sidebar-bottom"><div className="sidebar-note"><span aria-hidden="true">◇</span><strong>A space for your money.</strong><p>Plan thoughtfully.<br/>Make room for what matters.</p></div><button onClick={() => session.lock()}><span aria-hidden="true">♧</span> Lock your budget</button></div></aside><div className="content"><header className="topbar"><span className="muted">Your personal money space</span><div><span className="sync-status" role="status"><i/>{state.saving ? 'Saving securely…' : 'Encrypted sync'}</span><button className="avatar" aria-label="Open account settings" onClick={() => setPage('settings')}>B</button></div></header><main id="main" className="page-content">{state.message && <p className="status-alert" role="alert">{state.message}</p>}{page === 'home' && <Overview ledger={ledger}/>} {page === 'budget' && <Budget ledger={ledger} update={l => session.edit(l)}/>} {page === 'transactions' && <Transactions ledger={ledger} update={l => session.edit(l)}/>} {page === 'trends' && <Trends ledger={ledger}/>} {page === 'goals' && <Goals ledger={ledger} update={l => session.edit(l)}/>} {page === 'settings' && <Settings session={session} ledger={ledger} signOut={signOut}/>}<p className="footer-note">A clear plan. A little peace of mind.</p></main></div></div>;
}

function SetupScreen({ error = '' }: { error?: string }) {
  return <main className="setup-shell">
    <a className="brand" href="/"><span className="brand-mark">B</span><span>Budget</span></a>
    <div className="setup-grid">
      <section className="setup-copy">
        <p className="eyebrow">Your money, with a plan</p>
        <h1>A little clarity.<br/>A lot more possible<span className="accent">.</span></h1>
        <p>A private place for everyday spending, thoughtful plans, and the things you’re saving for.</p>
        <div className="setup-features"><span>◎ Savings goals</span><span>▤ Flexible pay periods</span><span>⌁ Clear spending trends</span></div>
      </section>
      <section className="setup-card">
        <p className="eyebrow">Getting ready</p>
        <h2>Sign-in isn’t available yet</h2>
        <p className="muted">This website’s account service has not been connected. Once it is ready, you can create a budget-app account and use the same login on your devices.</p>
        {error && <p className="error" role="status">{error}</p>}
        <p className="privacy-note">You won’t need a Microsoft or Azure account. No financial records have been loaded.</p>
      </section>
    </div>
    <p className="footer-note">Private records. Purposeful plans.</p>
  </main>;
}

function AccountLogin({ config, security, onSignIn }: { config: PublicConfig; security: SecurityMonitor; onSignIn: (session: BudgetSession) => void }) {
  const [create, setCreate] = useState(false), [username, setUsername] = useState('');
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (create && password !== confirmation) { setError('The passwords do not match.'); return; }
    const version = generation.current, serviceVersion = security.snapshot().version;
    setBusy(true); setError('');
    try {
      const auth = await authenticate(config, username, password, create, fetch.bind(globalThis), security);
      const session = new BudgetSession(new BudgetApi(config, auth, fetch.bind(globalThis), security));
      if (version !== generation.current || security.snapshot().phase !== 'open' || security.snapshot().version !== serviceVersion) { session.emergencyDiscard(); return; }
      setPassword(''); setConfirmation('');
      onSignIn(session);
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : 'The secure connection is unavailable. Try again.');
    } finally {
      if (version === generation.current) { setBusy(false); setPassword(''); setConfirmation(''); }
    }
  }
  return <main className="entry-shell"><section className="entry-card">
    <div className="brand-mark">B</div>
    <p className="eyebrow">Your private budget</p>
    <h1>{create ? 'Make room for your goals' : 'Welcome back'}<span className="accent">.</span></h1>
    <p className="muted">{create ? 'Create your budget-app account. Use the same login on your other devices.' : 'Sign in to your budget-app account to connect your devices.'}</p>
    <form onSubmit={submit} autoComplete="off">
      <label className="field">Username<input name="username" value={username} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={64} required disabled={busy} onChange={e => setUsername(e.target.value)}/><span className="muted">3–64 letters, numbers, dots, underscores, or hyphens.</span></label>
      <label className="field">Account password<input name="password" type="password" autoComplete="off" minLength={12} maxLength={128} required value={password} disabled={busy} onChange={e => setPassword(e.target.value)}/>{create && <span className="muted">Use 12–128 characters. This password protects your encrypted budget and cannot be recovered or reset.</span>}</label>
      {create && <label className="field">Confirm account password<input name="confirm-password" type="password" autoComplete="off" minLength={12} maxLength={128} required value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)}/></label>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? 'Connecting securely…' : create ? 'Create account' : 'Sign in'}</button>
    </form>
    <button className="text-button" disabled={busy} onClick={() => { setCreate(!create); setPassword(''); setConfirmation(''); setError(''); }}>{create ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
    <p className="privacy-note">Your password stays on this device. Budget records are encrypted before syncing. No AI service is connected.</p>
    {!create && <p className="privacy-note">Forgot your account password? It cannot be recovered or reset because it protects your budget’s encryption key.</p>}
  </section></main>;
}

function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/config.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
        if (!response.ok) throw new Error('The account service configuration is unavailable.');
        const publicConfig = validatePublicConfig(await response.json());
        if (!controller.signal.aborted) setConfig(publicConfig);
      } catch {
        if (!controller.signal.aborted) setError('The account service configuration could not be loaded. Please try again later.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, []);
  if (loading) return <main className="entry-shell"><div className="entry-card"><div className="brand-mark">B</div><p role="status">Preparing your private money space…</p></div></main>;
  if (!config) return <SetupScreen error={error}/>;
  return <ConnectedApp config={config}/>;
}

function ConnectedApp({ config }: { config: PublicConfig }) {
  const [security] = useState(() => new SecurityMonitor(config));
  const service = useSyncExternalStore(security.subscribe, security.snapshot);
  const [session, setSession] = useState<BudgetSession | null>(null);
  const current = useRef(session); current.current = session;
  useEffect(() => {
    let version = security.snapshot().version;
    const unsubscribe = security.subscribe(() => {
      const state = security.snapshot();
      if (state.phase === 'locked' || state.phase === 'unavailable' || state.version !== version) {
        // Normal visibility checks retain the bounded encrypted save; incidents never do.
        current.current?.emergencyDiscard(); current.current = null; setSession(null);
      }
      version = state.version;
    });
    const stop = security.start();
    return () => { unsubscribe(); stop(); current.current?.emergencyDiscard(); };
  }, [security]);
  function signOut() { session?.dispose(); current.current = null; setSession(null); }
  return <>{service.phase !== 'open' && <main className="entry-shell"><section className="entry-card">
    <div className="brand-mark">B</div><p className="eyebrow">Your private budget</p>
    <h1>{service.phase === 'locked' ? 'Unscheduled Maintenance' : service.phase === 'checking' ? 'Checking availability' : 'Service temporarily unavailable'}</h1>
    <p role="status" className="muted">{service.phase === 'locked' ? LOCKDOWN_MESSAGE : service.phase === 'checking' ? 'Please wait while we check service availability.' : SECURITY_UNAVAILABLE_MESSAGE}</p>
    {service.phase !== 'checking' && <button className="primary full" onClick={() => { if (config.securityGateRequired) void security.check(); else window.location.reload(); }}>Check again</button>}
  </section></main>}
  {session ? <div hidden={service.phase !== 'open'}><BudgetApp session={session} signOut={signOut}/></div>
    : service.phase === 'open' && <AccountLogin key={service.version} config={config} security={security} onSignIn={setSession}/>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App/>);
