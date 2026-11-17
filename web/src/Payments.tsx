import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { BudgetPlan, FixedPayment, Ledger } from '../../shared/contracts.js';
import { appliedFixedPayments, recordFixedPayment, saveFixedPayment, setFixedPaymentApplied } from '../../shared/fixed-payments.js';
import { daysInMonth, formatMoney, monthId, moneyText, parseMoney } from '../../shared/model.js';
import { estimateMonthlyDividend, parseAnnualRate } from '../../shared/interest.js';
import { activeExpenseCategories } from '../../shared/categories.js';
import { estimatePayoff, recordPaymentWithInterest } from '../../shared/payoff.js';
import { Modal, Money } from './controls.js';
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
  const [paying, setPaying] = useState<FixedPayment | null>(null), [paymentAmount, setPaymentAmount] = useState('');
  const [manualInterest, setManualInterest] = useState(false), [interestDraft, setInterestDraft] = useState('');
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
      setDraft(null); setMessage('Fixed payment saved. Applied payments appear in Budgeted expenses and on Home.');
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
  function openRecord(payment: FixedPayment) {
    committing.current = false; setError(''); setMessage('');
    setPaying(payment); setPaymentAmount(payment.monthlyAmount);
    setManualInterest(false); setInterestDraft('');
  }
  const currentPaying = paying ? payments.find(payment => payment.id === paying.id) : undefined;
  const interestAmount = useMemo(() => {
    if (manualInterest) return interestDraft;
    if (!currentPaying) return '';
    try { return moneyText(estimateMonthlyDividend(currentPaying.payoffBalance, currentPaying.annualRate, currentPaying.rateType).monthlyDividend); }
    catch { return ''; }
  }, [manualInterest, interestDraft, currentPaying]);
  const recordPreview = useMemo(() => {
    if (!currentPaying) return null;
    try { return { value: recordPaymentWithInterest(currentPaying.payoffBalance, paymentAmount, interestAmount) }; }
    catch (failure) { return { error: failure instanceof Error ? failure.message : 'Check the payment amount.' }; }
  }, [currentPaying, paymentAmount, interestAmount]);
  function record(event: FormEvent) {
    event.preventDefault(); if (!currentPaying || !recordPreview?.value || committing.current) return;
    setError('');
    try {
      committing.current = true;
      update(recordFixedPayment(ledger, currentPaying.id, paymentAmount, new Date(), interestAmount));
      setPaying(null); setMessage('Payment recorded in the payoff tracker. Report the expense in Transactions to update Realistic spending.');
    } catch (failure) {
      committing.current = false;
      setError(failure instanceof Error ? failure.message : 'The payment could not be recorded.');
    }
  }
  const manualCategoryAmount = draft ? (ledger.months.find(month => month.id === monthId())?.periods ?? [])
    .flatMap(period => period.budgeted.expenses)
    .filter(entry => !entry.fixedPaymentId && entry.name === draft.category)
    .reduce((total, entry) => total + (parseMoney(entry.amount) ?? 0n), 0n) : 0n;
  const invalidRate = Boolean(draft && tracking && draft.annualRate.trim() && parseAnnualRate(draft.annualRate) === null);
  return <section className="card payment-manager" aria-labelledby="fixed-payments-heading">
    <div className="section-heading"><h2 id="fixed-payments-heading">Fixed monthly payments</h2>
      <button className="primary" disabled={!categories.length} onClick={() => open()}>+ Fixed payment</button></div>
    <p className="muted small">Plan loans, car payments, leases, insurance and other fixed costs. Apply each payment when you want it included in Budgeted expenses and on Home.</p>
    {!payments.length && <p className="muted small">Add a monthly amount, then optionally track a payoff balance and interest.</p>}
    {!categories.length && <p className="muted small">Add or restore an expense category in Budget → Manage expenses before creating a fixed payment.</p>}
    <div className="payment-list">{payments.map(payment => <article className="payment-row" key={payment.id}>
      <div className="payment-row-heading"><div><h3>{payment.name}</h3>
        <p className="muted small">{payment.category} · Due day {payment.dueDay} · {payment.isApplied ? 'Applied to budget' : 'Not applied'}<br/>
          From {payment.startMonth}{payment.endMonth ? ` through ${payment.endMonth}` : ''}</p></div>
        <strong>{money(payment.monthlyAmount)}<small className="muted"> / month</small></strong></div>
      <PayoffDetails payment={payment}/>
      <div className="payment-actions">
        <button className="secondary" aria-label={`Edit ${payment.name}`} onClick={() => open(payment)}>Edit</button>
        <button className="secondary" aria-label={`${payment.isApplied ? 'Unapply' : 'Apply'} ${payment.name}`} onClick={() => apply(payment)}>{payment.isApplied ? 'Unapply from budget' : 'Apply to budget'}</button>
        {payment.payoffBalance.trim() && (parseMoney(payment.payoffBalance) ?? 0n) > 0n && <button className="secondary" aria-label={`Record payment for ${payment.name}`} onClick={() => openRecord(payment)}>Record payment</button>}
      </div>
      {payment.history.length > 0 && <details className="payment-history"><summary>Self-reported payoff payments ({payment.history.length})</summary>
        <ul>{payment.history.slice(-5).reverse().map(item => <li key={item.id}>
          <strong>{money(item.amount)}</strong> · {new Date(item.date).toLocaleDateString()}<br/>
          <span className="muted">Interest {money(item.interest)} · Principal {money(item.principal)} · Balance after {money(item.balanceAfter)}</span>
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
        <label className="check-row"><input type="checkbox" checked={draft.isApplied} disabled={!categories.includes(draft.category)} onChange={event => setDraft({ ...draft, isApplied: event.target.checked })}/>Apply to Budgeted expenses and Home</label>
        {!categories.includes(draft.category) && <p className="muted small">This category was removed. Choose an active category above or restore it in Budget → Manage expenses before applying this payment.</p>}
        <p className="muted small">Changes update this month and saved future plans. Earlier months keep their recorded amounts. Unapplying removes this payment's current and future Budgeted lines.</p>
        {draft.isApplied && manualCategoryAmount > 0n && <p className="privacy-note">You already have {formatMoney(manualCategoryAmount)} entered manually for {draft.category} this month. This fixed payment is additional. Adjust the manual amount if it already includes this payment.</p>}
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
    {paying && <Modal title={`Record payment · ${paying.name}`} onClose={() => setPaying(null)}>
      <form onSubmit={record}>
        <Money label="Payment to record" value={paymentAmount} onChange={setPaymentAmount}/>
        <Money label="Interest included" value={interestAmount} onChange={value => { setManualInterest(true); setInterestDraft(value); }}/>
        <p className="muted small">Interest starts with one full month's estimate. Use the interest shown on your statement, or enter 0 for a principal-only extra payment.</p>
        {recordPreview?.value && <dl className="payment-record-preview">
          <div><dt>Applied payment</dt><dd>{formatMoney(recordPreview.value.chargedPayment)}</dd></div>
          <div><dt>Interest included</dt><dd>{formatMoney(recordPreview.value.interest)}</dd></div>
          <div><dt>Principal reduction</dt><dd>{formatMoney(recordPreview.value.principal)}</dd></div>
          <div><dt>New payoff balance</dt><dd>{formatMoney(recordPreview.value.nextBalance)}</dd></div>
        </dl>}
        {recordPreview?.error && <p className="error">{recordPreview.error}</p>}
        <p className="privacy-note">This updates the payoff tracker only. Report the expense in Transactions to update Realistic spending. Reconcile the interest and payoff balance with your lender's statement. The final payment is capped at the balance plus the interest entered above.</p>
        {recordPreview?.value?.nextBalance === 0n && <p className="muted small">A completed payoff stops being applied after this month. This month's Budgeted payment remains in place.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary full" disabled={!recordPreview?.value || recordPreview.value.chargedPayment <= 0n}>Confirm payoff payment</button>
      </form>
    </Modal>}
  </section>;
}

export function PaymentPreview({ ledger, monthID }: { ledger: Ledger; monthID: string }) {
  const payments = appliedFixedPayments(ledger, monthID);
  if (!payments.length) return null;
  return <section className="card payments-preview" aria-label="Applied fixed monthly payments">
    <h2>Fixed monthly payments</h2>
    {payments.map(payment => <div className="payment-preview-row" key={payment.id}>
      <div><strong>{payment.name}</strong><small className="muted">{payment.category} · Due day {Math.min(payment.dueDay, daysInMonth(monthID))}</small>
        <PayoffDetails payment={payment} compact/></div>
      <strong>{money(payment.monthlyAmount)}<small className="muted"> / month</small></strong>
    </div>)}
  </section>;
}

export function FixedPlanLines({ plan, monthID }: { plan: BudgetPlan; monthID?: string }) {
  const entries = plan.expenses.filter(entry => entry.fixedPaymentId);
  if (!entries.length) return null;
  return <div className="fixed-plan-lines">
    <h3>Fixed monthly payments</h3>
    <dl>{entries.map(entry => <div key={entry.id}><dt><strong>{entry.fixedPaymentName ?? entry.name}</strong><small>{entry.name} · Due day {monthID && entry.fixedDueDay ? Math.min(entry.fixedDueDay, daysInMonth(monthID)) : entry.fixedDueDay}</small></dt><dd>{money(entry.amount)}</dd></div>)}</dl>
    <p className="muted small">These planned costs are managed in Savings &amp; Payoffs. Keep any matching amount out of the manual category above.</p>
  </div>;
}
