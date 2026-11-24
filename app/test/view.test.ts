import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import { CARD_LINES, CARD_TEXT_HEIGHT, choices, LIST_ITEM_PX, MIC, PADDING, PAGE_LINES, renderScreen, timeLeft, wrap } from '../src/view.ts'
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

// The glasses font: ASCII, Latin-1, arrows and the shapes it draws (no check mark, no emoji).
const ALLOWED = /^[\x20-\x7e\xa0-\xff←↑→↓─│●○▲▼█▒\n]*$/

// font-measurement guide: inner box = size - 2 * (padding + border), 27 px a line, 40 px a list item, 12 px item padding a side.
const lines = (text: string) => measureTextWrap(text, 576 - 2 * PADDING).lineCount
const card = {
  id: 'c', key: 'k', title: 'Will the Kansas City Chiefs beat the Buffalo Bills by more than 7 points in the AFC final? KC now 58%',
  question: 'Buy 166 South Africa for $14.94? Pays $166 if South Africa wins the 2026 World Cup final',
  action: { type: 'buy' as const, market: '27159', sideIndex: 0, sideName: 'South Africa', coin: '#271590', asset: 100271590, shares: 166, price: 0.09 }, expiresAt: NOW + 30_000,
}

test('the market screen: the game, one number, your bet in money; nothing else until it matters', () => {
  const text = renderScreen(base, 0, false, '', NOW)
  assert.equal(text, [
    'KC vs BUF · starts in 3h 5m   ● ○', // page dots: first of two markets
    'KC 58%  ▲12', // the side you hold, at the live odds; BUF is 100 minus it, Hyperliquid's mid shows on the bet card
    '███████▒▒▒▒▒', // 58% as a length
    'You +$1.20 on 20 KC · pays $20',
  ].join('\n'))
  assert.match(text, ALLOWED)
  // Holding nothing, the favourite leads.
  const none = { ...base.markets[0], holdings: [], sides: [{ ...base.markets[0].sides[0], pm: 0.3 }, { ...base.markets[0].sides[1], pm: 0.7 }] } as typeof base.markets[0]
  assert.match(renderScreen({ ...base, markets: [none] }, 0, false, '', NOW), /^KC vs BUF · starts in 3h 5m\nBUF 70%  ▼12\n████████▒▒▒▒$/)
})

test('the how-to line teaches by example until the first spoken bet; the limit shows once half of it is gone', () => {
  assert.match(renderScreen(base, 0, false, '', NOW, true), /\nTap and say "20 on KC"$/)
  assert.doesNotMatch(renderScreen(base, 0, false, '', NOW, false), /Tap and say/)
  assert.doesNotMatch(renderScreen({ ...base, dayPnl: -24 }, 0, false, '', NOW), /limit/)
  assert.match(renderScreen({ ...base, dayPnl: -25 }, 0, false, '', NOW, true), /\nToday -\$25.00 of \$50 limit$/) // the warning takes the how-to's place
})

test('scroll focus picks the market; without Polymarket the Hyperliquid mid is the live price', () => {
  const text = renderScreen(base, 1, false, '', NOW)
  assert.match(text, /^BTC >= 60,393 · ends in 1h 30m   ○ ●\n/)
  const live = renderScreen({ ...base, markets: [{ ...base.markets[0], startsAt: NOW - 60_000 }] }, 0, false, '', NOW)
  assert.match(live, /^KC vs BUF\n/) // a game on shows no deadline
  assert.match(text, /\nYes 50%\n██████▒▒▒▒▒▒$/)
})

test('a card says the decision in money first, then why; its two actions name what they do, the safe one first', () => {
  const card = { id: 'c', key: 'k', title: 'KC vs BUF: KC now 58%', question: 'Buy 39 KC for $19.89? Pays $39 if KC wins',
    action: { type: 'buy' as const, market: '27159', sideIndex: 0, sideName: 'KC', coin: '#271590', asset: 100271590, shares: 39, price: 0.51 }, expiresAt: NOW + 30_000 }
  const text = renderScreen({ ...base, card, pending: 2 }, 0, false, '', NOW)
  assert.equal(text, ['Buy 39 KC for $19.89? Pays $39 if KC wins', 'KC vs BUF: KC now 58%', '+1 more'].join('\n'))
  assert.deepEqual(choices(card), ['Not now', 'Buy 39 KC'])
  assert.deepEqual(choices({ ...card, action: { ...card.action, type: 'sell', shares: 20 } }), ['Keep', 'Cash out 20 KC'])
})

