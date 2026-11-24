// End to end in the Even Hub simulator, on the fake venue (no keys): wait for the demo's swing card (about 40 s in),
// pick its action on the glasses list (down, click) and expect the server to report the sale.
// It opens the simulator window, so it needs a display; it is not part of CI. Its ports differ from `npm run server` / `dev`.
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionState } from '../server/src/types.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = 'e2e-token-0123456789'
const SERVER = 'http://127.0.0.1:8799'
const APP = 'http://localhost:5199'
const SIM = 'http://127.0.0.1:9899'
const PAGE_MS = 3000 // the app polls every second, then rebuilds the glasses page for the card

const running: { name: string; child: ChildProcess; log: string[] }[] = []
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Each in its own process group, so the simulator's native child goes with it. */
function start(name: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const p = { name, child, log: [] as string[] }
  const keep = (d: Buffer) => { p.log.push(String(d)); if (p.log.length > 40) p.log.shift() }
  child.stdout!.on('data', keep)
  child.stderr!.on('data', keep)
  running.push(p)
}

function stopAll() {
  for (const { child } of running) {
    try { process.kill(-child.pid!, 'SIGTERM') } catch { /* already gone */ }
  }
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const v = await probe()
      if (v !== undefined) return v
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error(`Timed out after ${ms / 1000} s waiting for ${what}`)
}

const state = async (): Promise<SessionState> => {
  const res = await fetch(`${SERVER}/api/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  if (!res.ok) throw new Error(`state ${res.status}`)
  return res.json() as Promise<SessionState>
}
const press = async (action: 'up' | 'down' | 'click') => {
  await fetch(`${SIM}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
  await sleep(400)
}

async function main() {
  // VENUE=fake and an explicit env: the user's .env (keys, PUBLIC_URL) is never loaded here.
  start('server', process.execPath, ['server/src/main.ts'], { VENUE: 'fake', APP_TOKEN: TOKEN, PORT: '8799', HOST: '127.0.0.1', PUBLIC_URL: '', OPENAI_API_KEY: '' })
  // Process env wins over .env in Vite: the app's default server and dev token point at this server.
  start('app', join(ROOT, 'node_modules/.bin/vite'), ['--config', 'app/vite.config.ts', '--port', '5199', '--strictPort'], { VITE_APP_TOKEN: TOKEN, PUBLIC_URL: SERVER })
  const first = await until('the server', 15_000, async () => ((await state()).markets.length ? state() : undefined))
  if (!first.markets.some(m => m.key === '27159')) throw new Error('The demo market 27159 is missing: server/data/config.json overrides the default markets')
  await until('the app dev server', 15_000, async () => ((await fetch(APP)).ok ? true : undefined))
  start('simulator', join(ROOT, 'node_modules/.bin/evenhub-simulator'), [APP, '--automation-port', '9899'])
  await until('the simulator', 30_000, async () => ((await (await fetch(`${SIM}/api/ping`)).text()).includes('pong') ? true : undefined))

  const card = await until('the swing card (about 40 s into the demo)', 90_000, async () => (await state()).card ?? undefined)
  console.log(`card: ${card.question}`)
  await sleep(PAGE_MS)
  await press('down') // the list starts on the safe choice; the action is the second item
  await press('click')
  const toast = await until('the sale', 8000, async () => {
    const t = (await state()).toast
    if (t === 'Skipped') throw new Error('The press landed on the safe choice: the down did not reach the list')
    return t && /^Sold /.test(t) ? t : undefined
  })
  console.log(`server: ${toast}`)

  const png = Buffer.from(await (await fetch(`${SIM}/api/screenshot/glasses`)).arrayBuffer())
  if (png.subarray(1, 4).toString() !== 'PNG') throw new Error('The glasses screenshot is not a PNG')
  const shot = join(tmpdir(), 'sideline-odds-e2e-glasses.png')
  writeFileSync(shot, png)
  console.log(`glasses after the sale: ${shot}`)

  const { entries } = (await (await fetch(`${SIM}/api/console`)).json()) as { entries: { level: string; message: string }[] }
  const crashes = entries.filter(e => /^\[(uncaught|unhandledrejection)\]/.test(e.message))
  for (const e of entries.filter(e => e.message.startsWith('[fetch]'))) console.warn(`app: ${e.message}`)
  if (crashes.length) throw new Error(`App errors:\n${crashes.map(e => e.message).join('\n')}`)
}

main().then(
  () => { console.log('e2e passed'); stopAll(); process.exit(0) },
  e => {
    console.error(`e2e failed: ${(e as Error).message}`)
    for (const p of running) console.error(`--- ${p.name}\n${p.log.join('').slice(-1500)}`)
    stopAll()
    process.exit(1)
  },
)
