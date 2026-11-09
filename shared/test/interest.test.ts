import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMonthlyDividend, parseAnnualRate, type AnnualRateType } from '../interest.js';

test('APR and APY produce different correct monthly payouts and equivalent annual rates', () => {
  const apr = estimateMonthlyDividend('10000', '5', 'apr');
  const apy = estimateMonthlyDividend('10000', '5', 'apy');
  assert.equal(apr.monthlyDividend, 4167n);
  assert.equal(apy.monthlyDividend, 4074n);
  assert.ok(Math.abs(apr.monthlyRatePercent - 5 / 12) < 1e-12);
  assert.ok(Math.abs(apr.apyPercent - 5.1161897881733) < 1e-10);
  assert.ok(Math.abs(apy.aprPercent - 4.888948540378) < 1e-10);
  assert.equal(apy.apyPercent, 5);
});

test('zero balance or zero rate produces no dividend', () => {
  for (const type of ['apr', 'apy'] as const) {
    assert.equal(estimateMonthlyDividend('0', '5', type).monthlyDividend, 0n);
    const estimate = estimateMonthlyDividend('10000', '0', type);
    assert.equal(estimate.monthlyDividend, 0n);
    assert.equal(estimate.aprPercent, 0);
    assert.equal(estimate.apyPercent, 0);
  }
});

test('payouts round to the nearest cent with half cents rounded up', () => {
  assert.equal(estimateMonthlyDividend('.50', '12', 'apr').monthlyDividend, 1n);
  assert.equal(estimateMonthlyDividend('.49', '12', 'apr').monthlyDividend, 0n);
  // 79.5856326...% APY makes ten cents earn exactly half a cent/month.
  assert.equal(estimateMonthlyDividend('.10', '79.5856', 'apy').monthlyDividend, 0n);
  assert.equal(estimateMonthlyDividend('.10', '79.5857', 'apy').monthlyDividend, 1n);
});

test('large balances retain cent accuracy independently checked with high-precision decimal arithmetic', () => {
  assert.equal(estimateMonthlyDividend('9999999999999.99', '4.5', 'apr').monthlyDividend, 3750000000000n);
  assert.equal(estimateMonthlyDividend('9999999999999.99', '4.5', 'apy').monthlyDividend, 3674809400437n);
});

test('rate inputs retain decimal precision and support ordinary in-progress typing', () => {
  assert.equal(parseAnnualRate('3'), 30000n);
  assert.equal(parseAnnualRate('3.'), 30000n);
  assert.equal(parseAnnualRate('3.0'), 30000n);
  assert.equal(parseAnnualRate(' 3.1250 '), 31250n);
  assert.equal(parseAnnualRate('.0001'), 1n);
  assert.equal(parseAnnualRate('100.0000'), 1000000n);
});

test('blank, negative, oversized, exponential and malformed inputs cannot produce an estimate', () => {
  for (const text of ['', ' ', '-1', '100.0001', 'Infinity', 'NaN', '1e2', '1,25', '3.12345', '3..5', '9999999999999']) {
    assert.equal(parseAnnualRate(text), null);
    assert.throws(() => estimateMonthlyDividend('100', text, 'apy'));
  }
  for (const balance of ['', ' ', '-1', '10000000000000', '1e2', '0.001']) {
    assert.throws(() => estimateMonthlyDividend(balance, '5', 'apr'));
  }
  assert.throws(() => estimateMonthlyDividend('100', '5', 'unknown' as AnnualRateType));
});