test("the app's note replaces the server toast it repeats, so a result shows once", () => {
  const s = { ...base, toast: 'Bought 39 KC for $19.89' }
  assert.match(renderScreen(s, 0, false, 'Bought 39 KC for $19.89 · 1.4 s', NOW), /\nBought 39 KC for \$19.89 · 1.4 s$/)
  assert.equal(renderScreen(s, 0, false, 'Bought 39 KC for $19.89 · 1.4 s', NOW).split('Bought').length, 2)
  assert.match(renderScreen(s, 0, false, 'Listening...', NOW), /\nBought 39 KC for \$19.89\nListening\.\.\.$/)
})

test('lock, cool-down, stale data and offline are said plainly', () => {
  assert.match(renderScreen({ ...base, locked: true }, 0, false, '', NOW), /Locked: daily loss limit/)
  assert.match(renderScreen({ ...base, coolDownUntil: NOW + 7 * 60_000 }, 0, false, '', NOW), /Cool-down 7 min/)
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

test('long lines wrap at a space and keep their end, at the font width; odd characters are cleaned', () => {
  const q = 'Buy 166 South Africa for $14.94? Pays $166 if South Africa wins the 2026 World Cup final'
  assert.deepEqual(wrap(q), ['Buy 166 South Africa for $14.94? Pays $166 if South Africa wins', 'the 2026 World Cup final'])
  assert.deepEqual(wrap('x'.repeat(60)), ['x'.repeat(51), 'x'.repeat(9)])
  const text = renderScreen({ ...base, toast: 'Say it like “20 on KC”… 🙂' }, 0, false, '', NOW)
  assert.match(text, /Say it like "20 on KC"\.\.\. $/)
  assert.match(text, ALLOWED)
  for (const line of text.split('\n')) assert.equal(lines(line), 1, line)
})

test('the boxes hold 10 lines (market page) and 6 (card text); the two list items fit under the card', () => {
  assert.equal(PAGE_LINES, 10)
  assert.equal(CARD_LINES, 6)
  assert.ok(2 * LIST_ITEM_PX <= 288 - CARD_TEXT_HEIGHT - 2 * PADDING)
})

test('a full card keeps its question whole: the toast goes first, then the app note, then "+N more", then the title', () => {
  const s = { ...base, card, pending: 3, toast: 'Heard "20 on South Africa"' }
  const fit = (t: string) => { assert.ok(lines(t) <= CARD_LINES, t); assert.ok(t.includes(wrap(card.question).join('\n')), t); return t }
  const roomy = fit(renderScreen(s, 0, false, `${MIC} Say "yes" or "no"`, NOW))
  assert.doesNotMatch(roomy, /Heard/)
  assert.match(roomy, /\n\+2 more\n● Say "yes" or "no"$/)
  const crowded = fit(renderScreen({ ...s, error: 'No fresh data for 12s' }, 0, true, `${MIC} Say "yes" or "no"`, NOW))
  assert.doesNotMatch(crowded, /Heard|Say "yes"|\+2 more/)
  assert.match(crowded, /Kansas City/)
  const worst = fit(renderScreen({ ...s, error: 'No fresh data for 12s from Hyperliquid testnet and none from Polymarket either' }, 0, true, 'x', NOW))
  assert.doesNotMatch(worst, /Kansas City/)
})

test('a full market page stays inside its box (no firmware scroll): the how-to goes first, then the toast', () => {
  const m = { ...base.markets[0], title: 'Will the Kansas City Chiefs beat the Buffalo Bills by more than 7 points in the AFC final?',
    holdings: [{ sideIndex: 0, shares: 20, cost: 9, value: 10.2 }, { sideIndex: 1, shares: 166, cost: 14.94, value: 9.1 }] }
  const s = { ...base, markets: [m, base.markets[1]], error: 'No fresh data for 12s', toast: 'KC vs BUF ends in 5 min' }
  const text = renderScreen(s, 0, true, `${MIC} Listening`, NOW, true)
  assert.ok(lines(text) <= PAGE_LINES, text)
  assert.doesNotMatch(text, /Tap and say/)
  assert.match(text, /You -\$5\.84 on 166 BUF · pays \$166\nKC vs BUF ends in 5 min\n● Listening$/)
  const locked = renderScreen({ ...s, locked: true }, 0, true, `${MIC} Listening`, NOW, true)
  assert.ok(lines(locked) <= PAGE_LINES, locked)
  assert.match(locked, /\nLocked: daily loss limit\. Cash-outs only\.\n● Listening$/)
})

test('a list item fits the width it shows, within 64 characters', () => {
  const [, act] = choices({ ...card, action: { ...card.action, type: 'sell', sideName: 'Democratic Republic of the Congo national team' } })
  assert.equal(act, pxTruncate(act, 288 - 2 * PADDING - 2 * 12))
  assert.match(act, /^Cash out 166 Democratic .*\.\.\.$/)
  assert.ok(act.length <= 64)
  assert.deepEqual(choices(card), ['Not now', 'Buy 166 South Africa'])
})
