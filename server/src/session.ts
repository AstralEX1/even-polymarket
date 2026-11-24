import type { Account, Card, Config, Market, MarketView, Odds, SessionState, Venue } from './types.ts'
import { cashOutQuestion, equity, evaluate, holdingsOf, limitPrice, livePrice, makeCard, sellAction, swing, type Sample } from './rules.ts'
import { parseConfirm, parseIntent, pickSide } from './voice.ts'
import { dollars, money, pct, usd } from './format.ts'

export type Session = {
  tick(): Promise<void>
  state(): SessionState
  answer(cardId: string, yes: boolean): Promise<{ ok: boolean; message: string }>
  /** Queues the card a voice transcript asks for. Nothing runs until a YES. */
  voice(text: string, marketKey: string): Promise<{ ok: boolean; message: string }>
  /** A spoken "yes" or "no" to the card `cardId`; anything else leaves the card for scroll and tap. */
  confirm(text: string, cardId: string): Promise<{ ok: boolean; message: string }>
  /** Side names of a market, to help speech-to-text spell them */
  hint(marketKey: string): string
}

/** What must survive a restart, so restarting the server does not lift the lock or the cool-down. */
export interface DayState {
  day: number
  startEquity: number
  locked: boolean
  coolDownUntil: number
}

export interface DayStore {
  load(): DayState | null
  save(d: DayState): void
}

const TOAST_MS = 5_000
const DAY_MS = 86_400_000
const STALE_MS = 10_000

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const memoryStore = (): DayStore => { let d: DayState | null = null; return { load: () => d, save: x => { d = x } } }

