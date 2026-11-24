import { fileURLToPath } from 'node:url'
import type { Config, Odds, ShownConfig, Venue } from './types.ts'
import { createSession } from './session.ts'
import { createServer } from './http.ts'
import { applyLimits, fileDayStore, loadConfig, loadPending, saveConfig, savePending, tokenProblem } from './config.ts'
import { assertTestnet, createHyperliquid } from './hyperliquid.ts'
import { createPolymarket } from './polymarket.ts'
import { polymarketFeed, type Feed } from './feed.ts'
import { demo } from './fake.ts'
import { transcribe } from './stt.ts'

const TICK_MS = 2000
/** Odds that move start a tick at once, but no more often than this: Hyperliquid's read limit is per IP. */
const KICK_MS = 500
const env = process.env

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const token = env.APP_TOKEN ?? ''
const port = Number(env.PORT) || 8788
const host = env.HOST || '127.0.0.1'
const problem = tokenProblem(token, host, env.PUBLIC_URL)
if (problem) fail(problem)

const dataDir = new URL('../data/', import.meta.url)
let venue: Venue
let odds: Odds
let feed: Feed | undefined
const mode = env.VENUE === 'hyperliquid' ? 'hyperliquid' : 'fake'
if (mode === 'hyperliquid') {
  const base = env.HL_BASE || 'https://api.hyperliquid-testnet.xyz'
  try {
    assertTestnet(base)
  } catch (e) {
    fail((e as Error).message)
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.HL_ACCOUNT ?? '')) fail('Set HL_ACCOUNT to your Hyperliquid testnet address (0x...).')
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.HL_AGENT_KEY ?? '')) fail('Set HL_AGENT_KEY to the API wallet private key from app.hyperliquid-testnet.xyz/API.')
  venue = createHyperliquid({ base, account: env.HL_ACCOUNT!, agentKey: env.HL_AGENT_KEY! })
  feed = polymarketFeed()
  odds = createPolymarket({ feed })
} else {
  ({ venue, odds } = demo(Date.now()))
}

const configFile = fileURLToPath(new URL('config.json', dataDir))
const pendingFile = fileURLToPath(new URL('pending.json', dataDir))
let config = loadConfig(configFile)
let pending = loadPending(pendingFile)

/** The config in force. A raise asked on the phone page starts once its day has passed. */
function getConfig(): Config {
  if (pending && Date.now() >= pending.at) {
    config = pending.config
    pending = null
    saveConfig(configFile, config)
    savePending(pendingFile, null)
  }
  return config
}
const shown = (): ShownConfig => {
  const c = getConfig()
  return pending ? { ...c, raisesAt: pending.at } : c
}

// The demo restarts from scratch, so only a real account keeps its lock and cool-down across restarts.
const session = createSession(venue, odds, getConfig, mode !== 'hyperliquid' ? undefined : fileDayStore(fileURLToPath(new URL('day.json', dataDir))))

let busy = false
let lastTick = 0
async function tick() {
  if (busy) return // never overlap: a slow venue must not stack polls
  busy = true
  lastTick = Date.now()
  try {
    await session.tick()
  } catch (e) {
    console.error('tick failed', e)
  } finally {
    busy = false
  }
}
void tick()
setInterval(tick, TICK_MS)
// A swing in the game reaches the rules within half a second instead of waiting for the 2 s clock.
feed?.onChange(() => { if (Date.now() - lastTick >= KICK_MS) void tick() })

const openaiKey = env.OPENAI_API_KEY
createServer({
  session, token,
  getConfig: shown,
  setConfig: c => {
    ({ config, pending } = applyLimits(getConfig(), c, Date.now()))
    saveConfig(configFile, config)
    savePending(pendingFile, pending)
    return shown()
  },
  transcribe: openaiKey ? (pcm, hint) => transcribe(pcm, openaiKey, hint) : undefined,
}).listen(port, host, () => console.log(`Glance Odds server on http://${host}:${port} (venue: ${mode}, voice: ${openaiKey ? 'on' : 'off'})`))
