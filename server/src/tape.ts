// A tape is what the venue and the odds said during a live session, one JSON line per change.
// Played back, it is a venue: the 4th quarter of a real game for Demo Day, or real data for a test.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Market, Odds, Venue } from './types.ts'
import { FakeOdds, FakeVenue } from './fake.ts'

type Line =
  | { t: number; markets: Market[] }
  | { t: number; mids: Record<string, number> }
  | { t: number; slug: string; p: [number, number] | null }

/** The same venue and odds, writing each change of markets, their mids and Polymarket prices to `file`. The account is never written. */
export function record(file: string, venue: Venue, odds: Odds, clock: () => number = Date.now): { venue: Venue; odds: Odds } {
  mkdirSync(dirname(file), { recursive: true })
  const last = new Map<string, string>()
  let coins = new Set<string>()
  /** Writes `line` unless its value under `key` is the same as last time. A failed write must not stop trading. */
  const write = (key: string, value: unknown, line: Line) => {
    const json = JSON.stringify(value)
    if (last.get(key) === json) return
    last.set(key, json)
    try { appendFileSync(file, JSON.stringify(line) + '\n') } catch (e) { console.error('tape write failed', e) }
  }
  return {
    venue: {
      async markets(keys) {
        const markets = await venue.markets(keys)
        coins = new Set(markets.flatMap(m => m.sides.map(s => s.coin)))
        write('markets', markets, { t: clock(), markets })
        return markets
      },
      async mids() {
        const all = await venue.mids()
        const mids = Object.fromEntries(Object.entries(all).filter(([coin]) => coins.has(coin))) // the watched markets, not all 700
        write('mids', mids, { t: clock(), mids })
        return all
      },
      account: () => venue.account(),
      best: (coin, side) => venue.best(coin, side),
      order: (asset, side, shares, limit) => venue.order(asset, side, shares, limit),
      settlements: since => venue.settlements(since),
      upcoming: () => venue.upcoming(),
    },
    odds: {
      async prices(slug, sides) {
        const p = await odds.prices(slug, sides)
        write(`odds:${slug}`, p, { t: clock(), slug, p })
        return p
      },
      match: m => odds.match(m),
    },
  }
}

/**
 * A fake venue that plays `file` back from `fromSec` seconds into it, at `speed`. Market times move with it, so a game
 * recorded on Thursday shows as on now. Orders fill against the recorded mids ± 1 cent, from a fresh $1000 demo account.
 */
export function replay(file: string, o: { fromSec?: number; speed?: number } = {}, clock: () => number = Date.now) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Line)
  if (!lines.length) throw new Error(`Empty tape ${file}`)
  const speed = o.speed ?? 1
  const t0 = lines[0].t + (o.fromSec ?? 0) * 1000
  const start = clock()
  const venue = new FakeVenue()
  const odds = new FakeOdds()
  let markets: Market[] = []
  let next = 0

  const update = () => {
    const now = clock()
    const at = t0 + (now - start) * speed
    for (; next < lines.length && lines[next].t <= at; next++) {
      const l = lines[next]
      if ('markets' in l) markets = l.markets
      else if ('mids' in l) venue.midMap = { ...l.mids }
      else odds.map[l.slug] = l.p
    }
    const shift = now - at
    venue.list = markets.map(m => ({ ...m, startsAt: m.startsAt && m.startsAt + shift, endsAt: m.endsAt && m.endsAt + shift }))
  }
  update()
  const read = { markets: venue.markets.bind(venue), mids: venue.mids.bind(venue), prices: odds.prices.bind(odds) }
  venue.markets = async keys => { update(); return read.markets(keys) }
  venue.mids = async () => { update(); return read.mids() }
  odds.prices = async slug => { update(); return read.prices(slug) }
  return { venue, odds }
}
