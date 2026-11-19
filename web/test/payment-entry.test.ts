import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyLedger, monthId } from '../../shared/model.js';
import { recordFixedPayment, recordFixedPaymentExpense, saveFixedPayment } from '../../shared/fixed-payments.js';
import { PaymentExpenseDialog } from '../src/PaymentEntry.js';

test('a current-month tracker-only payment requires explicit additional-payment confirmation', () => {
  const now = new Date(), id = crypto.randomUUID(), monthID = monthId(now);
  let ledger = saveFixedPayment(emptyLedger(now), {
    id, name: 'Synthetic existing loan', category: 'Car', monthlyAmount: '100', dueDay: 20,
    startMonth: monthID, endMonth: '', isApplied: true, payoffBalance: '1000', annualRate: '0', rateType: 'apr', history: [],
  }, now);
  ledger = recordFixedPayment(ledger, id, '100', now, '0');
  const render = () => renderToStaticMarkup(createElement(PaymentExpenseDialog, {
    ledger, paymentId: id, monthID, update: () => undefined, onClose: () => undefined,
  }));
  const confirmation = render();
  assert.match(confirmation, /Existing tracker entries total \$100\.00/);
  assert.match(confirmation, /This is an additional payment, separate from the existing tracker entries/);
  assert.match(confirmation, /<button[^>]*disabled=""[^>]*>Apply payment<\/button>/);
  ledger = recordFixedPaymentExpense(ledger, id, {
    monthID, date: `${monthID}-${String(now.getDate()).padStart(2, '0')}`, amount: '50', interest: '0',
  }, now);
  const correction = render();
  assert.doesNotMatch(correction, /This is an additional payment, separate/);
  assert.match(correction, />Update payment<\/button>/);
});
