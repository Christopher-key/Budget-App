export type AnnualRateType = 'apr' | 'apy';
// Four decimal places of a percentage: 4.5% = 45,000 / 1,000,000.
export const RATE_SCALE = 1_000_000n;

export function parseAnnualRate(input: string): bigint | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 12 || !/^(?:\d+(?:\.\d{0,4})?|\.\d{1,4})$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole || '0') * 10_000n + BigInt(fraction.padEnd(4, '0'));
  return value <= RATE_SCALE ? value : null;
}

export function annualRateText(value: bigint): string {
  const fraction = String(value % 10_000n).padStart(4, '0').replace(/0+$/, '');
  return `${value / 10_000n}${fraction ? '.' + fraction : ''}`;
}
