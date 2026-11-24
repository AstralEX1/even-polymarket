import type { MarketView, SessionState, SideView } from '../../server/src/types.ts'
import { money, pct, usd } from '../../server/src/format.ts'

const WIDTH = 46

/** Characters the glasses font lacks (curly quotes, ellipsis, emoji in a heard phrase or a market title) become plain ones or go. */
const plain = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff←↑→↓─]/g, '')

/** Long lines wrap at a space instead of losing their end (a price, a payout). */
export function wrap(s: string): string[] {
  const out: string[] = []
  let line = ''
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= WIDTH) { line = next; continue }
    if (line) out.push(line)
    line = word
    while (line.length > WIDTH) { out.push(line.slice(0, WIDTH)); line = line.slice(WIDTH) }
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

/** Hyperliquid, where the order goes, is shown only when it is this far off the live odds. */
const GAP = 0.03

function sideLine(s: SideView): string {
  const live = s.pm ?? s.hl
  if (live === null) return `${s.name}  -`
  const change = s.change ? `  ${s.change > 0 ? '↑' : '↓'}${Math.abs(s.change)}` : ''
  const hl = s.pm !== null && s.hl !== null && Math.abs(s.pm - s.hl) >= GAP ? `  · HL ${pct(s.hl)}` : ''
  return `${s.name}  ${pct(live)}${change}${hl}`
}

function when(m: MarketView, now: number): string {
  if (m.startsAt > now) return ` · starts in ${timeLeft(m.startsAt - now)}`
  if (m.startsAt) return '' // a game on: its resolution deadline says nothing useful
  return m.endsAt ? ` · ends in ${timeLeft(m.endsAt - now)}` : ''
}

function marketLines(m: MarketView, at: number, of: number, now: number): string[] {
  const out = [`${m.title}${when(m, now)}${of > 1 ? ` · ${at + 1}/${of}` : ''}`]
  out.push(...m.sides.map(sideLine))
  for (const h of m.holdings) {
    const name = m.sides[h.sideIndex].name
    out.push(`You: ${h.shares} ${name}  ${money(h.value - h.cost)} · pays ${usd(h.shares)} if ${name} wins`)
  }
  return out
}

// One glance: the market you watch, your bet in money, today against the limit. No balance, no LIVE label.
function body(s: SessionState, focus: number, now: number): string[] {
  const out: string[] = []
  if (s.error) out.push(`! ${s.error}`) // on top, and only when something is wrong
  if (s.card) {
    // The decision in money first, then why it is up. NO / YES is the list under this text.
    out.push(s.card.question, s.card.title)
    if (s.pending > 1) out.push(`+${s.pending - 1} more`)
  } else {
    const m = s.markets[focus]
    if (!m) out.push('No markets. Add one on the phone page.')
    else out.push(...marketLines(m, focus, s.markets.length, now))
    out.push(`Today ${money(s.dayPnl)} of ${usd(s.dailyLossLimitUsd)} limit`)
    if (s.locked) out.push('LOCKED: daily loss limit. Cash-outs only.')
    else if (s.coolDownUntil > now) out.push(`COOL-DOWN ${Math.ceil((s.coolDownUntil - now) / 60_000)} min: cash-outs only`)
    else if (m) out.push(`tap: speak${s.markets.length > 1 ? ' · scroll: next' : ''}`)
  }
  if (s.toast) out.push(s.toast)
  return out
}

/** The text part of the glasses screen. Pure, so it is tested without the SDK. A card's NO / YES is a list beside it. */
export function renderScreen(s: SessionState | null, focus: number, offline: boolean, voice = '', now = Date.now()): string {
  const out = offline ? ['Server offline. Retrying...'] : []
  if (s) out.push(...body(s, focus, now))
  else if (!offline) out.push('Connecting...')
  if (voice) out.push(voice)
  return out.flatMap(l => wrap(plain(l))).join('\n')
}
