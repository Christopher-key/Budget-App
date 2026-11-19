import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { ExpenseEntry, FixedPayment, Ledger, MonthlyBudget } from '../../shared/contracts.js';
import { appliedFixedPayments, saveFixedPayment, setFixedPaymentApplied, setFixedPaymentBudget } from '../../shared/fixed-payments.js';
import { daysInMonth, formatMoney, monthId, parseMoney, windows } from '../../shared/model.js';
import { parseAnnualRate } from '../../shared/interest.js';
import { activeExpenseCategories } from '../../shared/categories.js';
import { estimatePayoff } from '../../shared/payoff.js';
import { Modal, Money } from './controls.js';
import { PaymentExpenseDialog } from './PaymentEntry.js';
import './payments.css';

const money = (value: string) => {
  const amount = parseMoney(value);
  return amount === null ? '—' : formatMoney(amount);
};

function PayoffDetails({ payment, compact = false }: { payment: FixedPayment; compact?: boolean }) {
  const estimate = useMemo(() => {
    if (!payment.payoffBalance.trim()) return null;
    try { return estimatePayoff(payment.payoffBalance, payment.monthlyAmount, payment.annualRate, payment.rateType); }
    catch { return null; }
  }, [payment.payoffBalance, payment.monthlyAmount, payment.annualRate, payment.rateType]);
  if (!payment.payoffBalance.trim()) return compact ? null : <p className="muted small">Recurring monthly payment · no payoff balance tracked.</p>;
  if (!estimate) return <p className="muted small">Enter a valid payoff balance, monthly payment and yearly rate to estimate payments remaining.</p>;
  let remaining: string;
  if (estimate.status === 'paidOff') remaining = 'Paid off · 0 payments remaining';
  else if (estimate.status === 'estimated') remaining = `${estimate.paymentsRemaining} estimated payment${estimate.paymentsRemaining === 1 ? '' : 's'} remaining`;
  else if (estimate.status === 'nonAmortizing') remaining = 'Payment does not reduce the balance at this rate';
  else remaining = 'Payoff is beyond the 1,200-month estimate limit';
  if (compact) return <small className={estimate.status === 'nonAmortizing' ? 'error' : 'muted'}>{money(payment.payoffBalance)} left · {remaining}</small>;
  return <div className="payment-payoff" aria-live="polite">
    <div><span className="muted">Remaining payoff balance</span><strong>{money(payment.payoffBalance)}</strong></div>
    <p className={estimate.status === 'nonAmortizing' ? 'error small' : 'payment-count'}>{remaining}</p>
    {estimate.status === 'estimated' && <dl>
      <div><dt>Estimated final payment</dt><dd>{formatMoney(estimate.finalPayment)}</dd></div>
      <div><dt>Estimated remaining interest</dt><dd>{formatMoney(estimate.totalInterest)}</dd></div>
    </dl>}
    <p className="muted small">{payment.annualRate}% {payment.rateType.toUpperCase()} · monthly interest estimate</p>
  </div>;
}

