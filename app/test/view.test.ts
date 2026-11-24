import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderScreen, timeLeft, wrap } from '../src/view.ts'
import type { SessionState } from '../../server/src/types.ts'

const NOW = 1_800_000_000_000
const base: SessionState = {
  markets: [{
    key: '27159', title: 'KC vs BUF', startsAt: NOW + 3 * 3_600_000 + 5 * 60_000, endsAt: NOW + 72 * 3_600_000,
    sides: [{ name: 'KC', hl: 0.51, pm: 0.58, change: 12 }, { name: 'BUF', hl: 0.49, pm: 0.42, change: -12 }],
    holdings: [{ sideIndex: 0, shares: 20, cost: 9, value: 10.2 }],
  }, {
    key: 'daily:BTC', title: 'BTC >= 60,393', startsAt: 0, endsAt: NOW + 90 * 60_000,
    sides: [{ name: 'Yes', hl: 0.5, pm: null, change: null }, { name: 'No', hl: 0.5, pm: null, change: null }],
    holdings: [],
  }],
  usdc: 990.8, dayPnl: 1.2, dailyLossLimitUsd: 50, locked: false, coolDownUntil: 0,
  card: null, pending: 0, toast: null, error: null, updatedAt: NOW,
}

// The glasses font: ASCII, Latin-1, arrows and the box-drawing line.
const ALLOWED = /^[\x20-\x7e\xa0-\xff←↑→↓─\n]*$/

test('the market screen: one percentage per side, your bet in money, today against the limit', () => {
  const text = renderScreen(base, 0, false, '', NOW)
  assert.equal(text, [
    'KC vs BUF · starts in 3h 5m · 1/2',
    'KC  58%  ↑12  · HL 51%', // Hyperliquid shows: 7 points off the live odds
    'BUF  42%  ↓12  · HL 49%',
    'You: 20 KC  +$1.20 · pays $20 if KC wins',
    'Today +$1.20 of $50 limit',
    'tap: speak · scroll: next',
  ].join('\n'))
  assert.match(text, ALLOWED)
  const close = { ...base.markets[0], sides: [{ ...base.markets[0].sides[0], hl: 0.57 }, { ...base.markets[0].sides[1], hl: 0.43 }] } as typeof base.markets[0]
  assert.match(renderScreen({ ...base, markets: [close] }, 0, false, '', NOW), /\nKC  58%  ↑12\nBUF  42%  ↓12\n/) // 1 point off: one number
})

test('scroll focus picks the market; without Polymarket the Hyperliquid mid is the live price', () => {
  const text = renderScreen(base, 1, false, '', NOW)
  assert.match(text, /^BTC >= 60,393 · ends in 1h 30m · 2\/2\n/)
  const live = renderScreen({ ...base, markets: [{ ...base.markets[0], startsAt: NOW - 60_000 }] }, 0, false, '', NOW)
  assert.match(live, /^KC vs BUF\n/) // a game on shows no deadline
  assert.match(text, /\nYes  50%\n/)
})

test('a card says the decision in money first, then why; NO / YES is the list beside it', () => {
  const card = { id: 'c', key: 'k', title: 'KC vs BUF: KC now 58%', question: 'Buy 39 KC for $19.89? Pays $39 if KC wins',
    action: { type: 'buy' as const, market: '27159', sideIndex: 0, sideName: 'KC', coin: '#271590', asset: 100271590, shares: 39, price: 0.51 }, expiresAt: NOW + 30_000 }
  const text = renderScreen({ ...base, card, pending: 2 }, 0, false, '', NOW)
  assert.equal(text, ['Buy 39 KC for $19.89? Pays $39 if KC wins', 'KC vs BUF: KC now 58%', '+1 more'].join('\n'))
})

test('lock, cool-down, stale data and offline are said plainly', () => {
  assert.match(renderScreen({ ...base, locked: true }, 0, false, '', NOW), /LOCKED: daily loss limit/)
  assert.match(renderScreen({ ...base, coolDownUntil: NOW + 7 * 60_000 }, 0, false, '', NOW), /COOL-DOWN 7 min/)
  assert.match(renderScreen({ ...base, error: 'No fresh data for 12s' }, 0, false, '', NOW), /^! No fresh data for 12s\n/) // on top, only when wrong
  assert.equal(renderScreen(null, 0, true, '', NOW), 'Server offline. Retrying...')
  assert.match(renderScreen({ ...base, markets: [] }, 0, false, '', NOW), /No markets/)
})

test('timeLeft', () => {
  assert.equal(timeLeft(12 * 60_000), '12m')
  assert.equal(timeLeft(3 * 3_600_000 + 5 * 60_000), '3h 5m')
  assert.equal(timeLeft(50 * 3_600_000), '2d 2h')
  assert.equal(timeLeft(-1), 'ended')
})

test('long lines wrap at a space and keep their end; odd characters are cleaned', () => {
  const q = 'Buy 166 South Africa at 0.09 ($14.94), pays $166?'
  assert.deepEqual(wrap(q), ['Buy 166 South Africa at 0.09 ($14.94), pays', '$166?'])
  assert.deepEqual(wrap('x'.repeat(50)), ['x'.repeat(46), 'xxxx'])
  const text = renderScreen({ ...base, toast: 'Say it like “20 on KC”… 🙂' }, 0, false, '', NOW)
  assert.match(text, /Say it like "20 on KC"\.\.\. $/)
  assert.match(text, ALLOWED)
  for (const line of text.split('\n')) assert.ok(line.length <= 46, line)
})
