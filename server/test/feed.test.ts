import { test } from 'node:test'
import assert from 'node:assert/strict'
import { polymarketFeed, type Socket } from '../src/feed.ts'

class FakeSocket implements Socket {
  readyState = 0
  sent: string[] = []
  onopen: Socket['onopen'] = null
  onmessage: Socket['onmessage'] = null
  onclose: Socket['onclose'] = null
  onerror: Socket['onerror'] = null
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3; this.onclose?.({}) }
  up() { this.readyState = 1; this.onopen?.({}) }
  push(m: unknown) { this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) }) }
}

function setup() {
  const sockets: FakeSocket[] = []
  const feed = polymarketFeed({ socket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
  let changes = 0
  feed.onChange(() => changes++)
  return { feed, sockets, changes: () => changes }
}

// Shapes seen on the live socket on 24.11.2026: a book snapshot (bids ascending, asks descending), then price_change entries.
const book = (asset_id: string, bids: string[], asks: string[]) =>
  ({ event_type: 'book', asset_id, bids: bids.map(price => ({ price, size: '10' })), asks: asks.map(price => ({ price, size: '10' })) })

test('the book snapshot and its price changes give the midpoint; nothing before the first snapshot', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { feed, sockets, changes } = setup()
  feed.watch(['kc'])
  const s = sockets[0]
  s.up()
  assert.deepEqual(JSON.parse(s.sent[0]), { assets_ids: ['kc'], type: 'market' })
  assert.equal(feed.mid('kc'), undefined)
  s.push([book('kc', ['0.40', '0.41'], ['0.44', '0.43'])])
  assert.equal(feed.mid('kc'), 0.42)
  s.push({ event_type: 'price_change', price_changes: [{ asset_id: 'kc', price: '0.5', size: '5', side: 'BUY', best_bid: '0.55', best_ask: '0.57' }] })
  assert.equal(feed.mid('kc'), 0.56)
  s.push({ event_type: 'price_change', price_changes: [{ asset_id: 'other', best_bid: '0.1', best_ask: '0.2' }] })
  assert.equal(feed.mid('other'), undefined) // not watched
  s.push('PONG')
  assert.equal(changes(), 3)
  t.mock.timers.tick(10_000)
  assert.equal(s.sent.at(-1), 'PING')
  feed.close()
})

test('an empty or crossed side has no midpoint', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { feed, sockets } = setup()
  feed.watch(['kc'])
  sockets[0].up()
  sockets[0].push(book('kc', [], ['0.43']))
  assert.equal(feed.mid('kc'), undefined)
  sockets[0].push({ event_type: 'price_change', price_changes: [{ asset_id: 'kc', best_bid: '0.6', best_ask: '0.5' }] })
  assert.equal(feed.mid('kc'), undefined)
  feed.close()
})

test('a dropped socket clears the books at once and reconnects with backoff, resubscribing every token', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { feed, sockets } = setup()
  feed.watch(['kc'])
  sockets[0].up()
  sockets[0].push(book('kc', ['0.40'], ['0.44']))
  sockets[0].close()
  assert.equal(feed.mid('kc'), undefined) // REST answers until the next snapshot
  t.mock.timers.tick(999)
  assert.equal(sockets.length, 1)
  t.mock.timers.tick(1)
  assert.equal(sockets.length, 2)
  sockets[1].close() // fails again: the wait doubles
  t.mock.timers.tick(1999)
  assert.equal(sockets.length, 2)
  t.mock.timers.tick(1)
  sockets[2].up()
  assert.deepEqual(JSON.parse(sockets[2].sent[0]).assets_ids, ['kc'])
  feed.close()
  t.mock.timers.tick(60_000)
  assert.equal(sockets.length, 3) // closed for good
})

test('a new token reconnects with the whole list; a known one changes nothing', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const { feed, sockets } = setup()
  feed.watch(['kc'])
  sockets[0].up()
  feed.watch(['kc'])
  assert.equal(sockets[0].readyState, 1)
  feed.watch(['btc'])
  assert.equal(sockets[0].readyState, 3)
  t.mock.timers.tick(1000)
  sockets[1].up()
  assert.deepEqual(JSON.parse(sockets[1].sent[0]).assets_ids, ['kc', 'btc'])
  feed.close()
})
