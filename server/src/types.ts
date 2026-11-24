export type Side = 'Buy' | 'Sell'

/** One side of a two-sided HIP-4 outcome. encoding = 10 * outcome + index. */
export interface OutcomeSide {
  /** Short label for the glasses: 'KC', 'Yes' */
  name: string
  /** Long name used to match Polymarket outcomes: 'Kansas City Chiefs'. Same as name when there is none. */
  fullName: string
  /** Book and mids name: '#271590' */
  coin: string
  /** Spot balance name: '+271590' */
  token: string
  /** Order asset id: 100000000 + encoding */
  asset: number
}

export interface Market {
  /** The key from the config: '27159' or 'daily:BTC' */
  key: string
  outcome: number
  /** 'KC vs BUF', 'BTC ≥ 60,393' */
  title: string
  sides: [OutcomeSide, OutcomeSide]
  /** Kick-off of a game, ms. 0 = none */
  startsAt: number
  /** Settlement or deadline time, ms. 0 = unknown */
  endsAt: number
}

export interface Holding {
  /** '+271590' */
  token: string
  shares: number
  /** USDC paid for these shares (entryNtl) */
  cost: number
}

export interface Account {
  usdc: number
  holdings: Holding[]
}

export interface Filled {
  shares: number
  avgPrice: number
}

export interface Venue {
  /** Resolves config keys to open markets. Unknown, settled or one-sided keys are left out. */
  markets(keys: string[]): Promise<Market[]>
  /** coin → mid price (0..1) */
  mids(): Promise<Record<string, number>>
  account(): Promise<Account>
  /** Best ask for Buy, best bid for Sell. null when that side of the book is empty. */
  best(coin: string, side: Side): Promise<number | null>
  /** Immediate-or-cancel limit order for whole shares. Resolves with what filled; throws when nothing filled. */
  order(asset: number, side: Side, shares: number, limitPrice: number): Promise<Filled>
  /** Realised PnL of settlements booked at or after `since` (ms), by spot token ('+271590'). */
  settlements(since: number): Promise<Record<string, number>>
  /** Games (two-sided contests) that kick off within the next week or began in the last 4 hours, soonest first. */
  upcoming(): Promise<Market[]>
}

/** Live odds from Polymarket. */
export interface Odds {
  /** Price (0..1) of each Hyperliquid side, matched to the Polymarket market by name. null when the sides do not match. */
  prices(slug: string, sides: [OutcomeSide, OutcomeSide]): Promise<[number, number] | null>
  /** Slug of the same game on Polymarket: its moneyline kicks off in the same minute between the same two sides. null when none or several do. */
  match(m: Market): Promise<string | null>
}

/** A game the phone page offers: watching it puts it on the glasses with its live odds. */
export interface Game {
  key: string
  title: string
  startsAt: number
  /** Polymarket slug found for it, null when there is none: then the glasses show Hyperliquid's own prices */
  polymarket: string | null
}

export interface WatchedMarket {
  key: string
  /** Polymarket market or event slug */
  polymarket?: string
}

export interface Config {
  markets: WatchedMarket[]
  maxBetUsd: number
  defaultBetUsd: number
  dailyLossLimitUsd: number
  coolDownMin: number
  /** cents */
  swingPts: number
  swingMin: number
  /** cents; the side you hold reached this → cash-out card */
  cashOutAt: number
  /** cents; YES is refused when the price moved more than this from the card */
  slippagePts: number
}

export interface Action {
  type: 'buy' | 'sell'
  market: string
  /** 0 or 1 */
  sideIndex: number
  sideName: string
  coin: string
  asset: number
  shares: number
  /** The price on the card, 0..1 */
  price: number
}

/** Config as the phone page sees it: `raisesAt` says when higher limits it asked for start. */
export type ShownConfig = Config & { raisesAt?: number }

export interface Card {
  id: string
  key: string
  title: string
  question: string
  action: Action
  expiresAt: number
}

export interface SideView {
  name: string
  /** Hyperliquid mid, null when there is none */
  hl: number | null
  /** Polymarket live price, null when not mapped */
  pm: number | null
  /** Change of the live price (Polymarket, else Hyperliquid) over swingMin, in cents */
  change: number | null
}

export interface HoldingView {
  sideIndex: number
  shares: number
  cost: number
  /** shares at the Hyperliquid mid */
  value: number
}

export interface MarketView {
  key: string
  title: string
  startsAt: number
  endsAt: number
  sides: [SideView, SideView]
  holdings: HoldingView[]
}

export interface SessionState {
  markets: MarketView[]
  usdc: number
  dayPnl: number
  dailyLossLimitUsd: number
  locked: boolean
  /** ms; 0 = no cool-down */
  coolDownUntil: number
  card: Card | null
  pending: number
  toast: string | null
  error: string | null
  updatedAt: number
}
