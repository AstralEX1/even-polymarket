import type { Market } from './types.ts'

export type Intent = { kind: 'bet'; usd: number | null; side: string } | { kind: 'cashout' }

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const BIG = ['hundred', 'thousand', 'million', 'k', 'grand']
const CURRENCY = new Set(['dollar', 'dollars', 'buck', 'bucks', 'usd', 'usdc'])
const FILLER = new Set(['the', 'a', 'an', 'please', 'to', 'win', 'wins', 'it', 'them', 'shares'])

const words = (text: string) => text.toLowerCase().replace(/\$(\d)/g, '$1').replace(/[^a-z0-9. ]+/g, ' ').replace(/\.(?!\d)/g, ' ').split(/\s+/).filter(Boolean)
const numeric = (w: string) => /^\d+(\.\d+)?$/.test(w) || UNITS.includes(w) || TENS.includes(w) || BIG.includes(w)

/** Reads one number at `at`: "25", "2.5", "twenty five", "a hundred". Returns the value and how many words it used. */
function numberAt(ws: string[], at: number): { n: number; used: number } | null {
  const w = ws[at]
  if (/^\d+(\.\d+)?$/.test(w)) return { n: Number(w), used: 1 }
  if (w === 'hundred' || (w === 'a' && ws[at + 1] === 'hundred')) return { n: 100, used: w === 'a' ? 2 : 1 }
  const unit = UNITS.indexOf(w)
  if (unit >= 0) return ws[at + 1] === 'hundred' ? { n: unit * 100, used: 2 } : { n: unit, used: 1 }
  const ten = TENS.indexOf(w)
  if (ten >= 2) {
    const next = UNITS.indexOf(ws[at + 1] ?? '')
    return next >= 1 && next <= 9 ? { n: ten * 10 + next, used: 2 } : { n: ten * 10, used: 1 }
  }
  return null
}

/**
 * A transcript → what the user asked for. Pure. null when it is not clearly a bet or a cash-out.
 * A bet is "<amount> on <side>": the amount must be the whole number right before "on", so "KC by 20, put 5 on it",
 * "two fifty" and "ten thousand" are refused rather than read as a different amount.
 */
export function parseIntent(text: string): Intent | null {
  const ws = words(text)
  const joined = ` ${ws.join(' ')} `
  if (/ (don t|dont|do not|never|not|cancel|stop|wait) /.test(joined)) return null
  if (/ (cash ?out|sell|get (me )?out|close (it|all)) /.test(joined)) return { kind: 'cashout' }
  const on = ws.lastIndexOf('on')
  if (on < 0) return null
  const side = ws.slice(on + 1).filter(w => !FILLER.has(w)).join(' ')
  if (!side) return null
  let end = on
  while (end > 0 && CURRENCY.has(ws[end - 1])) end--
  let start = end
  while (start > 0 && (numeric(ws[start - 1]) || (ws[start - 1] === 'a' && ws[start] === 'hundred'))) start--
  if (start === end) return { kind: 'bet', usd: null, side }
  const n = numberAt(ws, start)
  return n && start + n.used === end && n.n > 0 ? { kind: 'bet', usd: n.n, side } : null
}

/** A spoken answer to a card: true for a clear yes, false for a clear no, null for anything else (the card stays up). */
export function parseConfirm(text: string): boolean | null {
  const t = words(text).join(' ')
  if (/^(yes|yep|yeah|confirm)( please)?$/.test(t)) return true
  if (/^(no|nope|cancel|skip)( thanks| thank you)?$/.test(t)) return false
  return null
}

const has = (phrase: string, word: string) => word.length > 1 && ` ${phrase} `.includes(` ${word.toLowerCase()} `)

/** Which side of the market the spoken words name: the short name, or any word of the full name ("chiefs", "kansas city"). */
export function pickSide(m: Market, phrase: string): number | null {
  const hits = m.sides.map(s => has(phrase, s.name) || s.fullName.toLowerCase().split(/\s+/).some(w => w.length > 2 && has(phrase, w)))
  return hits[0] === hits[1] ? null : hits[0] ? 0 : 1
}
