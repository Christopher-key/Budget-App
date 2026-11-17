import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePayoff, MAX_PAYOFF_MONTHS, recordEstimatedPayment, recordPaymentWithInterest } from '../payoff.js';
import { moneyText } from '../model.js';
import type { AnnualRateType } from '../interest.js';

test('statement interest and principal-only extra payments do not invent another month of interest', () => {
  const first = recordEstimatedPayment('1000', '100', '12', 'apr');
  assert.equal(first.nextBalance, 91000n);
  const extra = recordPaymentWithInterest(moneyText(first.nextBalance), '100', '0');
  assert.deepEqual(extra, { interest: 0n, principal: 10000n, nextBalance: 81000n, chargedPayment: 10000n });
  const statement = recordPaymentWithInterest('1000', '100', '7.25');
  assert.equal(statement.nextBalance, 90725n);
  assert.equal(statement.principal, 9275n);
  assert.equal(recordPaymentWithInterest('50', '100', '.25').chargedPayment, 5025n);
});

test('recorded interest must be explicit, valid and below a balance-reducing payment', () => {
  for (const interest of ['', ' ', '-1', '0.001', '10000000000000', '100', '101']) {
    assert.throws(() => recordPaymentWithInterest('1000', '100', interest));
  }
  assert.throws(() => recordPaymentWithInterest('-1', '100', '0'));
  assert.throws(() => recordPaymentWithInterest('1000', '0', '0'));
});

test('APR monthly amortization includes interest before payment and a smaller final payment', () => {
  const result = estimatePayoff('1000', '100', '12', 'apr');
  assert.equal(result.status, 'estimated');
  assert.equal(result.paymentsRemaining, 11);
  assert.equal(result.finalPayment, 5898n);
  assert.equal(result.totalInterest, 5898n);
  assert.equal(result.nextInterest, 1000n);
});

test('APY uses the equivalent monthly rate, not annual yield divided by twelve', () => {
  const result = estimatePayoff('1000', '100', '12', 'apy');
  assert.equal(result.status, 'estimated');
  assert.equal(result.paymentsRemaining, 11);
  assert.equal(result.finalPayment, 5576n);
  assert.equal(result.totalInterest, 5576n);
  assert.equal(result.nextInterest, 949n);
});

test('zero-interest payoff counts whole and partial final payments without an extra month', () => {
  const even = estimatePayoff('1000', '100', '0', 'apr');
  assert.equal(even.paymentsRemaining, 10);
  assert.equal(even.finalPayment, 10000n);
  assert.equal(even.totalInterest, 0n);
  const partial = estimatePayoff('1000', '300', '0', 'apy');
  assert.equal(partial.paymentsRemaining, 4);
  assert.equal(partial.finalPayment, 10000n);
});

test('a zero remaining balance is paid off and never generates estimated charges', () => {
  const result = estimatePayoff('0', '100', '12', 'apr');
  assert.deepEqual(result, { status: 'paidOff', paymentsRemaining: 0, finalPayment: 0n, totalInterest: 0n, nextInterest: 0n });
  assert.deepEqual(recordEstimatedPayment('0', '100', '12', 'apy'), { interest: 0n, principal: 0n, nextBalance: 0n, chargedPayment: 0n });
});

test('interest-only or insufficient payments have no claimed payoff date', () => {
  for (const payment of ['10', '5']) {
    const result = estimatePayoff('1000', payment, '12', 'apr');
    assert.deepEqual(result, { status: 'nonAmortizing', paymentsRemaining: null, finalPayment: null, totalInterest: null, nextInterest: 1000n });
    assert.throws(() => recordEstimatedPayment('1000', payment, '12', 'apr'), /cover interest/);
  }
});

test('half-cent interest rounds upward before checking whether the payment reduces principal', () => {
  assert.equal(estimatePayoff('.50', '.01', '12', 'apr').status, 'nonAmortizing');
  const below = estimatePayoff('.49', '.01', '12', 'apr');
  assert.equal(below.status, 'estimated');
  assert.equal(below.paymentsRemaining, 49);
  assert.equal(below.totalInterest, 0n);
});

test('the simulation limit distinguishes an exact 1200-payment payoff from an unknown longer schedule', () => {
  assert.equal(estimatePayoff('1200', '1', '0', 'apr').paymentsRemaining, MAX_PAYOFF_MONTHS);
  const result = estimatePayoff('1201', '1', '0', 'apy');
  assert.equal(result.status, 'beyondLimit');
  assert.equal(result.paymentsRemaining, null);
  assert.equal(result.totalInterest, null);
  if (result.status === 'beyondLimit') assert.equal(result.monthsSimulated, MAX_PAYOFF_MONTHS);
});

test('recording one estimated payment separates interest/principal and caps the final charge', () => {
  assert.deepEqual(recordEstimatedPayment('1000', '100', '12', 'apr'), {
    interest: 1000n, principal: 9000n, nextBalance: 91000n, chargedPayment: 10000n,
  });
  assert.deepEqual(recordEstimatedPayment('10', '100', '12', 'apr'), {
    interest: 10n, principal: 1000n, nextBalance: 0n, chargedPayment: 1010n,
  });
});

test('maximum money inputs retain exact cents even when balance plus interest exceeds the input limit', () => {
  const result = estimatePayoff('9999999999999.99', '9999999999999.99', '4.5', 'apr');
  assert.equal(result.status, 'estimated');
  assert.equal(result.paymentsRemaining, 2);
  assert.equal(result.nextInterest, 3750000000000n);
  assert.equal(result.finalPayment, 3764062500000n);
  assert.equal(result.totalInterest, result.finalPayment);
});

test('recorded-step totals reconcile to the independently estimated schedule', () => {
  for (const type of ['apr', 'apy'] as const) {
    const estimate = estimatePayoff('750.43', '47.19', '8.3750', type);
    assert.equal(estimate.status, 'estimated');
    let balance = 75043n, totalInterest = 0n, totalPrincipal = 0n, totalPaid = 0n, count = 0;
    while (balance > 0n) {
      const step = recordEstimatedPayment(moneyText(balance), '47.19', '8.3750', type);
      balance = step.nextBalance; totalInterest += step.interest; totalPrincipal += step.principal; totalPaid += step.chargedPayment; count++;
      assert.ok(count <= MAX_PAYOFF_MONTHS);
    }
    assert.equal(count, estimate.paymentsRemaining);
    assert.equal(totalInterest, estimate.totalInterest);
    assert.equal(totalPrincipal, 75043n);
    assert.equal(totalPaid, 75043n + totalInterest);
  }
});

test('malformed inputs and invalid rate types cannot produce payoff estimates or recorded payments', () => {
  for (const balance of ['', ' ', '-1', '1e2', '0.001', '10000000000000']) {
    assert.throws(() => estimatePayoff(balance, '100', '5', 'apr'));
    assert.throws(() => recordEstimatedPayment(balance, '100', '5', 'apr'));
  }
  for (const payment of ['', ' ', '0', '-1', '1e2', '0.001', '10000000000000']) {
    assert.throws(() => estimatePayoff('1000', payment, '5', 'apr'));
  }
  for (const rate of ['', '-1', '100.0001', 'Infinity', '5.00001']) {
    assert.throws(() => estimatePayoff('1000', '100', rate, 'apr'));
  }
  assert.throws(() => estimatePayoff('0', '100', '5', 'unknown' as AnnualRateType));
});
