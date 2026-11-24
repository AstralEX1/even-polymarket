import { randomBytes } from 'node:crypto'
import { signL1 } from './sign.ts'
import type { Account, Filled, Market, OutcomeSide, Side, Venue } from './types.ts'

const TESTNET_HOST = 'api.hyperliquid-testnet.xyz'
const READ_TIMEOUT_MS = 8000
const ORDER_TIMEOUT_MS = 10_000
const META_TTL_MS = 60_000
// shortcut: covers our clock running ahead of the exchange's by up to 2 s; an unsynced clock needs more.
const EXPIRY_MARGIN_MS = 2000

/** Money safety: testnet only, so any other host stops the server. */
export function assertTestnet(base: string): void {
  const url = new URL(base)
  if (url.protocol !== 'https:' || url.hostname !== TESTNET_HOST) throw new Error(`Refusing non-testnet Hyperliquid host ${url.host}`)
}

type Outcome = { outcome: number; name: string; description: string; sideSpecs: { name: string }[] }
type Level = { px: string; sz: string }
type Status = { filled?: { totalSz: string; avgPx: string }; error?: string }
type ExchangeReply = { status: string; response: { data?: { statuses?: Status[] } } | string }
type OrderStatus = { status: 'unknownOid' } | { status: 'order'; order: { order: { oid: number } } }
/** A userFills entry. A settlement is one too: dir 'Settlement', px 1.0 (won) or 0.0 (lost), closedPnl = payout - cost. */
type Fill = { coin: string; oid: number; px: string; sz: string; dir: string; time: number; closedPnl: string }

/** 'class:priceBinary|underlying:BTC' → fields; plain-text descriptions have none. */
function fields(description: string): Record<string, string> {
  const parts = description.split('|')
  if (!parts.every(p => /^\w+:/.test(p))) return {}
  return Object.fromEntries(parts.map(p => [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)]))
}

/** '20261123-0300' (UTC) → ms; 0 when absent. */
function toMs(t: string | undefined): number {
  const m = t?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : 0
}

const num = (v: string) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 })

function toMarket(key: string, o: Outcome): Market {
  const f = fields(o.description)
  const sides = o.sideSpecs.map((spec, i): OutcomeSide => {
    const name = spec.name.replace(/^template:/, '').replace(/\{(\w+)\}/g, (m, k: string) => f[k] ?? m)
    // Yes / No sides of a participant contest are not the participants, so only placeholders map to them.
    const fullName = spec.name.includes('{') ? [f.participantA, f.participantB][i] ?? name : name
    const encoding = 10 * o.outcome + i
    return { name, fullName, coin: `#${encoding}`, token: `+${encoding}`, asset: 100_000_000 + encoding }
  }) as [OutcomeSide, OutcomeSide]
  let title: string
  if (f.participantA && f.participantB) title = `${f.shortNameA ?? f.participantA} vs ${f.shortNameB ?? f.participantB}`
  else if (f.class === 'priceBinary') title = `${f.underlying} >= ${num(f.targetPrice)}`
  else if (f.perp && f.threshold) title = `${f.perp} >= ${num(f.threshold)}`
  else if (f.perp && f.target) title = `${f.perp} touches ${num(f.target)}`
  else if (f.participant) title = f.participant
  else if (!/^(template|Recurring)/.test(o.name)) title = o.name
  else title = o.description.slice(0, 40) || String(o.outcome)
  return { key, outcome: o.outcome, title, sides, startsAt: toMs(f.scheduledStart), endsAt: toMs(f.expiry ?? f.resolutionDeadline ?? f.time) }
}

/** Outcome limits: whole shares, prices in 0..1. */
function priceWire(price: number, side: Side): string {
  // 4 decimals keeps any price below 1 within the 5 significant figures the API allows;
  // rounding toward the far side keeps a limit at the best price (0.51999) marketable.
  const round = side === 'Buy' ? Math.ceil : Math.floor
  const steps = round(Number((price * 1e4).toFixed(6))) // toFixed drops float noise like 5200.000000000001
  return (steps / 1e4).toFixed(4).replace(/\.?0+$/, '')
}

