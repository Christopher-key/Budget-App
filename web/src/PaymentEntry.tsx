import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { Ledger } from '../../shared/contracts.js';
import { recordFixedPaymentExpense, undoFixedPaymentExpense } from '../../shared/fixed-payments.js';
import { estimateMonthlyDividend } from '../../shared/interest.js';
import { formatMoney, monthId, moneyText, parseMoney } from '../../shared/model.js';
import { Modal, Money } from './controls.js';

const dateText = (date = new Date()) => `${monthId(date)}-${String(date.getDate()).padStart(2, '0')}`;

/** The portal and the Budget page share one explicit expense-and-tracker action. */
export function PaymentExpenseDialog({ ledger, paymentId, monthID, update, onClose }: {
  ledger: Ledger; paymentId: string; monthID: string; update: (next: Ledger) => void; onClose: () => void;
}) {
  const payment = ledger.fixedPayments?.find(item => item.id === paymentId);
  const recorded = payment?.history.find(item => item.budgetMonth === monthID);
  const category = ledger.months.find(month => month.id === monthID)?.transactions.find(item => item.id === recorded?.id)?.category ?? payment?.category ?? '';
  const [paid, setPaid] = useState(recorded?.amount ?? payment?.monthlyAmount ?? '');
  const [date, setDate] = useState(recorded?.date.slice(0, 10) ?? dateText());
  const [interest, setInterest] = useState(() => {
    if (recorded?.interest !== undefined) return recorded.interest;
    if (!payment?.payoffBalance.trim() || recorded?.kind === 'recurring') return '';
    try { return moneyText(estimateMonthlyDividend(payment.payoffBalance, payment.annualRate, payment.rateType).monthlyDividend); }
    catch { return ''; }
  });
  const [error, setError] = useState('');
  const [undoing, setUndoing] = useState(false);
  const [additionalPayment, setAdditionalPayment] = useState(false);
  const committing = useRef(false);
  const original = useRef(JSON.stringify(payment));
  const tracked = recorded ? recorded.kind !== 'recurring' : Boolean(payment?.payoffBalance.trim());
  const legacyPayments = payment?.history.filter(item => !item.budgetMonth && item.date.slice(0, 7) === monthID) ?? [];
  const needsConfirmation = !recorded && legacyPayments.length > 0;
  const manualAmount = ledger.months.find(month => month.id === monthID)?.periods
    .flatMap(period => period.realistic.expenses)
    .filter(entry => !entry.fixedPaymentId && entry.name === category)
    .reduce((sum, entry) => sum + (parseMoney(entry.amount) ?? 0n), 0n) ?? 0n;
  const otherLogged = ledger.months.find(month => month.id === monthID)?.transactions
    .filter(entry => entry.category === category && !entry.fixedPaymentId)
    .reduce((sum, entry) => sum + (parseMoney(entry.amount) ?? 0n), 0n) ?? 0n;
  const preview = useMemo(() => {
    if (!payment || !tracked) return null;
    try {
      const balance = (parseMoney(payment.payoffBalance) ?? 0n) + (parseMoney(recorded?.principal ?? '') ?? 0n);
      const paidAmount = parseMoney(paid), included = parseMoney(interest);
      if (!paid.trim() || paidAmount === null || paidAmount <= 0n) throw new Error('Enter a positive payment amount.');
      if (!interest.trim() || included === null) throw new Error('Confirm the interest included in this payment.');
      if (balance <= 0n) throw new Error('This payoff is already complete.');
      if (paidAmount < included) throw new Error('The payment must cover its confirmed interest.');
      const chargedPayment = paidAmount < balance + included ? paidAmount : balance + included;
      return { value: { chargedPayment, principal: chargedPayment - included, nextBalance: balance - chargedPayment + included } };
    } catch (failure) { return { error: failure instanceof Error ? failure.message : 'Check your payment details.' }; }
  }, [payment, tracked, recorded, paid, interest]);
  const estimate = useMemo(() => {
    if (!payment || !tracked) return null;
    try {
      const balance = (parseMoney(payment.payoffBalance) ?? 0n) + (parseMoney(recorded?.principal ?? '') ?? 0n);
      return estimateMonthlyDividend(moneyText(balance), payment.annualRate, payment.rateType).monthlyDividend;
    } catch { return null; }
  }, [payment, tracked, recorded]);
  if (!payment) return <Modal title="Payment unavailable" onClose={onClose}><p>This fixed payment is no longer available. Close this dialog and reload the latest budget.</p></Modal>;
  const latest = payment.history.filter(record => record.kind !== 'recurring').at(-1);
  const blocked = recorded && recorded.kind !== 'recurring' && (latest?.id !== recorded.id || parseMoney(recorded.balanceAfter ?? '') !== parseMoney(payment.payoffBalance));
  const invalid = !paid.trim() || parseMoney(paid) === null || (parseMoney(paid) ?? 0n) <= 0n
    || date.slice(0, 7) !== monthID || date > dateText() || monthID !== monthId()
    || (needsConfirmation && !additionalPayment)
    || (tracked && (!preview?.value || preview.value.chargedPayment !== parseMoney(paid)));
  function checkCurrent() {
    if (original.current !== JSON.stringify(payment)) throw new Error('This payment changed while the form was open. Close it and reopen the latest payment before continuing.');
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (committing.current || invalid || blocked) return;
    try {
      checkCurrent(); committing.current = true;
      update(recordFixedPaymentExpense(ledger, paymentId, { monthID, date, amount: paid, ...(tracked ? { interest } : {}) }));
      onClose();
    } catch (failure) {
      committing.current = false; setError(failure instanceof Error ? failure.message : 'The payment could not be recorded.');
    }
  }
  function undo() {
    if (committing.current) return;
    try {
      checkCurrent(); committing.current = true;
      update(undoFixedPaymentExpense(ledger, paymentId, monthID)); onClose();
    } catch (failure) {
      committing.current = false; setError(failure instanceof Error ? failure.message : 'The payment could not be undone.'); setUndoing(false);
    }
  }
  return <Modal title={`${recorded ? 'Update' : 'Apply'} payment · ${payment.name}`} onClose={onClose}>
    {undoing ? <div>
      <p>Undo {formatMoney(parseMoney(recorded?.amount ?? '') ?? 0n)} for {payment.name}? This removes its linked expense and payment history, and restores the payoff balance when tracked.</p>
      <div className="payment-actions"><button className="danger-button" onClick={undo}>Confirm undo payment</button><button className="secondary" onClick={() => setUndoing(false)}>Keep payment</button></div>
      {error && <p className="error" role="alert">{error}</p>}
    </div> : <form onSubmit={save}>
      <p className="muted small">{category} · Scheduled {formatMoney(parseMoney(payment.monthlyAmount) ?? 0n)} monthly. This action records one expense for {monthID}{tracked ? ' and updates the payoff tracker' : ''}.</p>
      {recorded && <p className="privacy-note">Currently recorded: {formatMoney(parseMoney(recorded.amount) ?? 0n)} on {recorded.date.slice(0, 10)}. Saving replaces this month's payment and linked expense.</p>}
      <Money label="Payment amount" value={paid} onChange={setPaid}/>
      <button type="button" className="text-button payment-scheduled" onClick={() => setPaid(payment.monthlyAmount)}>Use scheduled amount</button>
      <label className="field">Payment date<input aria-label="Payment date" type="date" required min={`${monthID}-01`} max={dateText()} value={date} onChange={event => setDate(event.target.value)}/></label>
      {tracked && <>
        <Money label="Statement interest included" value={interest} onChange={setInterest}/>
        <p className="muted small">Confirm the interest from your statement, or enter 0 for a principal-only payment.{estimate !== null ? ` One month's estimated interest is ${formatMoney(estimate)}.` : ''}</p>
        {preview?.value && <dl className="payment-record-preview">
          <div><dt>Expense recorded</dt><dd>{formatMoney(parseMoney(paid) ?? 0n)}</dd></div>
          <div><dt>Principal reduction</dt><dd>{formatMoney(preview.value.principal)}</dd></div>
          <div><dt>New payoff balance</dt><dd>{formatMoney(preview.value.nextBalance)}</dd></div>
        </dl>}
        {preview?.error && paid.trim() && interest.trim() && <p className="error">{preview.error}</p>}
        {preview?.value && preview.value.chargedPayment !== parseMoney(paid) && <p className="error">The amount exceeds the payoff balance plus interest. Enter the actual final payment of {formatMoney(preview.value.chargedPayment)}.</p>}
      </>}
      {(manualAmount > 0n || otherLogged > 0n) && <p className="privacy-note">{category} already has {formatMoney(manualAmount)} in manual Realistic amounts and {formatMoney(otherLogged)} in other reported expenses this month. If those include this payment, remove or adjust that amount to avoid counting it twice.</p>}
      {needsConfirmation && <div className="privacy-note"><p>Existing tracker entries total {formatMoney(legacyPayments.reduce((sum, item) => sum + (parseMoney(item.amount) ?? 0n), 0n))} this month. Those payments already reduced the payoff balance. Applying here records an additional payment and expense; it does not connect an old entry to spending.</p><label className="check-row"><input type="checkbox" checked={additionalPayment} onChange={event => setAdditionalPayment(event.target.checked)}/>This is an additional payment, separate from the existing tracker entries.</label></div>}
      {blocked && <p className="error">A later tracker record or balance correction exists. This older payment cannot be changed or undone without diverging from the payoff tracker.</p>}
      <p className="muted small">The linked expense appears in Transactions and Realistic totals in the pay period containing its payment date. Saving again updates the same monthly payment.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={Boolean(invalid || blocked)}>{recorded ? 'Update payment' : 'Apply payment'}</button>
      {recorded && <button type="button" className="text-button payment-undo" disabled={Boolean(blocked || monthID !== monthId())} onClick={() => { setError(''); setUndoing(true); }}>Undo this payment</button>}
    </form>}
  </Modal>;
}
