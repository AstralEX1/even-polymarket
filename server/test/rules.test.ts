import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, equity, evaluate, type Snapshot } from '../src/rules.ts'
import { market } from '../src/fake.ts'
import type { Config } from '../src/types.ts'

const cfg: Config = { ...DEFAULT_CONFIG }
const game = market('27159', 27159, 'KC vs BUF', ['KC', 'Kansas City Chiefs'], ['BUF', 'Buffalo Bills'])
const NOW = 1_800_000_000_000

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    markets: [game],
    mids: { '#271590': 0.5, '#271591': 0.5 },
    live: {},
    history: {},
    account: { usdc: 100, holdings: [{ token: '+271590', shares: 20, cost: 9 }] },
    now: NOW,
    ...over,
  }
}

test('no card for a market you do not hold', () => {
  const r = evaluate(snap({ account: { usdc: 100, holdings: [] }, live: { '27159': [0.9, 0.1] } }), cfg, new Set())
  assert.equal(r.cards.length, 0)
})

test('target reached → one sell card quoted at the Hyperliquid mid', () => {
  const r = evaluate(snap({ live: { '27159': [0.86, 0.14] }, mids: { '#271590': 0.8, '#271591': 0.2 } }), cfg, new Set())
  assert.equal(r.cards.length, 1)
  const c = r.cards[0]
  assert.equal(c.key, 'target:27159:0')
  assert.equal(c.title, 'KC vs BUF: KC at 86%, your target')
  assert.deepEqual(c.action, { type: 'sell', market: '27159', sideIndex: 0, sideName: 'KC', coin: '#271590', asset: 100271590, shares: 20, price: 0.8 })
  assert.equal(c.question, 'Cash out 20 KC for $16.00 (+$7.00)?') // money, not a price to decode
})

test('a swing either way raises a card; the target wins over the swing', () => {
  const up = evaluate(snap({ history: { '27159': [{ t: NOW - 60_000, p: 0.5 }, { t: NOW, p: 0.68 }] } }), cfg, new Set())
  assert.equal(up.cards[0].key, 'swing:27159:0')
  assert.equal(up.cards[0].title, 'KC vs BUF: KC ↑18 in 5 min, now 50%') // no Polymarket: live = Hyperliquid mid 0.5

  const holdBuf = { usdc: 100, holdings: [{ token: '+271591', shares: 10, cost: 5 }] }
  const down = evaluate(snap({ account: holdBuf, history: { '27159': [{ t: NOW - 60_000, p: 0.5 }, { t: NOW, p: 0.68 }] } }), cfg, new Set())
  assert.match(down.cards[0].title, /BUF ↓18 in 5 min/) // side 1 moves against side 0

  const small = evaluate(snap({ history: { '27159': [{ t: NOW - 60_000, p: 0.5 }, { t: NOW, p: 0.6 }] } }), cfg, new Set())
  assert.equal(small.cards.length, 0)

  const both = evaluate(snap({ live: { '27159': [0.9, 0.1] }, history: { '27159': [{ t: NOW - 60_000, p: 0.6 }, { t: NOW, p: 0.9 }] } }), cfg, new Set())
  assert.deepEqual(both.cards.map(c => c.key), ['target:27159:0'])
})

test('a fired key does not repeat and re-arms when the condition clears', () => {
  const hot = snap({ live: { '27159': [0.9, 0.1] } })
  const first = evaluate(hot, cfg, new Set())
  const again = evaluate(hot, cfg, first.fired)
  assert.equal(again.cards.length, 0)
  assert.ok(again.fired.has('target:27159:0'))
  const wobble = evaluate(snap({ live: { '27159': [0.83, 0.17] } }), cfg, again.fired) // within the 3c band: still fired
  assert.equal(wobble.cards.length, 0)
  assert.ok(wobble.fired.has('target:27159:0'))
  const cool = evaluate(snap({ live: { '27159': [0.81, 0.19] } }), cfg, wobble.fired)
  assert.equal(cool.fired.has('target:27159:0'), false)
  assert.equal(evaluate(snap({ live: { '27159': [0.83, 0.17] } }), cfg, cool.fired).cards.length, 0) // re-arms only at the full threshold
})

test('no quote, no card', () => {
  const r = evaluate(snap({ live: { '27159': [0.9, 0.1] }, mids: {} }), cfg, new Set())
  assert.equal(r.cards.length, 0)
})

test('ends-soon notice once for a held market', () => {
  const soon = snap({ markets: [{ ...game, endsAt: NOW + 10 * 60_000 }] })
  const r = evaluate(soon, cfg, new Set())
  assert.deepEqual(r.toasts, ['KC vs BUF ends in 10 min'])
  assert.deepEqual(evaluate(soon, cfg, r.fired).toasts, [])
})

test('equity counts holdings at mid, at cost without one', () => {
  assert.equal(equity({ usdc: 100, holdings: [{ token: '+271590', shares: 20, cost: 9 }] }, { '#271590': 0.5 }), 110)
  assert.equal(equity({ usdc: 100, holdings: [{ token: '+5', shares: 20, cost: 9 }] }, {}), 109)
})
