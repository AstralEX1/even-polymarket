import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http.ts'
import { applyLimits, fileDayStore, loadConfig, loadPending, saveConfig, savePending, tokenProblem, validateConfig } from '../src/config.ts'
import { DEFAULT_CONFIG } from '../src/rules.ts'
import type { Session } from '../src/session.ts'
import type { Config, SessionState } from '../src/types.ts'

const answers: Array<[string, boolean]> = []
const voiced: Array<[string, string]> = []
const confirmed: Array<[string, string]> = []
const fakeState = { markets: [], usdc: 1, dayPnl: 1, dailyLossLimitUsd: 50, locked: false, coolDownUntil: 0, card: null, pending: 0, toast: null, error: null, updatedAt: 5 } as SessionState
const session: Session = {
  tick: async () => {},
  state: () => fakeState,
  answer: async (id, yes) => { answers.push([id, yes]); return { ok: true, message: 'Skipped' } },
  voice: async (text, market) => { voiced.push([text, market]); return { ok: true, message: 'Voice: $10 on KC' } },
  confirm: async (text, card) => { confirmed.push([text, card]); return { ok: true, message: 'Bought 18 KC at 0.51' } },
  hint: market => (market === '27159' ? 'KC, Kansas City Chiefs' : ''),
}
let config: Config = { ...DEFAULT_CONFIG }
const server = createServer({ session, token: 'secret', getConfig: () => config, setConfig: c => (config = c) })
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(() => server.close())

const auth = { Authorization: 'Bearer secret' }

test('401 without the right token', async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401)
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
})

test('state with token', async () => {
  const res = await fetch(`${base}/api/state`, { headers: auth })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), fakeState)
})

test('answer passes cardId and yes, rejects a bad body', async () => {
  const res = await fetch(`${base}/api/answer`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: 'c1', yes: true }) })
  assert.deepEqual(await res.json(), { ok: true, message: 'Skipped' })
  assert.deepEqual(answers.at(-1), ['c1', true])
  assert.equal((await fetch(`${base}/api/answer`, { method: 'POST', headers: auth, body: JSON.stringify({ cardId: 1 }) })).status, 400)
})

test('put config rejects a bad value and saves a good one', async () => {
  const bad = await fetch(`${base}/api/config`, { method: 'PUT', headers: auth, body: JSON.stringify({ ...DEFAULT_CONFIG, maxBetUsd: -5 }) })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /maxBetUsd/)
  const res = await fetch(`${base}/api/config`, { method: 'PUT', headers: auth, body: JSON.stringify({ ...DEFAULT_CONFIG, maxBetUsd: 40 }) })
  assert.equal(res.status, 200)
  assert.equal(config.maxBetUsd, 40)
})

test('options is 204 with CORS; a body over 64 KB is 413', async () => {
  const res = await fetch(`${base}/api/state`, { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers: auth, body: 'x'.repeat(70_000) })).status, 413)
})

test('voice is 503 without a transcriber', async () => {
  assert.equal((await fetch(`${base}/api/voice?market=27159`, { method: 'POST', headers: auth, body: new Uint8Array(16_000) })).status, 503)
})

