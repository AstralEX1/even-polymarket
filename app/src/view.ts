import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import type { Card, MarketView, SessionState, SideView } from '../../server/src/types.ts'
import { money, pct, usd } from '../../server/src/format.ts'

// The glasses page (main.ts): 576 x 288; its text boxes have padding 4 and no border; a card's text sits above its list.
export const PADDING = 4
export const CARD_TEXT_HEIGHT = 176
const LINE_PX = 27 // the firmware font's fixed line height
export const LIST_ITEM_PX = 40 // and a list item's
const TEXT_PX = 576 - 2 * PADDING // a box's inner width: width - 2 * (padding + border)
const ITEM_PX = 288 - 2 * PADDING - 2 * 12 // a list item's text: the list's inner width less the item's 12 px a side
/** Lines a box holds. More, and the market page scrolls inside the firmware (other scroll events) and a card's text is cut off. */
export const PAGE_LINES = Math.floor((288 - 2 * PADDING) / LINE_PX)
export const CARD_LINES = Math.floor((CARD_TEXT_HEIGHT - 2 * PADDING) / LINE_PX)

/**
 * Characters the glasses font lacks (curly quotes, ellipsis, emoji in a heard phrase or a market title) become plain ones or go.
 * Kept: Latin-1, arrows and the shapes the firmware font draws (even-g2-notes display.md): no check mark, no emoji.
 */
const plain = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff←↑→↓─│●○▲▼█▒]/g, '')

/** Pre-attentive marks: read from the corner of the eye, before the words. */
export const MIC = '●' // the mic is on, like the recording dot on a phone
const BAR = 12

/** 58% → ███████▒▒▒▒▒ : the chance as a length on a visible track, seen before the number is read. ━ ─ blur into one line. */
export const bar = (p: number) => '█'.repeat(Math.round(p * BAR)) + '▒'.repeat(BAR - Math.round(p * BAR))

/** Where you are among several markets, like page dots: ● ○ ○. */
const dots = (at: number, of: number) => Array.from({ length: of }, (_, i) => (i === at ? '●' : '○')).join(' ')

/** Long lines wrap at a space instead of losing their end (a price, a payout), measured in the glasses font's pixels. */
export function wrap(s: string): string[] {
  const out: string[] = []
  let line = ''
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (getTextWidth(next) <= TEXT_PX) { line = next; continue }
    if (line) out.push(line)
    line = word
    while (getTextWidth(line) > TEXT_PX) {
      let n = line.length - 1
      while (n > 1 && getTextWidth(line.slice(0, n)) > TEXT_PX) n--
      out.push(line.slice(0, n))
      line = line.slice(n)
    }
  }
  return [...out, line]
}

