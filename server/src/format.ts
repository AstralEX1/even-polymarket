const fixed = (n: number, d: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/** Signed dollars with cents: +$1,234.50, -$18.30 */
export function money(n: number): string {
  return `${n < 0 ? '-' : '+'}$${fixed(Math.abs(n), 2)}`
}

/** Unsigned dollars with cents: $9.69 */
export const dollars = (n: number) => `$${fixed(n, 2)}`

/** Whole dollars for amounts the user set: $1,200 */
export function usd(n: number): string {
  return `$${n.toLocaleString('en-US')}`
}

/** A 0..1 price as the chance it stands for: 58% (one number format on the glasses, not 58c here and 0.58 there) */
export const pct = (p: number) => `${Math.round(p * 100)}%`
