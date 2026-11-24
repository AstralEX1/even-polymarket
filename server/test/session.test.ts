import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, type DayState } from '../src/session.ts'
import { DEFAULT_CONFIG } from '../src/rules.ts'
import { FakeOdds, FakeVenue, market } from '../src/fake.ts'
import type { Config } from '../src/types.ts'

const KC = '#271590'
const game = market('27159', 27159, 'KC vs BUF', ['KC', 'Kansas City Chiefs'], ['BUF', 'Buffalo Bills'])

function setup(over: Partial<Config> = {}, stored: DayState | null = null, start = 1_800_000_000_000) {
  let now = start
  const venue = new FakeVenue()
  venue.list = [game]
  venue.midMap = { [KC]: 0.5, '#271591': 0.5 }
  venue.acct = { usdc: 1000, holdings: [] }
  const odds = new FakeOdds()
  const cfg: Config = { ...DEFAULT_CONFIG, markets: [{ key: '27159', polymarket: 'kc-buf' }], ...over }
  let saved: DayState | null = stored
  const store = { load: () => saved, save: (d: DayState) => { saved = structuredClone(d) } }
  const s = createSession(venue, odds, () => cfg, store, () => now)
  return { s, venue, odds, cfg, saved: () => saved, advance: (ms: number) => { now += ms } }
}

test('a voice bet queues a card at the ask; YES buys with the limit capped at ask + slippage', async () => {
  const t = setup()
  await t.s.tick()
  const v = await t.s.voice('Fifteen on KC.', '27159')
  assert.deepEqual(v, { ok: true, message: 'Heard "Fifteen on KC."' })
  const card = t.s.state().card!
  assert.equal(card.title, 'KC vs BUF: KC now 50%')
  assert.equal(card.question, 'Buy 28 KC for $14.28? Pays $28 if KC wins') // 28 × 0.53 worst fill stays within $15
  assert.deepEqual(t.venue.calls, []) // nothing runs before YES
  const r = await t.s.answer(card.id, true)
  assert.deepEqual(r, { ok: true, message: 'Bought 28 KC for $14.28' })
  assert.deepEqual(t.venue.calls, [{ asset: 100271590, side: 'Buy', shares: 28, limit: 0.53 }])
})

test('NO skips; a second tap on the same card gets "Card is gone"', async () => {
  const t = setup()
  await t.s.tick()
  await t.s.voice('15 on BUF', '27159')
  const id = t.s.state().card!.id
  assert.deepEqual(await t.s.answer(id, false), { ok: true, message: 'Skipped' })
  assert.deepEqual(await t.s.answer(id, true), { ok: false, message: 'Card is gone' })
  assert.deepEqual(t.venue.calls, [])
})

test('YES is refused when the price moved past the slippage, when data is stale, or after the card expired', async () => {
  const t = setup()
  await t.s.tick()
  await t.s.voice('15 on KC', '27159')
  t.venue.midMap[KC] = 0.6
  const moved = await t.s.answer(t.s.state().card!.id, true)
  assert.deepEqual(moved, { ok: false, message: 'Price moved to 61%. Not sent.' })

  t.venue.midMap[KC] = 0.5
  await t.s.tick()
  await t.s.voice('15 on KC', '27159')
  t.advance(11_000) // no tick for 11 s
  assert.deepEqual(await t.s.answer(t.s.state().card!.id, true), { ok: false, message: 'Data is stale. Not sent.' })

  await t.s.tick()
  await t.s.voice('15 on KC', '27159')
  const id = t.s.state().card!.id
  t.advance(31_000)
  assert.deepEqual(await t.s.answer(id, true), { ok: false, message: 'Card expired' })
  assert.deepEqual(t.venue.calls, [])
})

test('a small bet makes a card: outcome orders have no $10 minimum', async () => {
  const t = setup()
  await t.s.tick()
  assert.equal((await t.s.voice('2 on KC', '27159')).ok, true)
  assert.equal(t.s.state().card!.question, 'Buy 3 KC for $1.53? Pays $3 if KC wins') // testnet filled a 2-share IOC at 0.65
})