export function timeLeft(ms: number): string {
  if (ms <= 0) return 'ended'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

const live = (s: SideView) => s.pm ?? s.hl

function sideLine(s: SideView): string {
  const p = live(s)
  if (p === null) return `${s.name}  -`
  const change = s.change ? `  ${s.change > 0 ? '▲' : '▼'}${Math.abs(s.change)}` : ''
  return `${s.name} ${pct(p)}${change}`
}

/** A list item's label, cut to the width the item shows (at 4 px or more a character, that is within the SDK's 64). */
const item = (s: string) => pxTruncate(plain(s), ITEM_PX)

/** The card's two list items, the safe one first: a stray tap on a new card declines it. They name the action, not Yes / No. */
export function choices(card: Card): [string, string] {
  const { type, shares, sideName } = card.action
  return type === 'buy' ? ['Not now', item(`Buy ${shares} ${sideName}`)] : ['Keep', item(`Cash out ${shares} ${sideName}`)]
}

function when(m: MarketView, now: number): string {
  if (m.startsAt > now) return ` · starts in ${timeLeft(m.startsAt - now)}`
  if (m.startsAt) return '' // a game on: its resolution deadline says nothing useful
  return m.endsAt ? ` · ends in ${timeLeft(m.endsAt - now)}` : ''
}

/** The side you hold, else the favourite: the one number you need. The other side is 100 minus it. */
function heroSide(m: MarketView): number {
  if (m.holdings.length) return m.holdings[0].sideIndex
  return (live(m.sides[1]) ?? 0) > (live(m.sides[0]) ?? 0) ? 1 : 0
}

function marketLines(m: MarketView, at: number, of: number, now: number): string[] {
  const hero = m.sides[heroSide(m)]
  const p = live(hero)
  const out = [`${m.title}${when(m, now)}${of > 1 && of <= 5 ? `   ${dots(at, of)}` : of > 5 ? ` · ${at + 1}/${of}` : ''}`, sideLine(hero)]
  if (p !== null) out.push(bar(p))
  for (const h of m.holdings) {
    const name = m.sides[h.sideIndex].name
    out.push(`You ${money(h.value - h.cost)} on ${h.shares} ${name} · pays ${usd(h.shares)}`)
  }
  return out
}

/** The limit line shows once half of the day's loss limit is gone: a warning before the lock, not a permanent label. */
const LIMIT_WARN = 0.5

/** When a box is too full, lines go in this order, lowest rank first and, among equals, the one further down. A card's question never goes. */
const HINT = 0, TOAST = 1, NOTE = 2, MORE = 3, REST = 4, QUESTION = 5
type Line = [text: string, rank: number]

// One look: the game, one number, your bet in money. Everything else shows only when it matters.
function body(s: SessionState, focus: number, now: number, hint: boolean): Line[] {
  const out: Line[] = []
  if (s.error) out.push([`! ${s.error}`, REST]) // on top, and only when something is wrong
  if (s.card) {
    // The decision in money first, then why it is up. The two actions are the list under this text.
    out.push([s.card.question, QUESTION], [s.card.title, REST])
    if (s.pending > 1) out.push([`+${s.pending - 1} more`, MORE])
  } else {
    const m = s.markets[focus]
    if (!m) out.push(['No markets. Add one on the phone page.', REST])
    else out.push(...marketLines(m, focus, s.markets.length, now).map((l): Line => [l, REST]))
    if (s.locked) out.push(['Locked: daily loss limit. Cash-outs only.', REST])
    else if (s.coolDownUntil > now) out.push([`Cool-down ${Math.ceil((s.coolDownUntil - now) / 60_000)} min: cash-outs only`, REST])
    else if (s.dayPnl <= -LIMIT_WARN * s.dailyLossLimitUsd) out.push([`Today ${money(s.dayPnl)} of ${usd(s.dailyLossLimitUsd)} limit`, REST])
    else if (m && hint) out.push([`Tap and say "20 on ${m.sides[heroSide(m)].name}"`, HINT]) // taught by example, until the first bet you speak
  }
  return out
}

/**
 * The text part of the glasses screen. Pure, so it is tested without the SDK. A card's two actions are a list under it.
 * `voice` is the app's own note (listening, sending, a result with its time); the server's toast it repeats is not shown twice.
 */
export function renderScreen(s: SessionState | null, focus: number, offline: boolean, voice = '', now = Date.now(), hint = false): string {
  const out: Line[] = offline ? [['Server offline. Retrying...', REST]] : []
  if (s) out.push(...body(s, focus, now, hint))
  else if (!offline) out.push(['Connecting...', REST])
  if (s?.toast && !voice.startsWith(s.toast)) out.push([s.toast, TOAST])
  if (voice) out.push([voice, NOTE])
  const parts = out.map(([text, rank]) => ({ lines: wrap(plain(text)), rank }))
  const size = () => parts.reduce((n, p) => n + p.lines.length, 0)
  const room = s?.card ? CARD_LINES : PAGE_LINES
  for (let rank = HINT; rank < QUESTION; rank++) {
    for (let i = parts.length - 1; i >= 0 && size() > room; i--) if (parts[i].rank === rank) parts.splice(i, 1)
  }
  return parts.flatMap(p => p.lines).join('\n')
}