export function PaymentManager({ ledger, update }: { ledger: Ledger; update: (next: Ledger) => void }) {
  const payments = ledger.fixedPayments ?? [];
  const categories = activeExpenseCategories(ledger);
  const [draft, setDraft] = useState<FixedPayment | null>(null), [tracking, setTracking] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const committing = useRef(false);
  const original = useRef<string | null>(null);
  function open(payment?: FixedPayment) {
    committing.current = false; setError(''); setMessage('');
    original.current = payment ? JSON.stringify(payment) : null;
    setTracking(Boolean(payment?.payoffBalance.trim()));
    setDraft(payment ? structuredClone(payment) : {
      id: crypto.randomUUID(), name: '', category: categories.includes('Car') ? 'Car' : categories[0] ?? '', monthlyAmount: '', dueDay: 1,
      startMonth: monthId(), endMonth: '', isApplied: false,
      payoffBalance: '', annualRate: '0', rateType: 'apr', history: [],
    });
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (!draft || committing.current) return;
    setError('');
    if (original.current !== null && JSON.stringify(payments.find(payment => payment.id === draft.id)) !== original.current) {
      setError('This payment changed while you were editing. Close this form and reopen it to use the latest details.'); return;
    }
    if (tracking && (!draft.payoffBalance.trim() || parseMoney(draft.payoffBalance) === null)) {
      setError('Enter a non-negative remaining payoff balance, or turn off payoff tracking.'); return;
    }
    try {
      committing.current = true;
      update(saveFixedPayment(ledger, { ...draft, payoffBalance: tracking ? draft.payoffBalance : '',
        annualRate: tracking ? draft.annualRate : (draft.annualRate.trim() || '0') }));
      setDraft(null); setMessage('Fixed payment saved. Use the category reminders in Budget to set planned amounts or apply an actual payment.');
    } catch (failure) {
      committing.current = false;
      setError(failure instanceof Error ? failure.message : 'Check the payment details before saving.');
    }
  }
  function apply(payment: FixedPayment) {
    setError(''); setMessage('');
    try { update(setFixedPaymentApplied(ledger, payment.id, !payment.isApplied)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The payment could not be updated.'); }
  }
  const manualCategoryAmount = draft ? (ledger.months.find(month => month.id === monthId())?.periods ?? [])
    .flatMap(period => period.budgeted.expenses)
    .filter(entry => !entry.fixedPaymentId && entry.name === draft.category)
    .reduce((total, entry) => total + (parseMoney(entry.amount) ?? 0n), 0n) : 0n;
  const invalidRate = Boolean(draft && tracking && draft.annualRate.trim() && parseAnnualRate(draft.annualRate) === null);
  return <section className="card payment-manager" aria-labelledby="fixed-payments-heading">
    <div className="section-heading"><h2 id="fixed-payments-heading">Fixed monthly payments</h2>
      <button className="primary" disabled={!categories.length} onClick={() => open()}>+ Fixed payment</button></div>
    <p className="muted small">Save loans, leases, insurance and other fixed costs. Reminders appear beside their expense categories in Budget and on Home. Set Budgeted amounts and apply actual payments separately when you choose.</p>
    {!payments.length && <p className="muted small">Add a monthly amount, then optionally track a payoff balance and interest.</p>}
    {!categories.length && <p className="muted small">Add or restore an expense category in Budget → Manage expenses before creating a fixed payment.</p>}
    <div className="payment-list">{payments.map(payment => <article className="payment-row" key={payment.id}>
      <div className="payment-row-heading"><div><h3>{payment.name}</h3>
        <p className="muted small">{payment.category} · Due day {payment.dueDay} · {payment.isApplied ? 'Reminders shown' : 'Reminders hidden'}<br/>
          From {payment.startMonth}{payment.endMonth ? ` through ${payment.endMonth}` : ''}</p></div>
        <strong>{money(payment.monthlyAmount)}<small className="muted"> / month</small></strong></div>
      <PayoffDetails payment={payment}/>
      <div className="payment-actions">
        <button className="secondary" aria-label={`Edit ${payment.name}`} onClick={() => open(payment)}>Edit</button>
        <button className="secondary" aria-label={`${payment.isApplied ? 'Hide' : 'Show'} payment reminders for ${payment.name}`} onClick={() => apply(payment)}>{payment.isApplied ? 'Hide payment reminders' : 'Show payment reminders'}</button>
        {(payment.history.some(item => item.budgetMonth === monthId()) || (payment.isApplied && categories.includes(payment.category) && payment.startMonth <= monthId() && (!payment.endMonth || monthId() <= payment.endMonth))) && <button className="secondary" aria-label={`${payment.history.some(item => item.budgetMonth === monthId()) ? 'Update' : 'Apply'} payment for ${payment.name}`} onClick={() => { setError(''); setMessage(''); setPaying(payment.id); }}>{payment.history.some(item => item.budgetMonth === monthId()) ? 'Update payment' : 'Apply payment'}</button>}
      </div>
      {payment.history.length > 0 && <details className="payment-history"><summary>Payment history ({payment.history.length})</summary>
        <ul>{payment.history.slice(-5).reverse().map(item => <li key={item.id}>
          <strong>{money(item.amount)}</strong> · {item.budgetMonth ? item.date.slice(0, 10) : new Date(item.date).toLocaleDateString()}<br/>
          <span className="muted">{item.budgetMonth ? `Linked expense · ${item.budgetMonth}` : 'Tracker-only · expense not recorded'}{item.kind !== 'recurring' && <> · Interest {money(item.interest ?? '')} · Principal {money(item.principal ?? '')} · Balance after {money(item.balanceAfter ?? '')}</>}</span>
        </li>)}</ul>{payment.history.length > 5 && <p className="muted small">Showing the five latest payments.</p>}
      </details>}
    </article>)}</div>
    {!draft && !paying && error && <p className="error" role="alert">{error}</p>}
    {message && <p className="small success" role="status">{message}</p>}
    <p className="muted small payment-assumptions">Payoff estimates assume the same monthly payment and rate, with monthly interest added before each payment. Fees, daily interest and lender terms can change the result. Update the payoff balance from your statement when needed.</p>
    {draft && <Modal title={payments.some(payment => payment.id === draft.id) ? 'Edit fixed payment' : 'New fixed payment'} onClose={() => setDraft(null)}>
      <form onSubmit={save}>
        <label className="field">Payment name<input aria-label="Payment name" required maxLength={60} placeholder="Car loan, lease, insurance…" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
        <Money label="Monthly payment" value={draft.monthlyAmount} onChange={monthlyAmount => setDraft({ ...draft, monthlyAmount })}/>
        <div className="inline-fields">
          <label className="field">Expense category<select aria-label="Expense category" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}>{[...new Set([...categories, draft.category].filter(Boolean))].map(category => <option key={category} value={category}>{category}{categories.includes(category) ? '' : ' (removed)'}</option>)}</select></label>
          <label className="field">Due day of month<input aria-label="Due day of month" type="number" required min="1" max="31" value={draft.dueDay || ''} onChange={event => setDraft({ ...draft, dueDay: Number(event.target.value) })}/></label>
        </div>
        <p className="muted small">A due day beyond a shorter month's last day uses that month's final day.</p>
        <div className="inline-fields">
          <label className="field">Starting month<input aria-label="Starting month" type="month" required value={draft.startMonth} onChange={event => setDraft({ ...draft, startMonth: event.target.value })}/></label>
          <label className="field">Final month (optional)<input aria-label="Final month (optional)" type="month" min={draft.startMonth} value={draft.endMonth} onChange={event => setDraft({ ...draft, endMonth: event.target.value })}/></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={draft.isApplied} disabled={!categories.includes(draft.category)} onChange={event => setDraft({ ...draft, isApplied: event.target.checked })}/>Show payment reminders</label>
        {!categories.includes(draft.category) && <p className="muted small">This category was removed. Choose an active category above or restore it in Budget → Manage expenses before applying this payment.</p>}
        <p className="muted small">Saving reminders does not add expenses or change your planned amounts. Use Set budget or Apply payment beside the category in Budget when ready. Existing plans and recorded payments stay saved.</p>
        {draft.isApplied && manualCategoryAmount > 0n && <p className="privacy-note">You already have {formatMoney(manualCategoryAmount)} entered manually for {draft.category} this month. Check whether it includes this payment before setting an additional budget.</p>}
        <label className="check-row"><input type="checkbox" checked={tracking} onChange={event => setTracking(event.target.checked)}/>Track an optional payoff balance</label>
        {tracking && <div className="payment-tracking-fields">
          <Money label="Remaining payoff balance" value={draft.payoffBalance} onChange={payoffBalance => setDraft({ ...draft, payoffBalance })}/>
          <div className="inline-fields">
            <label className="field">Interest rate type<select aria-label="Interest rate type" value={draft.rateType} onChange={event => setDraft({ ...draft, rateType: event.target.value as FixedPayment['rateType'] })}><option value="apr">APR</option><option value="apy">APY</option></select></label>
            <label className="field">Yearly interest rate (%)<input aria-label="Yearly interest rate (%)" inputMode="decimal" required maxLength={12} aria-invalid={invalidRate} value={draft.annualRate} onChange={event => setDraft({ ...draft, annualRate: event.target.value })}/></label>
          </div>
          {invalidRate && <p className="error">Enter a yearly rate from 0% to 100% with up to four decimal places.</p>}
          <p className="muted small">Use 0 for an interest-free payoff. APY is converted to an equivalent monthly rate.</p>
          <PayoffDetails payment={draft}/>
        </div>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary full" disabled={!draft.category || !draft.name.trim() || !draft.monthlyAmount.trim() || parseMoney(draft.monthlyAmount) === null || (parseMoney(draft.monthlyAmount) ?? 0n) <= 0n || (tracking && (!draft.payoffBalance.trim() || invalidRate))}>Save fixed payment</button>
      </form>
    </Modal>}
    {paying && <PaymentExpenseDialog ledger={ledger} paymentId={paying} monthID={monthId()} update={update} onClose={() => setPaying(null)}/>}
  </section>;
}

export function PaymentPreview({ ledger, monthID }: { ledger: Ledger; monthID: string }) {
  const payments = appliedFixedPayments(ledger, monthID);
  if (!payments.length) return null;
  return <section className="card payments-preview" aria-label="Fixed monthly payment reminders">
    <h2>Fixed monthly payments</h2>
    {payments.map(payment => <div className="payment-preview-row" key={payment.id}>
      <div><strong>{payment.name}</strong><small className="muted">{payment.category} · Due day {Math.min(payment.dueDay, daysInMonth(monthID))}</small>
        <PayoffDetails payment={payment} compact/></div>
      <strong>{money(payment.monthlyAmount)}<small className="muted"> / month</small></strong>
    </div>)}
  </section>;
}

export interface PaymentNotice {
  id: string;
  category: string;
  actualCategory: string;
  name: string;
  dueDay: number;
  payment?: FixedPayment;
  snapshot?: ExpenseEntry;
}

/** Keep saved plans visible even when a reminder is hidden or its category is retired. */
export function paymentNoticesForPeriod(ledger: Ledger, month: MonthlyBudget, periodIndex: number): PaymentNotice[] {
  const notices = new Map<string, PaymentNotice>();
  const snapshots = new Map<string, { entry: ExpenseEntry; periodIndex: number }>();
  month.periods.forEach((period, index) => period.budgeted.expenses.forEach(entry => {
    if (entry.fixedPaymentId) snapshots.set(entry.fixedPaymentId, { entry, periodIndex: index });
  }));
  const period = windows(month)[periodIndex];
  for (const [id, saved] of snapshots) if (saved.periodIndex === periodIndex) {
    const payment = ledger.fixedPayments?.find(item => item.id === id);
    const transaction = month.transactions.find(item => item.fixedPaymentId === id);
    notices.set(id, { id, category: saved.entry.name, actualCategory: transaction?.category ?? payment?.category ?? saved.entry.name, name: saved.entry.fixedPaymentName ?? payment?.name ?? saved.entry.name,
      dueDay: saved.entry.fixedDueDay ?? payment?.dueDay ?? 1, payment, snapshot: saved.entry });
  }
  if (month.id === monthId() || month.id > monthId()) for (const payment of ledger.fixedPayments ?? []) {
    if (snapshots.has(payment.id)) continue;
    const recorded = payment.history.some(item => item.budgetMonth === month.id);
    const scheduled = payment.isApplied && payment.startMonth <= month.id && (!payment.endMonth || month.id <= payment.endMonth);
    if (!scheduled && !recorded) continue;
    const day = Math.min(payment.dueDay, daysInMonth(month.id));
    if (!period || day < period.startDay || day > period.endDay) continue;
    const transaction = month.transactions.find(item => item.fixedPaymentId === payment.id);
    notices.set(payment.id, { id: payment.id, category: payment.category, actualCategory: transaction?.category ?? payment.category, name: payment.name, dueDay: payment.dueDay, payment });
  }
  return [...notices.values()];
}

function PaymentBudgetDialog({ ledger, notice, monthID, update, onClose }: {
  ledger: Ledger; notice: PaymentNotice; monthID: string; update: (next: Ledger) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(notice.snapshot?.amount ?? notice.payment?.monthlyAmount ?? '');
  const [error, setError] = useState('');
  const committing = useRef(false);
  const original = useRef(JSON.stringify(ledger.fixedPayments?.find(item => item.id === notice.id)));
  const originalPlan = useRef(JSON.stringify(ledger.months.find(month => month.id === monthID)?.periods.flatMap(period => period.budgeted.expenses).filter(entry => entry.fixedPaymentId === notice.id)));
  const manualAmount = ledger.months.find(month => month.id === monthID)?.periods.flatMap(period => period.budgeted.expenses)
    .filter(entry => !entry.fixedPaymentId && entry.name === notice.category)
    .reduce((sum, entry) => sum + (parseMoney(entry.amount) ?? 0n), 0n) ?? 0n;
  function save(amount: string) {
    if (committing.current) return;
    try {
      if (original.current !== JSON.stringify(ledger.fixedPayments?.find(item => item.id === notice.id))) throw new Error('This payment changed while the form was open. Close it and reopen the latest payment.');
      if (originalPlan.current !== JSON.stringify(ledger.months.find(month => month.id === monthID)?.periods.flatMap(period => period.budgeted.expenses).filter(entry => entry.fixedPaymentId === notice.id))) throw new Error('This planned amount changed while the form was open. Close it and reopen the latest plan.');
      committing.current = true;
      update(setFixedPaymentBudget(ledger, notice.id, monthID, amount)); onClose();
    } catch (failure) {
      committing.current = false; setError(failure instanceof Error ? failure.message : 'The budget could not be saved.');
    }
  }
  return <Modal title={`${notice.snapshot ? 'Change' : 'Set'} budget · ${notice.name}`} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); save(value); }}>
      <p className="muted small">Set this payment's planned expense for {monthID}. This does not record an actual payment or change the payoff tracker.</p>
      <Money label="Budgeted payment" value={value} onChange={setValue}/>
      {notice.payment && <button type="button" className="text-button payment-scheduled" onClick={() => setValue(notice.payment!.monthlyAmount)}>Use scheduled amount ({money(notice.payment.monthlyAmount)})</button>}
      {manualAmount > 0n && <p className="privacy-note">{notice.category} already has {formatMoney(manualAmount)} entered manually this month. This planned payment is additional. Adjust the manual amount if it already includes this payment.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={!value.trim() || parseMoney(value) === null}>Save budget</button>
      {notice.snapshot && <button type="button" className="text-button payment-undo" onClick={() => save('0')}>Clear this payment's budget</button>}
    </form>
  </Modal>;
}

export function FixedPaymentNotices({ ledger, monthID, notices, category, budgeted, update }: {
  ledger: Ledger; monthID: string; notices: PaymentNotice[]; category: string; budgeted: boolean; update: (next: Ledger) => void;
}) {
  const [budgeting, setBudgeting] = useState<PaymentNotice | null>(null), [paying, setPaying] = useState<string | null>(null);
  const rows = notices.filter(notice => notice.category === category);
  if (!rows.length) return null;
  const editableBudget = monthID >= monthId(), editableActual = monthID === monthId();
  return <div className="fixed-payment-notices" aria-label={`Fixed payments for ${category}`}>
    {rows.map(notice => {
      const recorded = notice.payment?.history.find(item => item.budgetMonth === monthID);
      const eligible = notice.payment && (recorded || (notice.payment.isApplied && activeExpenseCategories(ledger).includes(notice.payment.category)
        && notice.payment.startMonth <= monthID && (!notice.payment.endMonth || monthID <= notice.payment.endMonth)));
      return <div className="fixed-payment-notice" key={notice.id}>
        <div className="fixed-payment-notice-heading"><strong>{notice.name}</strong><span className="muted">Due day {Math.min(notice.dueDay, daysInMonth(monthID))}</span></div>
        <p className="muted small">{notice.payment && monthID >= monthId() ? `Scheduled ${money(notice.payment.monthlyAmount)}` : 'Saved fixed payment'}{notice.payment && !notice.payment.isApplied ? ' · Reminders hidden' : ''}</p>
        {budgeted ? <>
          <p className="small">{notice.snapshot ? <>Stored budget: <strong>{money(notice.snapshot.amount)}</strong></> : 'No budget set for this payment.'}</p>
          {notice.payment && editableBudget ? <button className="secondary" aria-label={`${notice.snapshot ? 'Change' : 'Set'} budget for ${notice.name}`} onClick={() => setBudgeting(notice)}>{notice.snapshot ? 'Change budget' : 'Set budget'}</button> : <small className="muted">Saved plan · read only</small>}
        </> : <>
          <p className="small">{recorded ? <>Recorded this month: <strong>{money(recorded.amount)}</strong> · {recorded.date.slice(0, 10)}</> : 'No actual payment recorded this month.'}</p>
          {eligible && editableActual ? <button className="secondary" aria-label={`${recorded ? 'Update' : 'Apply'} payment for ${notice.name}`} onClick={() => setPaying(notice.id)}>{recorded ? 'Update payment' : 'Apply payment'}</button> : <small className="muted">{editableActual ? 'Manage payment reminders in Savings & Payoffs to apply an actual payment.' : 'Saved history · read only'}</small>}
        </>}
      </div>;
    })}
    {budgeting && <PaymentBudgetDialog ledger={ledger} notice={budgeting} monthID={monthID} update={update} onClose={() => setBudgeting(null)}/>}
    {paying && <PaymentExpenseDialog ledger={ledger} paymentId={paying} monthID={monthID} update={update} onClose={() => setPaying(null)}/>}
  </div>;
}