export function createHyperliquid(o: {
  base: string; account: string; agentKey: string
  fetch?: typeof fetch; clock?: () => number; sleep?: (ms: number) => Promise<void>; cloid?: () => string
}): Venue {
  assertTestnet(o.base)
  const doFetch = o.fetch ?? fetch
  const clock = o.clock ?? Date.now
  const sleep = o.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const newCloid = o.cloid ?? (() => `0x${randomBytes(16).toString('hex')}`)
  let meta: { at: number; outcomes: Outcome[] } | null = null
  let lastNonce = 0

  async function post<T>(path: string, body: unknown, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    const res = await doFetch(new URL(path, o.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
    return (await res.json()) as T
  }
  const info = <T>(body: Record<string, unknown>) => post<T>('/info', body)

  /**
   * The reply to an order was lost. Once its expiresAfter has passed the exchange can no longer take it,
   * so the order book has the final answer: never placed, placed without a fill, or filled (summed from the fills).
   */
  async function settle(cloid: string, expiresAfter: number, lost: Error): Promise<Filled> {
    await sleep(Math.max(0, expiresAfter + EXPIRY_MARGIN_MS - clock()))
    let found: OrderStatus
    let fills: Fill[]
    try {
      found = await info<OrderStatus>({ type: 'orderStatus', user: o.account, oid: cloid })
      fills = found.status === 'order' ? await info<Fill[]>({ type: 'userFills', user: o.account }) : []
    } catch {
      lost.name = 'UnknownResult' // the book could not be asked either: still unknown
      throw lost
    }
    if (found.status !== 'order') throw new Error(`No reply (${lost.message}) and the order never reached Hyperliquid`)
    const mine = fills.filter(f => f.oid === found.order.order.oid)
    const shares = mine.reduce((n, f) => n + Number(f.sz), 0)
    if (!shares) throw new Error(`No reply (${lost.message}); the order reached Hyperliquid and did not fill`)
    return { shares, avgPrice: mine.reduce((n, f) => n + Number(f.px) * Number(f.sz), 0) / shares }
  }

  async function outcomes(): Promise<Outcome[]> {
    if (!meta || clock() - meta.at > META_TTL_MS) {
      const res = await info<{ outcomes: Outcome[] }>({ type: 'outcomeMeta' })
      meta = { at: clock(), outcomes: res.outcomes }
    }
    return meta.outcomes
  }

  return {
    async markets(keys) {
      const all = await outcomes()
      const now = clock()
      const resolve = (key: string): Outcome | undefined => {
        if (/^\d+$/.test(key)) return all.find(x => x.outcome === Number(key))
        const coin = key.match(/^daily:(\w+)$/)?.[1]
        if (!coin) return undefined
        return all
          .map(x => ({ x, f: fields(x.description) }))
          .filter(({ f }) => f.class === 'priceBinary' && f.underlying === coin && f.period === '1d' && toMs(f.expiry) > now)
          .sort((a, b) => toMs(a.f.expiry) - toMs(b.f.expiry))[0]?.x
      }
      return keys.flatMap(key => {
        const found = resolve(key)
        if (!found || found.sideSpecs.length !== 2) return []
        const market = toMarket(key, found)
        return market.endsAt && market.endsAt <= now ? [] : [market]
      })
    },

    async mids() {
      const all = await info<Record<string, string>>({ type: 'allMids' })
      return Object.fromEntries(Object.entries(all).filter(([coin]) => coin.startsWith('#')).map(([coin, px]) => [coin, Number(px)]))
    },

    async account(): Promise<Account> {
      const { balances } = await info<{ balances: { coin: string; total: string; entryNtl: string }[] }>({ type: 'spotClearinghouseState', user: o.account })
      return {
        usdc: Number(balances.find(b => b.coin === 'USDC')?.total ?? 0),
        holdings: balances
          .filter(b => b.coin.startsWith('+') && Number(b.total) > 0)
          .map(b => ({ token: b.coin, shares: Number(b.total), cost: Number(b.entryNtl) })),
      }
    },

    async settlements(since) {
      const fills = await info<Fill[]>({ type: 'userFills', user: o.account })
      const out: Record<string, number> = {}
      for (const f of fills) {
        if (f.dir !== 'Settlement' || f.time < since || !f.coin.startsWith('#')) continue
        const token = `+${f.coin.slice(1)}`
        out[token] = (out[token] ?? 0) + Number(f.closedPnl)
      }
      return out
    },

    async best(coin, side) {
      const { levels } = await info<{ levels: [Level[], Level[]] }>({ type: 'l2Book', coin })
      const top = side === 'Buy' ? levels[1][0] : levels[0][0]
      return top ? Number(top.px) : null
    },

    async order(asset, side, shares, limitPrice): Promise<Filled> {
      if (!Number.isInteger(shares) || shares <= 0) throw new Error(`Shares must be a positive whole number, got ${shares}`)
      if (!(limitPrice > 0)) throw new Error(`Bad limit price ${limitPrice}`)
      // The client order id (cloid) finds this order again if its reply is lost. Key order matters: it is hashed.
      const cloid = newCloid()
      const action = {
        type: 'order',
        orders: [{ a: asset, b: side === 'Buy', p: priceWire(limitPrice, side), s: String(shares), r: false, t: { limit: { tif: 'Ioc' } }, c: cloid }],
        grouping: 'na',
      }
      const nonce = lastNonce = Math.max(clock(), lastNonce + 1) // two orders in one millisecond must not share a nonce
      // The exchange drops the action after this, so a request stuck in transit cannot fill once we have given up on it.
      const expiresAfter = nonce + ORDER_TIMEOUT_MS
      const signature = signL1(o.agentKey, action, nonce, false, null, expiresAfter)
      let reply: ExchangeReply
      try {
        reply = await post<ExchangeReply>('/exchange', { action, nonce, signature, vaultAddress: null, expiresAfter }, ORDER_TIMEOUT_MS)
      } catch (e) {
        // A dropped connection, a timeout or a 5xx may come after the order reached the book; only a 4xx is a sure refusal.
        if (/^Hyperliquid HTTP 4\d\d/.test((e as Error).message)) throw e
        return settle(cloid, expiresAfter, e as Error)
      }
      if (reply.status !== 'ok' || typeof reply.response === 'string') throw new Error(String(reply.response))
      const status = reply.response.data?.statuses?.[0]
      if (status?.filled) return { shares: Number(status.filled.totalSz), avgPrice: Number(status.filled.avgPx) }
      throw new Error(status?.error ?? `Order not filled: ${JSON.stringify(status)}`)
    },
  }
}
