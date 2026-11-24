import type { WatchedMarket } from '../../server/src/types.ts'

export const marketLine = (m: WatchedMarket) => (m.polymarket ? `${m.key} ${m.polymarket}` : m.key)

/** "27159 nfl-kc-buf-2026-11-27" → WatchedMarket. A Polymarket URL works too. Throws naming the bad line; the server checks the rest. */
export function parseMarkets(text: string): WatchedMarket[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(\d+|daily:[a-z0-9]+)(?:\s+(\S+))?$/i)
    if (!m) throw new Error(`Cannot read market "${line}". Example: 27159 nfl-kc-buf-2026-11-27`)
    const key = /^daily:/i.test(m[1]) ? `daily:${m[1].slice(6).toUpperCase()}` : m[1]
    const slug = m[2]?.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()?.toLowerCase()
    return slug ? { key, polymarket: slug } : { key }
  })
}