export function createSession(venue: Venue, oddsSource: Odds, getConfig: () => Config, store: DayStore = memoryStore(), clock: () => number = Date.now): Session {
  let markets: Market[] = []
  let mids: Record<string, number> = {}
  let account: Account = { usdc: 0, holdings: [] }
  const live: Record<string, [number, number] | null> = {}
  const history: Record<string, Sample[]> = {}
  let fired = new Set<string>()
  let queue: Card[] = []
  let day: DayState | null = store.load()
  let toast: { text: string; until: number } | null = null
  let error: string | null = null
  let updatedAt = 0

  const say = (text: string) => { toast = { text, until: clock() + TOAST_MS } }
  const saveDay = () => { if (day) store.save(day) }
  const coolingDown = () => !!day && day.coolDownUntil > clock()
  const coolDown = () => { if (day) { day.coolDownUntil = clock() + getConfig().coolDownMin * 60_000; saveDay() } }
  const blocked = (): string | null =>
    day?.locked ? 'Locked: daily loss limit. Cash-outs only.'
      : coolingDown() ? `Cool-down: ${Math.ceil((day!.coolDownUntil - clock()) / 60_000)} min left` : null
  const dayPnl = () => (day ? equity(account, mids) - day.startEquity : 0)

  async function tick() {
    const cfg = getConfig()
    const now = clock()
    let next: Account
    let nextMids: Record<string, number>
    try {
      markets = await venue.markets(cfg.markets.map(m => m.key))
      nextMids = await venue.mids()
      next = await venue.account()
    } catch (e) {
      error = errorText(e) // keep the last good data, skip rules on a partial read
      return
    }
    // A holding that vanished settled (our own sells refresh `account` at once, so they are not seen here).
    // It lost when the USDC it paid out is below its cost; that starts the cool-down like a losing cash-out.
    // shortcut: USDC moved by anything else in the same 2 s (a trade on the web) blurs this; track settlements by outcome if that matters.
    const gone = account.holdings.filter(h => !next.holdings.some(x => x.token === h.token))
    if (gone.length && next.usdc - account.usdc < gone.reduce((sum, h) => sum + h.cost, 0) - 0.005) coolDown()
    // USDC that arrived while no holding changed is a transfer in (faucet, perps), not a win: it must not widen the loss limit.
    const unchanged = next.holdings.length === account.holdings.length &&
      next.holdings.every(x => account.holdings.some(h => h.token === x.token && h.shares === x.shares))
    if (day && updatedAt && unchanged && next.usdc > account.usdc + 0.005) { day.startEquity += next.usdc - account.usdc; saveDay() }
    account = next
    mids = nextMids

    // The user's own midnight, not UTC's: UTC midnight is 7 pm in New York, in the middle of a Sunday of games.
    // shortcut: the server's time zone stands for the user's, true while it runs on their own computer; send the phone's zone if it moves to a host.
    const today = Math.floor((now - new Date(now).getTimezoneOffset() * 60_000) / DAY_MS)
    if (!day || day.day !== today) {
      day = { day: today, startEquity: equity(account, mids), locked: false, coolDownUntil: day?.coolDownUntil ?? 0 }
      saveDay()
    }
    if (!day.locked && dayPnl() <= -cfg.dailyLossLimitUsd) {
      day.locked = true
      saveDay()
      say('Daily loss limit hit. Cash-outs only.')
    }
    updatedAt = now // freshness is Hyperliquid's: a YES needs these reads, Polymarket only adds context

    // All at once, so a hanging Polymarket costs one 5 s timeout per tick and Hyperliquid reads stay under 10 s old.
    const oddsErrors = await Promise.all(cfg.markets.map(async (w): Promise<string | null> => {
      const m = markets.find(x => x.key === w.key)
      if (!m || !w.polymarket) { delete live[w.key]; return null }
      try {
        live[m.key] = await oddsSource.prices(w.polymarket, m.sides)
        return live[m.key] ? null : `Polymarket: sides of ${w.polymarket} do not match ${m.title}`
      } catch (e) {
        return `Polymarket: ${errorText(e)}` // keep the last good price
      }
    }))
    for (const m of markets) {
      const p = livePrice({ mids, live }, m, 0)
      if (p === undefined) continue
      const h = (history[m.key] ??= [])
      h.push({ t: now, p })
      while (h.length && h[0].t < now - cfg.swingMin * 60_000) h.shift()
    }

    for (const c of queue) if (c.expiresAt <= now) fired.delete(c.key)
    const r = evaluate({ markets, mids, live, history, account, now }, cfg, fired)
    fired = r.fired
    // A card stays until it expires or is answered, so the choice under your finger is never reset.
    // Bets go when new bets are blocked; a sell goes when its holding is gone.
    const holds = (coin: string) => account.holdings.some(h => h.token === coin.replace(/^#/, '+'))
    queue = queue.filter(c => c.expiresAt > now && (c.action.type === 'buy' ? !blocked() : holds(c.action.coin)))
    for (const c of r.cards) if (!queue.some(q => q.key === c.key)) queue.push(c)
    for (const t of r.toasts) say(t)
    error = oddsErrors.find(Boolean) ?? null
  }

  async function answer(cardId: string, yes: boolean) {
    const card = queue[0]
    if (!card || card.id !== cardId) return { ok: false, message: 'Card is gone' }
    queue.shift() // before any await, so a second tap on the same card gets "Card is gone"
    if (card.expiresAt <= clock()) {
      fired.delete(card.key)
      return { ok: false, message: 'Card expired' }
    }
    if (!yes) return { ok: true, message: 'Skipped' }
    const refuse = (message: string) => { say(message); return { ok: false, message } }
    const cfg = getConfig()
    const a = card.action
    if (!updatedAt || clock() - updatedAt > STALE_MS) return refuse('Data is stale. Not sent.')
    const buy = a.type === 'buy'
    if (buy) {
      const why = blocked()
      if (why) return refuse(why)
    }
    // The limit caps the fill at the card price ± slippage, so a thin book never fills far from what you saw.
    const limit = limitPrice(a.type, a.price, cfg.slippagePts)
    // The cap holds at the worst price the order can fill at, not at the price on the card.
    if (buy && a.shares * limit > cfg.maxBetUsd + 1e-9) return refuse(`Over your ${usd(cfg.maxBetUsd)} cap`)
    // Taken before any await: a tick that lands between the fill and the reply must not lose the cost basis.
    const held = account.holdings.find(x => x.token === a.coin.replace(/^#/, '+'))
    let filled
    try {
      const best = await venue.best(a.coin, buy ? 'Buy' : 'Sell')
      if (best === null) return refuse(buy ? `No sellers for ${a.sideName}` : `No buyers for ${a.sideName}`)
      if (buy ? best > limit + 1e-9 : best < limit - 1e-9) return refuse(`Price moved to ${pct(best)}. Not sent.`)
      filled = await venue.order(a.asset, buy ? 'Buy' : 'Sell', a.shares, limit)
    } catch (e) {
      // A write that timed out or lost its reply may still have reached the exchange: never say "failed" then.
      const unknown = ['TimeoutError', 'UnknownResult'].includes((e as Error).name)
      return refuse(unknown ? `Unknown result: ${errorText(e)}. Check Hyperliquid before betting again.` : `Failed: ${errorText(e)}`)
    }
    let message = `${buy ? 'Bought' : 'Sold'} ${filled.shares} ${a.sideName} for ${dollars(filled.shares * filled.avgPrice)}`
    if (!buy && held && held.shares > 0) {
      const pnl = filled.shares * filled.avgPrice - (held.cost * filled.shares) / held.shares
      message += ` (${money(pnl)})`
      if (pnl < 0) coolDown()
    }
    try {
      account = await venue.account() // the new balance shows now, and the tick does not take this sell for a settlement
    } catch { /* the next tick catches up */ }
    say(message)
    return { ok: true, message }
  }

  async function voice(text: string, marketKey: string) {
    const done = (ok: boolean, message: string) => { say(message); return { ok, message } }
    const m = markets.find(x => x.key === marketKey)
    if (!m) return done(false, 'That market is gone. Scroll to another.') // never bet on a market you are not looking at
    const intent = parseIntent(text)
    if (!intent) return done(false, text.trim() ? `Say it like "20 on ${m.sides[0].name}"` : 'Heard nothing')
    const now = clock()

    if (intent.kind === 'cashout') {
      const held = holdingsOf(m, account)
      if (!held.length) return done(false, `Nothing to cash out in ${m.title}`)
      for (const { i, h } of held) {
        const bid = await venue.best(m.sides[i].coin, 'Sell').catch(() => null)
        if (bid === null) { say(`No buyers for ${m.sides[i].name}`); continue }
        const side = m.sides[i]
        const card = makeCard(now, `voice:cashout:${side.token}`, `${m.title}: you asked to cash out`,
          cashOutQuestion(h.shares, side.name, bid, h.cost), sellAction(m, i, h.shares, bid))
        queue = [card, ...queue.filter(q => q.key !== card.key)] // the card you asked for comes first
      }
      return done(true, `Heard "${text.trim()}"`)
    }

    const why = blocked()
    if (why) return done(false, why)
    const i = pickSide(m, intent.side)
    if (i === null) return done(false, `Say a side: ${m.sides[0].name} or ${m.sides[1].name}`)
    const cfg = getConfig()
    const amount = intent.usd ?? cfg.defaultBetUsd
    if (amount > cfg.maxBetUsd) return done(false, `${usd(amount)} is over your ${usd(cfg.maxBetUsd)} cap`)
    const side = m.sides[i]
    let ask: number | null
    try {
      ask = await venue.best(side.coin, 'Buy')
    } catch (e) {
      return done(false, `Failed: ${errorText(e)}`)
    }
    if (ask === null) return done(false, `No sellers for ${side.name}`)
    const shares = Math.floor(amount / limitPrice('buy', ask, cfg.slippagePts)) // the stake holds even at the worst fill
    if (shares < 1) return done(false, `${usd(amount)} buys no ${side.name} at ${pct(ask)}`)
    const lp = livePrice({ mids, live }, m, i)
    const card = makeCard(now, `voice:bet:${side.coin}`, `${m.title}: ${side.name} now ${lp === undefined ? '-' : pct(lp)}`,
      `Buy ${shares} ${side.name} for ${dollars(shares * ask)}? Pays ${usd(shares)} if ${side.name} wins`,
      { type: 'buy', market: m.key, sideIndex: i, sideName: side.name, coin: side.coin, asset: side.asset, shares, price: ask })
    queue = [card, ...queue.filter(q => q.key !== card.key)] // first, and it replaces an older bet card on the same side
    return done(true, `Heard "${text.trim()}"`)
  }

  async function confirm(text: string, cardId: string) {
    const yes = parseConfirm(text)
    // Only a whole "yes" or "no" counts: "yes, but wait" or a word from the TV leaves the card as it is.
    const r = yes === null
      ? { ok: false, message: `${text.trim() ? `Heard "${text.trim()}"` : 'Heard nothing'}. Scroll and tap instead.` }
      : await answer(cardId, yes) // the same checks as a YES tap: card id, expiry, stale data, limits, price
    say(r.message)
    return r
  }

  function view(m: Market): MarketView {
    const change0 = swing(history[m.key])
    return {
      key: m.key,
      title: m.title,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      sides: [0, 1].map(i => ({
        name: m.sides[i].name,
        hl: mids[m.sides[i].coin] ?? null,
        pm: live[m.key]?.[i] ?? null,
        change: change0 === null ? null : Math.round((i === 0 ? change0 : -change0) * 100),
      })) as MarketView['sides'],
      holdings: holdingsOf(m, account).map(({ i, h }) => ({
        sideIndex: i, shares: h.shares, cost: h.cost, value: h.shares * (mids[m.sides[i].coin] ?? 0),
      })),
    }
  }

  function state(): SessionState {
    const cfg = getConfig()
    const age = updatedAt ? clock() - updatedAt : 0
    return {
      markets: markets.map(view),
      usdc: account.usdc,
      dayPnl: dayPnl(),
      dailyLossLimitUsd: cfg.dailyLossLimitUsd,
      locked: day?.locked ?? false,
      coolDownUntil: coolingDown() ? day!.coolDownUntil : 0,
      card: queue[0] ?? null,
      pending: queue.length,
      toast: toast && toast.until > clock() ? toast.text : null,
      error: age > STALE_MS ? `No fresh data for ${Math.round(age / 1000)}s` : error,
      updatedAt,
    }
  }

  const hint = (key: string) => {
    const m = markets.find(x => x.key === key) ?? markets[0]
    return m ? m.sides.flatMap(s => [s.name, s.fullName]).join(', ') : ''
  }

  return { tick, state, answer, voice, confirm, hint }
}