test('bets over the cap, an unknown side and talk that is not a bet make no card', async () => {
  const t = setup()
  await t.s.tick()
  assert.equal((await t.s.voice('50 on KC', '27159')).message, '$50 is over your $25 cap')
  assert.equal((await t.s.voice('10 on Lakers', '27159')).message, 'Say a side: KC or BUF')
  assert.equal((await t.s.voice('what a game', '27159')).message, 'Say it like "20 on KC"')
  assert.equal((await t.s.voice('10 on yes', 'daily:BTC')).message, 'That market is gone. Scroll to another.')
  assert.equal((await t.s.voice('', '27159')).message, 'Heard nothing')
  assert.equal(t.s.state().card, null)
})

test('a losing cash-out starts the cool-down: no new bets, cash-outs still work', async () => {
  const t = setup()
  t.venue.acct.holdings = [{ token: '+271590', shares: 20, cost: 12 }]
  await t.s.tick()
  await t.s.voice('cash out', '27159')
  const card = t.s.state().card!
  assert.equal(card.question, 'Cash out 20 KC for $9.80 (-$2.20)?')
  const r = await t.s.answer(card.id, true)
  assert.equal(r.message, 'Sold 20 KC for $9.80 (-$2.20)')
  assert.deepEqual(t.s.state().markets[0].holdings, []) // shown at once, not on the next tick
  assert.equal(t.s.state().usdc, 1009.8)
  await t.s.tick()
  assert.ok(t.s.state().coolDownUntil > 0)
  assert.equal((await t.s.voice('15 on KC', '27159')).message, 'Cool-down: 10 min left')
  t.advance(10 * 60_000 + 1)
  await t.s.tick()
  assert.equal((await t.s.voice('15 on KC', '27159')).ok, true)
})

test('a lost settlement starts the cool-down, a won one does not, whatever the last mid said', async () => {
  const lost = setup()
  lost.venue.acct.holdings = [{ token: '+271590', shares: 30, cost: 12 }]
  lost.venue.midMap[KC] = 0.55 // looked like a winner a tick before
  await lost.s.tick()
  lost.venue.acct.holdings = [] // settled No: pays nothing
  await lost.s.tick()
  assert.ok(lost.s.state().coolDownUntil > 0)

  const won = setup()
  won.venue.acct.holdings = [{ token: '+271590', shares: 30, cost: 12 }]
  won.venue.midMap[KC] = 0.2
  await won.s.tick()
  won.venue.acct.holdings = []
  won.venue.acct.usdc += 30 // settled Yes: $1 a share
  await won.s.tick()
  assert.equal(won.s.state().coolDownUntil, 0)
})

test('the cap holds at the worst fill price, even after the config changes under a card', async () => {
  const t = setup()
  await t.s.tick()
  await t.s.voice('25 on KC', '27159')
  const card = t.s.state().card!
  assert.ok(card.action.shares * 0.53 <= 25)
  t.cfg.maxBetUsd = 20 // lowered while the card is up
  assert.deepEqual(await t.s.answer(card.id, true), { ok: false, message: 'Over your $20 cap' })
  assert.deepEqual(t.venue.calls, [])
})

test('the daily loss limit locks new bets until the next day, drops queued bets and survives a restart', async () => {
  const t = setup()
  await t.s.tick()
  await t.s.voice('15 on KC', '27159')
  assert.ok(t.s.state().card)
  t.venue.acct.usdc -= 60 // lost $60 elsewhere today
  await t.s.tick()
  const st = t.s.state()
  assert.equal(st.locked, true)
  assert.equal(st.card, null) // the bet card is gone
  assert.match((await t.s.voice('15 on KC', '27159')).message, /^Locked/)

  const restarted = createSession(t.venue, t.odds, () => t.cfg, { load: t.saved, save: () => {} }, () => 1_800_000_000_000 + 1)
  await restarted.tick()
  assert.equal(restarted.state().locked, true)

  t.advance(86_400_000)
  await t.s.tick()
  assert.equal(t.s.state().locked, false)
})

