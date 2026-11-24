/// <reference types="vite/client" />
import type { Config, SessionState, ShownConfig } from '../../server/src/types.ts'

// A packed app gets the tunnel address from PUBLIC_URL at build time: on the phone, localhost is the phone itself.
export const DEFAULT_SERVER: string = import.meta.env.PUBLIC_URL || 'http://localhost:8788'
const TIMEOUT_MS = 4000
const VOICE_TIMEOUT_MS = 20_000 // upload plus transcription
// Dev server only: in a build DEV is false and the bundler drops the token.
const devToken: string = import.meta.env.DEV ? import.meta.env.VITE_APP_TOKEN ?? '' : ''

// The Even WebView drops localStorage between launches (even-g2-notes, device-apis.md), so the Even app's own storage is the saved copy.
// Reads stay synchronous from `mem`; a plain browser (dev) keeps using localStorage.
const KEYS = ['go.server', 'go.token']
const mem = new Map<string, string>()
for (const k of KEYS) { try { const v = localStorage.getItem(k); if (v) mem.set(k, v) } catch { /* blocked */ } }
const saved = new Set<string>() // saved on this launch, so newer than the Even app's copy
let persist: (key: string, value: string) => void = () => {}

export function getSettings() {
  return { server: mem.get('go.server') || DEFAULT_SERVER, token: mem.get('go.token') || devToken }
}

/** Reads what the Even app saved and sends later saves there. True when that changed what getSettings gives. */
export async function loadSettings(read: (key: string) => Promise<string | undefined>, write: (key: string, value: string) => void): Promise<boolean> {
  const before = JSON.stringify(getSettings())
  for (const k of KEYS) { const v = await read(k).catch(() => undefined); if (v && !saved.has(k)) mem.set(k, v) }
  persist = write
  for (const k of saved) write(k, mem.get(k) ?? '') // a Connect pressed before the load finished wins
  return JSON.stringify(getSettings()) !== before
}

export function saveSettings(server: string, token: string) {
  const set = (k: string, v: string) => {
    mem.set(k, v)
    saved.add(k)
    persist(k, v)
    try { localStorage.setItem(k, v) } catch { /* blocked: the copy in memory lasts until reload */ }
  }
  set('go.server', server.replace(/\/+$/, ''))
  set('go.token', token)
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const { server, token } = getSettings()
  const raw = body instanceof Uint8Array
  const res = await fetch(server + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json as T
}

export const getState = () => request<SessionState>('GET', '/api/state')
export const answer = (cardId: string, yes: boolean) => request<{ ok: boolean; message: string }>('POST', '/api/answer', { cardId, yes })
export const getConfig = () => request<ShownConfig>('GET', '/api/config')
export const putConfig = (c: Config) => request<ShownConfig>('PUT', '/api/config', c)
export const voice = (pcm: Uint8Array, market: string) =>
  request<{ heard: string; ok: boolean; message: string }>('POST', `/api/voice?market=${encodeURIComponent(market)}`, pcm, VOICE_TIMEOUT_MS)
/** A spoken "yes" or "no" to one card. */
export const confirm = (pcm: Uint8Array, card: string) =>
  request<{ heard: string; ok: boolean; message: string }>('POST', `/api/voice?card=${encodeURIComponent(card)}`, pcm, VOICE_TIMEOUT_MS)
