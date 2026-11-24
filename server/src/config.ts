import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config, WatchedMarket } from './types.ts'
import type { DayState, DayStore } from './session.ts'
import { DEFAULT_CONFIG, NUMBER_FIELDS } from './rules.ts'

const MAX_MARKETS = 10
export const RAISE_DELAY_MS = 86_400_000

const positive = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${field} must be a positive number`)
  return v
}

function market(v: unknown, i: number): WatchedMarket {
  const m = (v ?? {}) as Record<string, unknown>
  const at = `markets[${i}]`
  if (typeof m.key !== 'string' || !/^(\d{1,9}|daily:[A-Z0-9]{2,10})$/.test(m.key)) throw new Error(`${at}.key must be an outcome id like 27159 or daily:BTC`)
  const out: WatchedMarket = { key: m.key }
  if (m.polymarket !== undefined) {
    if (typeof m.polymarket !== 'string' || !/^[a-z0-9-]{3,200}$/.test(m.polymarket)) throw new Error(`${at}.polymarket must be a slug like nfl-kc-buf-2026-11-27`)
    out.polymarket = m.polymarket
  }
  return out
}

/** Trust boundary: the phone page sends this. Returns a clean copy with known fields only. */
export function validateConfig(input: unknown): Config {
  if (!input || typeof input !== 'object') throw new Error('config must be an object')
  const c = input as Record<string, unknown>
  const markets = c.markets ?? []
  if (!Array.isArray(markets) || markets.length > MAX_MARKETS) throw new Error(`markets must be a list of up to ${MAX_MARKETS}`)
  const out = { markets: markets.map(market) } as Config
  for (const field of NUMBER_FIELDS) out[field] = positive(c[field], field)
  if (new Set(out.markets.map(m => m.key)).size !== out.markets.length) throw new Error('each market once')
  if (out.defaultBetUsd > out.maxBetUsd) throw new Error('defaultBetUsd must not be above maxBetUsd')
  if (out.cashOutAt >= 100) throw new Error('cashOutAt must be below 100 cents')
  if (out.swingPts >= 100) throw new Error('swingPts must be below 100 cents')
  if (out.slippagePts > 20) throw new Error('slippagePts must be 20 cents or less')
  return out
}

/** A config with looser limits, waiting until `at`. */
export type Pending = { config: Config; at: number } | null

/**
 * Lowering a limit counts at once, raising one waits a day, so the phone page cannot lift a limit in the middle of a chase.
 * A new save replaces a waiting raise and starts its day again.
 */
export function applyLimits(cur: Config, next: Config, now: number): { config: Config; pending: Pending } {
  const maxBetUsd = Math.min(next.maxBetUsd, cur.maxBetUsd)
  const kept = {
    maxBetUsd,
    defaultBetUsd: Math.min(next.defaultBetUsd, maxBetUsd),
    dailyLossLimitUsd: Math.min(next.dailyLossLimitUsd, cur.dailyLossLimitUsd),
    coolDownMin: Math.max(next.coolDownMin, cur.coolDownMin),
  }
  const raised = kept.maxBetUsd !== next.maxBetUsd || kept.dailyLossLimitUsd !== next.dailyLossLimitUsd || kept.coolDownMin !== next.coolDownMin
  return raised ? { config: { ...next, ...kept }, pending: { config: next, at: now + RAISE_DELAY_MS } } : { config: next, pending: null }
}

const LOOPBACK = ['127.0.0.1', 'localhost', '::1']

/** The API token guards betting. Off loopback it must be long enough not to guess. */
export function tokenProblem(token: string, host: string): string | null {
  if (!token) return 'Set APP_TOKEN in .env (see .env.example).'
  if (!LOOPBACK.includes(host) && token.length < 16) return 'APP_TOKEN must be at least 16 characters when HOST is not loopback.'
  return null
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  // Write then rename: a crash mid-write must not leave a broken file, since deleting day.json lifts the lock.
  writeFileSync(`${path}.tmp`, JSON.stringify(v, null, 2))
  renameSync(`${path}.tmp`, path)
}

export function loadConfig(path: string): Config {
  const raw = readJson(path)
  return raw ? validateConfig({ ...DEFAULT_CONFIG, ...(raw as object) }) : structuredClone(DEFAULT_CONFIG)
}

export const saveConfig = (path: string, c: Config) => writeJson(path, c)

export function loadPending(path: string): Pending {
  const raw = readJson(path) as { config?: unknown; at?: unknown } | null
  return raw && typeof raw.at === 'number' ? { config: validateConfig(raw.config), at: raw.at } : null
}

export const savePending = (path: string, p: Pending) => writeJson(path, p)

/** The day's lock, cool-down and starting equity in a file. */
export function fileDayStore(path: string): DayStore {
  return {
    load: () => readJson(path) as DayState | null,
    save: d => writeJson(path, d),
  }
}
