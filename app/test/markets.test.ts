import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketLine, parseMarkets } from '../src/markets.ts'

test('parseMarkets reads ids, daily series and Polymarket slugs or links', () => {
  assert.deepEqual(parseMarkets('27159 nfl-kc-buf-2026-11-27\n\n daily:btc \n27150 https://polymarket.com/event/nfl-phi-dal-2026-11-26?tid=1'), [
    { key: '27159', polymarket: 'nfl-kc-buf-2026-11-27' },
    { key: 'daily:BTC' },
    { key: '27150', polymarket: 'nfl-phi-dal-2026-11-26' },
  ])
  assert.throws(() => parseMarkets('KC vs BUF'), /Cannot read market "KC vs BUF"/)
})

test('marketLine round-trips', () => {
  const ms = [{ key: '27159', polymarket: 'nfl-kc-buf-2026-11-27' }, { key: 'daily:BTC' }]
  assert.deepEqual(parseMarkets(ms.map(marketLine).join('\n')), ms)
})
