// Polymarket's market websocket: the best bid and ask of each watched token, pushed as they change.
// In a game the odds move many times a second; polling /midpoint every 2 s saw them late.

const URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const PING_MS = 10_000 // the server drops a socket that sends nothing for longer
const FIRST_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000

/** What the feed needs of a WebSocket; Node's global WebSocket has it. */
export interface Socket {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: unknown) => void) | null
  onerror: ((e: unknown) => void) | null
}

export interface Feed {
  /** Midpoint of the token's book, or undefined when the socket has no book for it (closed, not yet sent): ask REST then. */
  mid(token: string): number | undefined
  /** Starts streaming these tokens too. Adding one reconnects with the whole list. */
  watch(tokens: string[]): void
  /** Called on every book change and when the socket drops. */
  onChange(listener: () => void): void
  close(): void
}

type Level = { price: string }
type Message = {
  event_type?: string
  asset_id?: string
  bids?: Level[]
  asks?: Level[]
  price_changes?: { asset_id: string; best_bid?: string; best_ask?: string }[]
  best_bid?: string
  best_ask?: string
}

const prices = (levels: Level[] | undefined) => (levels ?? []).map(l => Number(l.price)).filter(Number.isFinite)

export function polymarketFeed(o: { socket?: (url: string) => Socket } = {}): Feed {
  const open = o.socket ?? (url => new WebSocket(url) as unknown as Socket)
  const books = new Map<string, { bid: number; ask: number }>()
  const tokens = new Set<string>()
  const listeners: (() => void)[] = []
  let ws: Socket | null = null
  let ping: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let wait = FIRST_RETRY_MS
  let closed = false

  const changed = () => { for (const l of listeners) l() }

  /** A side the message leaves out keeps its last value; a book without a side has no midpoint. */
  function set(token: string | undefined, bid: number, ask: number) {
    if (!token || !tokens.has(token)) return
    if (!(bid > 0 && ask > 0 && bid <= ask && ask <= 1)) { books.delete(token); return }
    books.set(token, { bid, ask })
  }

  function apply(text: string) {
    let parsed: Message | Message[]
    try { parsed = JSON.parse(text) } catch { return } // "PONG"
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      // A snapshot: bids come ascending and asks descending today, so take the extremes rather than trust the order.
      if (m.event_type === 'book') set(m.asset_id, Math.max(...prices(m.bids)), Math.min(...prices(m.asks)))
      else if (m.event_type === 'price_change') for (const c of m.price_changes ?? []) set(c.asset_id, Number(c.best_bid), Number(c.best_ask))
      else if (m.event_type === 'best_bid_ask') set(m.asset_id, Number(m.best_bid), Number(m.best_ask))
      else continue
      changed()
    }
  }

  function connect() {
    retry = undefined
    if (closed || !tokens.size) return
    const s = ws = open(URL)
    s.onopen = () => {
      wait = FIRST_RETRY_MS
      s.send(JSON.stringify({ assets_ids: [...tokens], type: 'market' }))
      ping = setInterval(() => s.send('PING'), PING_MS)
    }
    s.onmessage = e => { if (ws === s) apply(String(e.data)) }
    s.onerror = () => s.close()
    s.onclose = () => {
      if (ws !== s) return
      clearInterval(ping)
      ws = null
      books.clear() // nothing is live until the next snapshot: callers fall back to REST meanwhile
      changed()
      if (!closed) retry = setTimeout(connect, wait)
      wait = Math.min(wait * 2, MAX_RETRY_MS)
    }
  }

  return {
    mid(token) {
      const b = books.get(token)
      return b && (b.bid + b.ask) / 2
    },
    watch(list) {
      const fresh = list.filter(t => !tokens.has(t))
      if (!fresh.length) return
      for (const t of fresh) tokens.add(t)
      wait = FIRST_RETRY_MS
      if (ws) ws.close() // onclose reconnects with every token
      else if (!retry) connect()
    },
    onChange(listener) { listeners.push(listener) },
    close() {
      closed = true
      clearTimeout(retry)
      clearInterval(ping)
      ws?.close()
    },
  }
}
