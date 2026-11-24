import type { Account, Filled, Market, Odds, OutcomeSide, Side, Venue } from './types.ts'

export const side = (outcome: number, i: number, name: string, fullName = name): OutcomeSide => {
  const enc = 10 * outcome + i
  return { name, fullName, coin: `#${enc}`, token: `+${enc}`, asset: 100_000_000 + enc }
}

export const market = (key: string, outcome: number, title: string, a: [string, string?], b: [string, string?], endsAt = 0, startsAt = 0): Market =>
  ({ key, outcome, title, sides: [side(outcome, 0, ...a), side(outcome, 1, ...b)], startsAt, endsAt })

/** In-memory venue for tests, local work without keys and the demo video. Books are mid ± 0.01. */
export class FakeVenue implements Venue {
  list: Market[] = []
  midMap: Record<string, number> = {}
  acct: Account = { usdc: 1000, holdings: [] }
  calls: { asset: number; side: Side; shares: number; limit: number }[] = []
  /** coin → book side is empty */
  empty = new Set<string>()
  /** The next order throws with this */
  failNext: string | Error | null = null
  /** Every read throws with this message while set */
  failReads: string | null = null
  /** token → realised PnL of a settlement Hyperliquid booked */
  settled: Record<string, number> = {}

  private read<T>(v: T): Promise<T> {
    return this.failReads ? Promise.reject(new Error(this.failReads)) : Promise.resolve(structuredClone(v))
  }

  async markets(keys: string[]) { return this.read(this.list.filter(m => keys.includes(m.key))) }
  async mids() { return this.read(this.midMap) }
  async account() { return this.read(this.acct) }
  async settlements() { return this.read(this.settled) }
  async upcoming() { return this.read(this.list.filter(m => m.startsAt).sort((a, b) => a.startsAt - b.startsAt)) }

  async best(coin: string, s: Side) {
    const mid = this.midMap[coin]
    if (mid === undefined || this.empty.has(coin)) return this.read(null)
    return this.read(Math.round((s === 'Buy' ? mid + 0.01 : mid - 0.01) * 100) / 100)
  }

  async order(asset: number, s: Side, shares: number, limit: number): Promise<Filled> {
    const fail = this.failNext
    this.failNext = null
    if (fail) throw typeof fail === 'string' ? new Error(fail) : fail
    this.calls.push({ asset, side: s, shares, limit })
    const enc = asset - 100_000_000
    const px = (await this.best(`#${enc}`, s))!
    if (s === 'Buy' ? px > limit : px < limit) throw new Error('Order could not immediately match')
    const token = `+${enc}`
    let h = this.acct.holdings.find(x => x.token === token)
    if (s === 'Buy') {
      if (!h) this.acct.holdings.push(h = { token, shares: 0, cost: 0 })
      h.shares += shares
      h.cost += shares * px
      this.acct.usdc -= shares * px
    } else {
      if (!h || h.shares < shares) throw new Error('Insufficient balance')
      h.cost -= (h.cost * shares) / h.shares
      h.shares -= shares
      this.acct.usdc += shares * px
      if (h.shares === 0) this.acct.holdings = this.acct.holdings.filter(x => x !== h)
    }
    return { shares, avgPrice: px }
  }
}

export class FakeOdds implements Odds {
  map: Record<string, [number, number] | null> = {}
  /** market key → Polymarket slug */
  slugs: Record<string, string> = {}
  async match(m: Market) { return this.slugs[m.key] ?? null }
  fail: string | null = null
  async prices(slug: string) {
    if (this.fail) throw new Error(this.fail)
    return this.map[slug] ?? null
  }
}

/**
 * The demo: you hold 20 KC from 0.45. KC's live odds drift, then jump 18 points about 40 s in (a swing card),
 * and climb past 85c after about two minutes (a target card). BTC daily drifts around 50c.
 */
export function demo(start: number, clock: () => number = Date.now) {
  const venue = new FakeVenue()
  const odds = new FakeOdds()
  const kc = market('27159', 27159, 'KC vs BUF', ['KC', 'Kansas City Chiefs'], ['BUF', 'Buffalo Bills'], start + 3 * 3_600_000, start - 30 * 60_000) // the game is on
  const btc = market('daily:BTC', 27234, 'BTC >= 60,393', ['Yes'], ['No'], start + 10 * 3_600_000)
  // Thanksgiving's late game: on the phone page's list, off the glasses until picked.
  const phi = market('27150', 27150, 'PHI vs DAL', ['PHI', 'Philadelphia Eagles'], ['DAL', 'Dallas Cowboys'], start + 26 * 3_600_000, start + 2 * 3_600_000)
  venue.list = [kc, btc, phi]
  odds.slugs[kc.key] = 'nfl-kc-buf-2026-11-27'
  odds.slugs[phi.key] = 'nfl-phi-dal-2026-11-26'
  odds.map['nfl-phi-dal-2026-11-26'] = [0.62, 0.38]
  venue.midMap[phi.sides[0].coin] = 0.6
  venue.midMap[phi.sides[1].coin] = 0.4
  venue.acct = { usdc: 1000, holdings: [{ token: kc.sides[0].token, shares: 20, cost: 9 }] }

  const kcLive = (t: number) => {
    const wobble = 0.02 * Math.sin(t / 7)
    return Math.min(0.92, (t < 40 ? 0.55 : t < 120 ? 0.73 : 0.73 + (t - 120) * 0.004) + wobble)
  }
  const update = () => {
    const t = (clock() - start) / 1000
    const p = kcLive(t)
    odds.map['nfl-kc-buf-2026-11-27'] = [p, 1 - p]
    const hl = Math.round((p - 0.04) * 100) / 100 // the testnet book lags the real market
    venue.midMap[kc.sides[0].coin] = hl
    venue.midMap[kc.sides[1].coin] = Math.round((1 - hl) * 100) / 100
    const b = Math.round((0.5 + 0.06 * Math.sin(t / 30)) * 100) / 100
    venue.midMap[btc.sides[0].coin] = b
    venue.midMap[btc.sides[1].coin] = Math.round((1 - b) * 100) / 100
  }
  update()
  const mids = venue.mids.bind(venue)
  venue.mids = async () => { update(); return mids() }
  return { venue, odds }
}
