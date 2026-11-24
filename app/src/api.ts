/// <reference types="vite/client" />
import type { Config, SessionState, ShownConfig } from '../../server/src/types.ts'

export const DEFAULT_SERVER = 'http://localhost:8788'
const TIMEOUT_MS = 4000
const VOICE_TIMEOUT_MS = 20_000 // upload plus transcription
// Dev server only: in a build DEV is false and the bundler drops the token.
const devToken: string = import.meta.env.DEV ? import.meta.env.VITE_APP_TOKEN ?? '' : ''

// shortcut: WebView localStorage; move to the SDK's bridge storage if the Even app drops it between launches.
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }

export function getSettings() {
  return { server: read('go.server') || DEFAULT_SERVER, token: read('go.token') || devToken }
}

export function saveSettings(server: string, token: string) {
  try {
    localStorage.setItem('go.server', server.replace(/\/+$/, ''))
    localStorage.setItem('go.token', token)
  } catch { /* storage blocked: settings last until reload */ }
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
