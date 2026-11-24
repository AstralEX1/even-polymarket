import type { Account, Action, Card, Config, Holding, Market } from './types.ts'
import { dollars, money, pct } from './format.ts'

export const DEFAULT_CONFIG: Config = {
  // KC vs BUF on Nov 27 is listed on both Hyperliquid testnet and Polymarket; daily:BTC follows the protocol's daily binary.
  markets: [{ key: '27159', polymarket: 'nfl-kc-buf-2026-11-27' }, { key: 'daily:BTC' }],
  maxBetUsd: 25,
  defaultBetUsd: 15, // above the $10 minimum order even after rounding down to whole shares
  dailyLossLimitUsd: 50,
  coolDownMin: 10,
  swingPts: 15,
  swingMin: 5,
  cashOutAt: 85,
  slippagePts: 2,
}

/** The number fields of Config, in the order the phone page shows them. */
export const NUMBER_FIELDS = ['maxBetUsd', 'defaultBetUsd', 'dailyLossLimitUsd', 'coolDownMin', 'swingPts', 'swingMin', 'cashOutAt', 'slippagePts'] as const

export const CARD_LIFETIME_MS = 30_000
/** cents: a fired rule stays fired until its value falls this far below the threshold, so odds wobbling on the line do not re-raise it */
const BAND = 3
const ENDS_SOON_MS = 15 * 60_000

export type Sample = { t: number; p: number }

export interface Snapshot {
  markets: Market[]
  /** coin → Hyperliquid mid */
  mids: Record<string, number>
  /** market key → Polymarket prices of side 0 and 1 */
  live: Record<string, [number, number] | null>
  /** market key → live price of side 0 over the last swingMin minutes, oldest first */
  history: Record<string, Sample[]>
  account: Account
  now: number
}

/** Live price of a side: Polymarket when mapped, else the Hyperliquid mid. */
export function livePrice(s: Pick<Snapshot, 'mids' | 'live'>, m: Market, i: number): number | undefined {
  return s.live[m.key]?.[i] ?? s.mids[m.sides[i].coin]
}

/** Change of side 0 over the window, 0..1. Side 1 moves the other way. */
export function swing(samples: Sample[] | undefined): number | null {
  if (!samples || samples.length < 2) return null
  return samples[samples.length - 1].p - samples[0].p
}

export function holdingsOf(m: Market, a: Account): { i: number; h: Holding }[] {
  const out: { i: number; h: Holding }[] = []
  m.sides.forEach((side, i) => {
    const h = a.holdings.find(x => x.token === side.token && x.shares > 0)
    if (h) out.push({ i, h })
  })
  return out
}

/** Spot USDC plus every holding at its Hyperliquid mid. A holding without a mid counts at cost. */
export function equity(a: Account, mids: Record<string, number>): number {
  return a.usdc + a.holdings.reduce((sum, h) => {
    const mid = mids[h.token.replace(/^\+/, '#')]
    return sum + (mid === undefined ? h.cost : h.shares * mid)
  }, 0)
}

/** `question` is the decision in money, `title` says why the card is up. */
export const makeCard = (now: number, key: string, title: string, question: string, action: Action): Card =>
  ({ id: crypto.randomUUID(), key, title, question, action, expiresAt: now + CARD_LIFETIME_MS })

/** What a cash-out gets you and makes you, rather than a price to decode. */
export const cashOutQuestion = (shares: number, name: string, price: number, cost: number) =>
  `Cash out ${shares} ${name} for ${dollars(shares * price)} (${money(shares * price - cost)})?`

/** Worst price an order from a card may fill at: the card price ± slippage, kept inside 0.01..0.99. */
export const limitPrice = (type: 'buy' | 'sell', price: number, slippagePts: number) =>
  type === 'buy' ? Math.min(0.99, price + slippagePts / 100) : Math.max(0.01, price - slippagePts / 100)

export function sellAction(m: Market, i: number, shares: number, price: number): Action {
  const side = m.sides[i]
  return { type: 'sell', market: m.key, sideIndex: i, sideName: side.name, coin: side.coin, asset: side.asset, shares, price }
}

/**
 * Cash-out cards and notices for one snapshot. Pure. Cash-outs only reduce risk, so the lock and the cool-down never stop them.
 * A key fires once and re-arms only after its condition clears by BAND cents (it is absent from `fired`).
 */
export function evaluate(s: Snapshot, cfg: Config, fired: Set<string>) {
  const active = new Set<string>()
  const cards: Card[] = []
  const toasts: string[] = []

  for (const m of s.markets) {
    const held = holdingsOf(m, s.account)
    if (!held.length) continue

    const left = m.endsAt - s.now
    if (m.endsAt && left > 0 && left <= ENDS_SOON_MS) {
      active.add(`ends:${m.key}`)
      if (!fired.has(`ends:${m.key}`)) toasts.push(`${m.title} ends in ${Math.ceil(left / 60_000)} min`)
    }

    const change0 = swing(s.history[m.key])
    for (const { i, h } of held) {
      const side = m.sides[i]
      const live = livePrice(s, m, i)
      const quote = s.mids[side.coin] // we sell on Hyperliquid, so the card quotes its mid
      if (live === undefined || quote === undefined) continue
      const question = cashOutQuestion(h.shares, side.name, quote, h.cost)
      /** Raises the card when `value` reaches `threshold` (both in cents); returns whether the rule is on. */
      const rule = (key: string, value: number, threshold: number, title: () => string) => {
        if (value < threshold - (fired.has(key) ? BAND : 0)) return false
        active.add(key)
        if (!fired.has(key)) cards.push(makeCard(s.now, key, title(), question, sellAction(m, i, h.shares, quote)))
        return true
      }

      if (rule(`target:${m.key}:${i}`, live * 100, cfg.cashOutAt, () => `${m.title}: ${side.name} at ${pct(live)}, your target`)) continue // one card per holding
      const change = change0 === null ? null : i === 0 ? change0 : -change0
      if (change !== null) {
        rule(`swing:${m.key}:${i}`, Math.abs(change) * 100, cfg.swingPts,
          () => `${m.title}: ${side.name} ${change > 0 ? '↑' : '↓'}${Math.round(Math.abs(change) * 100)} in ${cfg.swingMin} min, now ${pct(live)}`)
      }
    }
  }

  return { cards, toasts, fired: active }
}