test('voice transcribes with the side names as a hint and passes the market on screen', async () => {
  let hint = ''
  const s2 = createServer({
    session, token: 'secret', getConfig: () => DEFAULT_CONFIG, setConfig: c => c,
    transcribe: async (pcm, h) => {
      if (pcm.length === 32_000) throw new Error('quota')
      hint = h
      return 'ten on KC'
    },
  })
  await new Promise<void>(r => s2.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/voice?market=27159`
  const post = (bytes: number) => fetch(url, { method: 'POST', headers: auth, body: new Uint8Array(bytes) })
  try {
    assert.deepEqual(await (await post(16_000)).json(), { heard: 'ten on KC', ok: true, message: 'Voice: $10 on KC' })
    assert.equal(hint, 'KC, Kansas City Chiefs')
    assert.deepEqual(voiced.at(-1), ['ten on KC', '27159'])
    // with a card id the audio answers that card, and no side names bias the transcript
    const answered = await fetch(url.replace('?market=27159', '?card=c9'), { method: 'POST', headers: auth, body: new Uint8Array(16_000) })
    assert.deepEqual(await answered.json(), { heard: 'ten on KC', ok: true, message: 'Bought 18 KC at 0.51' })
    assert.deepEqual(confirmed.at(-1), ['ten on KC', 'c9'])
    assert.equal(hint, '')
    const failed = await post(32_000)
    assert.equal(failed.status, 502)
    assert.match((await failed.json()).error, /quota/)
    assert.equal((await post(100)).status, 400)
    assert.equal((await post(400_000)).status, 413)
  } finally {
    s2.close()
  }
})

test('validateConfig checks markets and limits', () => {
  const v = (over: object) => validateConfig({ ...DEFAULT_CONFIG, ...over })
  assert.throws(() => v({ markets: [{ key: 'BTC' }] }), /outcome id/)
  assert.throws(() => v({ markets: [{ key: '1', polymarket: 'Bad Slug' }] }), /slug/)
  assert.throws(() => v({ markets: [{ key: '1' }, { key: '1' }] }), /once/)
  assert.throws(() => v({ defaultBetUsd: 30, maxBetUsd: 25 }), /defaultBetUsd/)
  assert.throws(() => v({ defaultBetUsd: 5 }), /order minimum/)
  assert.throws(() => v({ cashOutAt: 100 }), /cashOutAt/)
  assert.throws(() => v({ slippagePts: 50 }), /slippagePts/)
  assert.deepEqual(v({ markets: [{ key: 'daily:ETH', extra: 1 }] }).markets, [{ key: 'daily:ETH' }])
})

test('config and day state round-trip through files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'go-'))
  const file = join(dir, 'sub', 'config.json')
  assert.deepEqual(loadConfig(file), DEFAULT_CONFIG)
  saveConfig(file, { ...DEFAULT_CONFIG, swingPts: 20 })
  assert.equal(loadConfig(file).swingPts, 20)
  const store = fileDayStore(join(dir, 'day.json'))
  assert.equal(store.load(), null)
  store.save({ day: 1, startEquity: 100, locked: true, coolDownUntil: 0 })
  assert.equal(store.load()!.locked, true)
  const pendingFile = join(dir, 'pending.json')
  assert.equal(loadPending(pendingFile), null)
  savePending(pendingFile, { config: { ...DEFAULT_CONFIG, maxBetUsd: 40 }, at: 5 })
  assert.deepEqual(loadPending(pendingFile), { config: { ...DEFAULT_CONFIG, maxBetUsd: 40 }, at: 5 })
  savePending(pendingFile, null)
  assert.equal(loadPending(pendingFile), null)
  assert.deepEqual(readdirSync(dir).sort(), ['day.json', 'pending.json', 'sub']) // no .tmp left behind
})

test('a lower limit counts at once, a higher one waits a day', () => {
  const cur = { ...DEFAULT_CONFIG } // cap $25, default $15, daily -$50, cool-down 10 min
  const lower = { ...cur, maxBetUsd: 10, defaultBetUsd: 10, coolDownMin: 30 }
  assert.deepEqual(applyLimits(cur, lower, 1000), { config: lower, pending: null })
  const higher = { ...cur, maxBetUsd: 100, defaultBetUsd: 50, dailyLossLimitUsd: 500, coolDownMin: 1, swingPts: 20 }
  const r = applyLimits(cur, higher, 1000)
  assert.deepEqual(r.config, { ...cur, swingPts: 20, defaultBetUsd: 25 }) // other fields count now; the default stays under the cap in force
  assert.deepEqual(r.pending, { config: higher, at: 1000 + 86_400_000 })
})

test('a short token is refused off loopback', () => {
  assert.match(tokenProblem('short', '0.0.0.0') ?? '', /16/)
  assert.equal(tokenProblem('short', '127.0.0.1'), null)
  assert.match(tokenProblem('', '127.0.0.1') ?? '', /APP_TOKEN/)
})