test('a rule card from live odds; Polymarket failure keeps the last price and reports it', async () => {
  const t = setup()
  t.venue.acct.holdings = [{ token: '+271590', shares: 20, cost: 9 }]
  t.odds.map['kc-buf'] = [0.88, 0.12]
  await t.s.tick()
  const st = t.s.state()
  assert.equal(st.card!.key, 'target:27159:0')
  assert.equal(st.markets[0].sides[0].pm, 0.88)
  t.odds.fail = 'HTTP 503'
  await t.s.tick()
  assert.equal(t.s.state().error, 'Polymarket: HTTP 503')
  assert.equal(t.s.state().markets[0].sides[0].pm, 0.88)
})

test('a failed or timed-out order is reported and the card removed', async () => {
  const t = setup()
  await t.s.tick()
  await t.s.voice('15 on KC', '27159')
  t.venue.failNext = 'Insufficient margin'
  assert.deepEqual(await t.s.answer(t.s.state().card!.id, true), { ok: false, message: 'Failed: Insufficient margin' })
  assert.equal(t.s.state().card, null)

  await t.s.voice('15 on KC', '27159')
  const timeout = new Error('timed out')
  timeout.name = 'TimeoutError'
  t.venue.failNext = timeout
  assert.equal((await t.s.answer(t.s.state().card!.id, true)).message, 'Unknown result: timed out. Check Hyperliquid before betting again.')

  await t.s.voice('15 on KC', '27159')
  const dropped = new Error('fetch failed')
  dropped.name = 'UnknownResult' // the request went out, the reply did not come back
  t.venue.failNext = dropped
  assert.match((await t.s.answer(t.s.state().card!.id, true)).message, /^Unknown result: fetch failed/)
})

test('a venue read error keeps the last data and shows the error', async () => {
  const t = setup()
  await t.s.tick()
  t.venue.failReads = 'HTTP 502'
  await t.s.tick()
  assert.equal(t.s.state().error, 'HTTP 502')
  assert.equal(t.s.state().markets.length, 1)
})

test('a rule card stays put while the odds wobble, and goes when its holding is gone', async () => {
  const t = setup()
  t.venue.acct.holdings = [{ token: '+271590', shares: 20, cost: 9 }]
  t.odds.map['kc-buf'] = [0.88, 0.12]
  await t.s.tick()
  const id = t.s.state().card!.id
  t.odds.map['kc-buf'] = [0.7, 0.3] // condition cleared
  await t.s.tick()
  assert.equal(t.s.state().card!.id, id) // same card: the choice on the glasses is not reset
  t.venue.acct.holdings = [] // sold on the web
  await t.s.tick()
  assert.equal(t.s.state().card, null)
})

test('the daily lock lasts until local midnight, not UTC midnight', async () => {
  const tz = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const t = setup({}, null, Date.UTC(2026, 10, 29, 23, 30)) // Sunday 6:30 pm in New York, during the late game
    await t.s.tick()
    t.venue.acct.usdc -= 60
    await t.s.tick()
    assert.equal(t.s.state().locked, true)
    t.advance(60 * 60_000) // 7:30 pm in New York is already the next day in UTC
    await t.s.tick()
    assert.equal(t.s.state().locked, true)
    t.advance(5 * 60 * 60_000) // 0:30 am in New York
    await t.s.tick()
    assert.equal(t.s.state().locked, false)
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
})

test('USDC moved in from elsewhere does not widen the daily loss limit', async () => {
  const t = setup()
  t.venue.acct.holdings = [{ token: '+271590', shares: 100, cost: 50 }]
  await t.s.tick() // equity 1000 + 100 × 0.50
  t.venue.midMap[KC] = 0.1 // -$40 on the bet
  await t.s.tick()
  t.venue.acct.usdc += 100 // a transfer from perps or the faucet
  await t.s.tick()
  assert.equal(Math.round(t.s.state().dayPnl), -40)
  t.venue.midMap[KC] = 0 // another -$10: -$50 in all
  await t.s.tick()
  assert.equal(t.s.state().locked, true)
})

