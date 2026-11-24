import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { record, replay } from '../src/tape.ts'
import { FakeOdds, FakeVenue, market } from '../src/fake.ts'

const T = 1_795_000_000_000
const KC = market('27159', 27159, 'KC vs BUF', ['KC', 'Kansas City Chiefs'], ['BUF', 'Buffalo Bills'], T + 3 * 3_600_000, T - 600_000)
const SLUG = 'nfl-kc-buf-2026-11-27'
const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))

test('record writes markets, the watched mids and Polymarket prices, each only when it changes; never the account', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tape-')), 'tapes', 'day.jsonl')
  const venue = new FakeVenue()
  const odds = new FakeOdds()
  venue.list = [KC]
  venue.midMap = { '#271590': 0.5, '#271591': 0.5, '#999990': 0.2 }
  odds.map[SLUG] = [0.41, 0.59]
  let now = T
  const taped = record(file, venue, odds, () => now)
  const tick = async () => {
    await taped.venue.markets(['27159'])
    await taped.venue.mids()
    await taped.venue.account()
    return taped.odds.prices(SLUG, KC.sides)
  }
  assert.deepEqual(await tick(), [0.41, 0.59]) // passes through
  now += 2000
  await tick() // nothing changed: nothing written
  now += 2000
  odds.map[SLUG] = [0.6, 0.4]
  await tick()
  const out = lines(file)
  assert.deepEqual(out.map(l => Object.keys(l).join()), ['t,markets', 't,mids', 't,slug,p', 't,slug,p'])
  assert.deepEqual(out[1].mids, { '#271590': 0.5, '#271591': 0.5 }) // the market on screen, not every outcome
  assert.deepEqual(out[3], { t: T + 4000, slug: SLUG, p: [0.6, 0.4] })
  assert.doesNotMatch(readFileSync(file, 'utf8'), /usdc|holdings/)
})

test('replay plays the tape from a point at a speed, with market times moved to now', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tape-')), 'game.jsonl')
  const venue = new FakeVenue()
  const odds = new FakeOdds()
  venue.list = [KC]
  let now = T
  const taped = record(file, venue, odds, () => now)
  for (const [sec, kc] of [[0, 0.5], [60, 0.55], [120, 0.73]] as const) {
    now = T + sec * 1000
    venue.midMap = { '#271590': kc, '#271591': 1 - kc }
    odds.map[SLUG] = [kc + 0.04, 0.96 - kc]
    await taped.venue.markets(['27159'])
    await taped.venue.mids()
    await taped.odds.prices(SLUG, KC.sides)
  }

  let clock = 5_000_000_000_000 // Demo Day
  const r = replay(file, { fromSec: 50, speed: 2 }, () => clock)
  assert.equal((await r.venue.mids())['#271590'], 0.5) // 50 s in: the first sample still holds
  const [m] = await r.venue.markets(['27159'])
  assert.equal(m.startsAt, clock - 50_000 - 600_000) // kick-off as far back as it was at that point of the tape
  clock += 5000 // 10 s of tape at double speed
  assert.equal((await r.venue.mids())['#271590'], 0.55)
  assert.deepEqual(await r.odds.prices(SLUG), [0.55 + 0.04, 0.96 - 0.55])
  clock += 60_000
  assert.equal((await r.venue.mids())['#271590'], 0.73) // past the end, the last state stays
  assert.equal(await r.venue.best('#271590', 'Buy'), 0.74) // orders fill against the recorded mid ± 1 cent
  assert.deepEqual(await r.venue.markets(['other']), [])
})
