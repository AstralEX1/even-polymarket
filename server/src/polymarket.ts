import type { Odds, OutcomeSide } from './types.ts'

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'
const TIMEOUT_MS = 5000
const RESOLVE_TTL_MS = 10 * 60_000
const FAIL_TTL_MS = 60_000

type GammaMarket = { outcomes?: unknown; clobTokenIds?: unknown; closed?: boolean; sportsMarketType?: string }
type Candidate = { outcomes: string[]; tokens: string[]; moneyline: boolean }

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')
/** `part` appears in `whole` as whole words: 'Chiefs' in 'Kansas City Chiefs', but not 'Rams' in 'Ramsey'. */
const within = (whole: string, part: string) => words(part) !== '' && ` ${words(whole)} `.includes(` ${words(part)} `)
// Equality with name or fullName is the special case of containment, so two checks cover all four rules.
const matches = (outcome: string, side: OutcomeSide) => within(side.fullName, outcome) || within(outcome, side.name)

/** Polymarket outcome index of each Hyperliquid side, or null when a side matches no outcome, several, or the same one as the other side. */
export function matchSides(outcomes: string[], sides: [OutcomeSide, OutcomeSide]): [number, number] | null {
  const pick = (side: OutcomeSide) => {
    const hits = outcomes.flatMap((o, i) => (matches(o, side) ? [i] : []))
    return hits.length === 1 ? hits[0] : -1
  }
  const a = pick(sides[0])
  const b = pick(sides[1])
  return a >= 0 && b >= 0 && a !== b ? [a, b] : null
}

/** Gamma sends `outcomes` and `clobTokenIds` as JSON-encoded strings. */
const list = (v: unknown): string[] => {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}

export function createPolymarket(o: { fetch?: typeof fetch; clock?: () => number } = {}): Odds {
  const doFetch = o.fetch ?? fetch
  const clock = o.clock ?? Date.now
  const resolved = new Map<string, { until: number; markets: Promise<Candidate[]> }>()

  async function get<T>(base: string, path: string): Promise<T> {
    const where = path.split('?')[0]
    let res: Response
    try {
      res = await doFetch(base + path, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new Error(`Polymarket unreachable (${where}): ${(e as Error).message}`)
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(`Polymarket HTTP ${res.status} ${where}${body.error ? `: ${body.error}` : ''}`)
    }
    return (await res.json()) as T
  }

  async function lookup(slug: string): Promise<Candidate[]> {
    const q = encodeURIComponent(slug)
    // A game's moneyline market has the event's slug, so the first request usually answers it.
    let raw = await get<GammaMarket[]>(GAMMA, `/markets?slug=${q}`)
    if (!raw.length) raw = (await get<{ markets?: GammaMarket[] }[]>(GAMMA, `/events?slug=${q}`)).flatMap(e => e.markets ?? [])
    // `clobTokenIds`, not `positionIds`: /midpoint answers 404 for positionIds (checked 22.11, all open markets are version v1).
    const markets = raw
      .filter(m => !m.closed)
      .map(m => ({ outcomes: list(m.outcomes), tokens: list(m.clobTokenIds), moneyline: m.sportsMarketType === 'moneyline' }))
      .filter(m => m.outcomes.length === 2 && m.tokens.length === 2)
    if (!markets.length) throw new Error(`Polymarket: no open market "${slug}"`)
    return markets
  }

  function resolve(slug: string): Promise<Candidate[]> {
    const hit = resolved.get(slug)
    if (hit && clock() < hit.until) return hit.markets
    const entry = { until: clock() + RESOLVE_TTL_MS, markets: lookup(slug) }
    entry.markets.catch(() => (entry.until = clock() + FAIL_TTL_MS))
    resolved.set(slug, entry)
    return entry.markets
  }

  return {
    async prices(slug, sides) {
      const hits = (await resolve(slug)).flatMap(m => {
        const idx = matchSides(m.outcomes, sides)
        return idx ? [{ ...m, idx }] : []
      })
      // An event lists spreads with the same team outcomes: take the one full-game moneyline, else only an unambiguous match.
      // A soccer event has three Yes/No moneylines (home, draw, away), so a Yes/No side never guesses among them.
      const lines = hits.filter(h => h.moneyline)
      const pick = lines.length ? lines : hits
      const m = pick.length === 1 ? pick[0] : undefined
      if (!m) return null
      const { mid } = await get<{ mid?: string }>(CLOB, `/midpoint?token_id=${m.tokens[m.idx[0]]}`)
      const p = Number(mid)
      if (!(p >= 0 && p <= 1)) throw new Error(`Polymarket bad midpoint ${mid}`)
      // The two tokens of a binary market have mirrored books, so one request prices both sides.
      return [p, 1 - p]
    },
  }
}