test('Polymarket is asked for all markets at once, and Hyperliquid data counts as fresh while it answers', async () => {
  const t = setup({ markets: [{ key: '27159', polymarket: 'kc-buf' }, { key: '2', polymarket: 'btc-up' }] })
  t.venue.list.push(market('2', 2, 'BTC >= 1', ['Yes'], ['No']))
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let asked = 0
  t.odds.prices = async () => { asked++; await gate; return null }
  const ticking = t.s.tick()
  await new Promise(r => setImmediate(r))
  assert.equal(asked, 2) // both before either answered
  assert.ok(t.s.state().updatedAt > 0) // a cash-out is not refused as stale while Polymarket hangs
  release()
  await ticking
})

test('a spoken "yes" buys like a YES tap, "no" skips, and anything else leaves the card up', async () => {
  const t = setup()
  await t.s.tick()
  await t.s.voice('fifteen on KC', '27159')
  const id = t.s.state().card!.id
  assert.deepEqual(await t.s.confirm('yes, but wait', id), { ok: false, message: 'Heard "yes, but wait". Scroll and tap instead.' })
  assert.equal(t.s.state().card!.id, id) // still up
  assert.deepEqual(await t.s.confirm('Yes.', 'another-card'), { ok: false, message: 'Card is gone' })
  assert.deepEqual(await t.s.confirm('Yes.', id), { ok: true, message: 'Bought 28 KC for $14.28' })
  assert.deepEqual(t.venue.calls, [{ asset: 100271590, side: 'Buy', shares: 28, limit: 0.53 }])

  await t.s.voice('15 on BUF', '27159')
  assert.deepEqual(await t.s.confirm('no thanks', t.s.state().card!.id), { ok: true, message: 'Skipped' })
  assert.equal(t.venue.calls.length, 1)
})

test('Hyperliquid reads go out at once, so one slow read costs one timeout', async () => {
  const t = setup()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const asked: string[] = []
  for (const k of ['markets', 'mids', 'account'] as const) {
    const real = (t.venue[k] as () => Promise<unknown>).bind(t.venue)
    ;(t.venue as any)[k] = async (...a: unknown[]) => { asked.push(k); await gate; return (real as any)(...a) }
  }
  const ticking = t.s.tick()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(asked, ['markets', 'mids', 'account']) // all three before any answered
  release()
  await ticking
  assert.equal(t.s.state().markets.length, 1)
})

test('an order that fills while a tick is reading keeps the account it wrote', async () => {
  const t = setup()
  t.venue.acct.holdings = [{ token: '+271590', shares: 20, cost: 12 }]
  await t.s.tick()
  await t.s.voice('cash out', '27159')
  const card = t.s.state().card!
  // This tick reads the account before the sell and gets its answer after it.
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const read = t.venue.account.bind(t.venue)
  t.venue.account = async () => { t.venue.account = read; const before = await read(); await gate; return before }
  const ticking = t.s.tick()
  await new Promise(r => setImmediate(r))
  assert.equal((await t.s.answer(card.id, true)).message, 'Sold 20 KC for $9.80 (-$2.20)')
  release()
  await ticking
  assert.deepEqual(t.s.state().markets[0].holdings, []) // not the sold holding back from the older read
  assert.equal(t.s.state().usdc, 1009.8)
})

test('a booked settlement decides the cool-down even when other USDC moved in the same tick', async () => {
  const lost = setup()
  lost.venue.acct.holdings = [{ token: '+271590', shares: 30, cost: 12 }]
  await lost.s.tick()
  lost.venue.acct.holdings = []
  lost.venue.acct.usdc += 100 // a transfer landed with the settlement: by USDC alone this looks like a win
  lost.venue.settled = { '+271590': -12 }
  await lost.s.tick()
  assert.ok(lost.s.state().coolDownUntil > 0)

  const won = setup()
  won.venue.acct.holdings = [{ token: '+271590', shares: 30, cost: 12 }]
  await won.s.tick()
  won.venue.acct.holdings = []
  won.venue.acct.usdc += 30 - 50 // paid $30 while $50 went out: by USDC alone this looks like a loss
  won.venue.settled = { '+271590': 18 }
  await won.s.tick()
  assert.equal(won.s.state().coolDownUntil, 0)
})
