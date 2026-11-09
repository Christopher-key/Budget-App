import { parseMoney } from './model.js';

export type AnnualRateType = 'apr' | 'apy';
// Four decimal places of a percentage: 4.5% = 45,000 / 1,000,000.
const RATE_SCALE = 1_000_000n;

export function parseAnnualRate(input: string): bigint | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 12 || !/^(?:\d+(?:\.\d{0,4})?|\.\d{1,4})$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole || '0') * 10_000n + BigInt(fraction.padEnd(4, '0'));
  return value <= RATE_SCALE ? value : null;
}

function apyDividend(principal: bigint, rate: bigint): bigint {
  // Round P*((1+APY)^(1/12)-1) to the nearest cent, ties upward.
  // Compare powers at half-cent boundaries to avoid floating-point money.
  const target = (2n * principal) ** 12n * (RATE_SCALE + rate);
  let low = 0n, high = (principal * rate + RATE_SCALE - 1n) / RATE_SCALE;
  while (low < high) {
    const middle = (low + high) / 2n;
    const boundary = (2n * principal + 2n * middle + 1n) ** 12n * RATE_SCALE;
    if (boundary > target) high = middle;
    else low = middle + 1n;
  }
  return low;
}

/** Local estimate for a constant balance and twelve equal monthly periods. */
export function estimateMonthlyDividend(balance: string, annualRate: string, type: AnnualRateType) {
  const principal = parseMoney(balance), rate = parseAnnualRate(annualRate);
  if (!balance.trim() || principal === null) throw new Error('Enter a non-negative savings balance.');
  if (rate === null) throw new Error('Enter a yearly rate from 0% to 100% with up to four decimal places.');
  if (type !== 'apr' && type !== 'apy') throw new Error('Choose APR or APY.');
  const denominator = RATE_SCALE * 12n;
  const monthlyDividend = type === 'apr'
    ? (2n * principal * rate + denominator) / (2n * denominator)
    : apyDividend(principal, rate);
  // Floating point is used only to display percentages, never to round money.
  const annualFraction = Number(rate) / Number(RATE_SCALE);
  const monthlyFraction = type === 'apr' ? annualFraction / 12 : Math.expm1(Math.log1p(annualFraction) / 12);
  return {
    monthlyDividend,
    monthlyRatePercent: monthlyFraction * 100,
    aprPercent: type === 'apr' ? annualFraction * 100 : monthlyFraction * 1200,
    apyPercent: type === 'apy' ? annualFraction * 100 : Math.expm1(12 * Math.log1p(monthlyFraction)) * 100,
  };
}
