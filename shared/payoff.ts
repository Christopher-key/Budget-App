import { estimateMonthlyDividend, type AnnualRateType } from './interest.js';
import { moneyText, parseMoney } from './model.js';

export const MAX_PAYOFF_MONTHS = 1200;

export interface EstimatedPayment {
  interest: bigint;
  principal: bigint;
  nextBalance: bigint;
  chargedPayment: bigint;
}

export type PayoffEstimate = {
  status: 'paidOff'; paymentsRemaining: 0; finalPayment: bigint; totalInterest: bigint; nextInterest: bigint;
} | {
  status: 'estimated'; paymentsRemaining: number; finalPayment: bigint; totalInterest: bigint; nextInterest: bigint;
} | {
  status: 'nonAmortizing'; paymentsRemaining: null; finalPayment: null; totalInterest: null; nextInterest: bigint;
} | {
  status: 'beyondLimit'; paymentsRemaining: null; finalPayment: null; totalInterest: null; nextInterest: bigint;
  monthsSimulated: number;
};

function inputs(balance: string, payment: string, annualRate: string, type: AnnualRateType) {
  const principal = parseMoney(balance), amount = parseMoney(payment);
  if (typeof balance !== 'string' || !balance.trim() || principal === null) {
    throw new Error('Enter a non-negative remaining payoff balance.');
  }
  if (typeof payment !== 'string' || !payment.trim() || amount === null || amount <= 0n) {
    throw new Error('Enter a positive monthly payment.');
  }
  // This also validates the annual rate/type, even for a zero balance.
  const nextInterest = estimateMonthlyDividend(balance, annualRate, type).monthlyDividend;
  return { principal, amount, nextInterest };
}

function paymentStep(balance: bigint, payment: bigint, interest: bigint): EstimatedPayment {
  if (balance === 0n) return { interest: 0n, principal: 0n, nextBalance: 0n, chargedPayment: 0n };
  if (payment <= interest) throw new Error('The monthly payment must cover interest and reduce the payoff balance.');
  const due = balance + interest;
  const chargedPayment = payment < due ? payment : due;
  return { interest, principal: chargedPayment - interest, nextBalance: due - chargedPayment, chargedPayment };
}

/** Estimate only: monthly interest precedes each payment; no records are changed. */
export function estimatePayoff(balance: string, payment: string, annualRate: string, type: AnnualRateType): PayoffEstimate {
  const { principal, amount, nextInterest } = inputs(balance, payment, annualRate, type);
  if (principal === 0n) return { status: 'paidOff', paymentsRemaining: 0, finalPayment: 0n, totalInterest: 0n, nextInterest: 0n };
  if (amount <= nextInterest) return { status: 'nonAmortizing', paymentsRemaining: null, finalPayment: null, totalInterest: null, nextInterest };
  let remaining = principal, interest = nextInterest, totalInterest = 0n;
  for (let count = 1; count <= MAX_PAYOFF_MONTHS; count++) {
    const step = paymentStep(remaining, amount, interest);
    totalInterest += interest;
    remaining = step.nextBalance;
    if (remaining === 0n) return { status: 'estimated', paymentsRemaining: count, finalPayment: step.chargedPayment, totalInterest, nextInterest };
    interest = estimateMonthlyDividend(moneyText(remaining), annualRate, type).monthlyDividend;
  }
  // Do not present partial interest or a guessed payment count as a full payoff.
  return { status: 'beyondLimit', paymentsRemaining: null, finalPayment: null, totalInterest: null, nextInterest, monthsSimulated: MAX_PAYOFF_MONTHS };
}

/** Estimate one recorded payment; an actual lender statement may differ. */
export function recordEstimatedPayment(balance: string, payment: string, annualRate: string, type: AnnualRateType): EstimatedPayment {
  const { principal, amount, nextInterest } = inputs(balance, payment, annualRate, type);
  return paymentStep(principal, amount, nextInterest);
}

/** Use statement interest for an actual or principal-only extra payment. */
export function recordPaymentWithInterest(balance: string, payment: string, includedInterest: string): EstimatedPayment {
  const principal = parseMoney(balance), amount = parseMoney(payment), interest = parseMoney(includedInterest);
  if (typeof balance !== 'string' || !balance.trim() || principal === null) throw new Error('Enter a non-negative remaining payoff balance.');
  if (typeof payment !== 'string' || !payment.trim() || amount === null || amount <= 0n) throw new Error('Enter a positive payment.');
  if (typeof includedInterest !== 'string' || !includedInterest.trim() || interest === null) throw new Error('Enter the interest included in this payment; use 0 for a principal-only payment.');
  return paymentStep(principal, amount, interest);
}
