import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Card, Config, Game, SessionState, ShownConfig } from '../../server/src/types.ts'
import { NUMBER_FIELDS } from '../../server/src/rules.ts'
import { choices, MIC, renderScreen } from './view.ts'
import { endpointer } from './endpoint.ts'
import { marketLine, parseMarkets } from './markets.ts'
import * as api from './api.ts'

const POLL_MS = 500 // the server's state moves with the game's odds now; a card should not wait a second to show
const BRIDGE_TIMEOUT_MS = 10_000
const LISTEN_MS = 5000 // the cap; it usually stops when you go quiet
const CONFIRM_MS = 3000 // long enough for "yes", short enough not to catch the room
const MIN_AUDIO_BYTES = 9600 // 0.3 s of 16 kHz s16le
const NOTE_MS = 5000
const CARD_TEXT_HEIGHT = 176 // the card's text on top, the NO / YES list below

let state: SessionState | null = null
let offline = false
let focus = 0 // which market the session screen shows; voice bets go to it
let bridge: EvenAppBridge | null = null
let pageCard: string | null = null // the card the glasses page shows, null for the market page
let shown = ''
let answering = false
let mic: 'off' | 'starting' | 'on' | 'sending' = 'off'
let audio: Uint8Array[] = []
let endpoint: ((pcm: Uint8Array) => boolean) | null = null
let listenTimer: ReturnType<typeof setTimeout> | undefined
let confirmFor: string | null = null // the card this recording answers, null for a command
let voiceNote = { text: '', until: 0 }
let spoke = false // the first bet you speak retires the how-to line
const note = (text: string, ms = NOTE_MS) => { voiceNote = { text, until: Date.now() + ms } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// ── glasses ────────────────────────────────────────────────

const textBox = (content: string, capture: boolean, height: number) => new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height, borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 1, containerName: 'main', content, isEventCapture: capture ? 1 : 0,
})

/** The firmware's own list draws the selection and scrolls it. The safe action comes first, so a stray tap on a new card declines it. */
const choiceList = (card: Card) => new ListContainerProperty({
  xPosition: 0, yPosition: CARD_TEXT_HEIGHT, width: 288, height: 288 - CARD_TEXT_HEIGHT,
  borderWidth: 0, borderColor: 5, paddingLength: 4, containerID: 2, containerName: 'choice', isEventCapture: 1,
  itemContainer: new ListItemContainerProperty({ itemCount: 2, itemWidth: 0, isItemSelectBorderEn: 1, itemName: choices(card) }),
})

const page = (text: string, card: Card | null) => card
  ? { containerTotalNum: 2, textObject: [textBox(text, false, CARD_TEXT_HEIGHT)], listObject: [choiceList(card)] }
  : { containerTotalNum: 1, textObject: [textBox(text, true, 288)] }

// One bridge call at a time: a page rebuild, a text update and the mic switch in flight together can drop the BLE link.
let bridgeQueue: Promise<unknown> = Promise.resolve()
function serial<T>(call: () => Promise<T>): Promise<T | undefined> {
  const run = bridgeQueue.then(call)
  bridgeQueue = run.catch(() => {})
  return run.catch(() => undefined)
}

async function draw() {
  const n = state?.markets.length ?? 0
  focus = n ? ((focus % n) + n) % n : 0
  const card = state?.card ?? null
  const text = renderScreen(state, focus, offline, Date.now() < voiceNote.until ? voiceNote.text : '', Date.now(), !spoke && mic === 'off')
  $('preview').textContent = card ? `${text}\n\n[ ${choices(card)[0]} ]  ${choices(card)[1]}` : text
  const b = bridge
  if (!b) return
  if ((card?.id ?? null) !== pageCard) {
    // A fresh page per card: its list starts on No, and no choice carries over from the card before.
    pageCard = card?.id ?? null
    shown = text
    return serial(() => b.rebuildPageContainer(new RebuildPageContainer(page(text, card))))
  }
  if (text === shown) return
  shown = text
  return serial(() => b.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: text })))
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    state = await api.getState()
    offline = false
  } catch {
    offline = true
  } finally {
    polling = false
  }
  document.body.dataset.online = String(!offline)
  $('status').textContent = offline ? 'Server offline' : 'Connected'
  await draw()
}

// ── voice: tap on the market screen and speak; it sends when you go quiet (or on a tap, or after 5 s).
//    The card you asked for then hears "yes" / "no" for 3 s. ──

async function startListening(card: string | null = null) {
  if (!bridge || mic !== 'off') return
  mic = 'starting'
  audio = []
  endpoint = endpointer()
  confirmFor = card
  const b = bridge
  const ok = await serial(() => b.audioControl(true, AudioInputSource.Glasses))
  if (mic !== 'starting') { if (ok) await serial(() => b.audioControl(false)); return } // a press on the card stopped it meanwhile
  mic = ok ? 'on' : 'off'
  note(ok ? `${MIC} ${card ? 'Say "yes" or "no"' : 'Listening'}` : 'Mic unavailable', ok ? Infinity : NOTE_MS)
  if (ok) listenTimer = setTimeout(() => void sendVoice(), card ? CONFIRM_MS : LISTEN_MS)
  return draw()
}

/** Drops a recording in progress: a press on the card answers by hand. */
async function stopListening() {
  if (mic !== 'starting' && mic !== 'on') return
  const wasOn = mic === 'on'
  clearTimeout(listenTimer)
  mic = 'off'
  audio = []
  confirmFor = null
  note('', 0)
  const b = bridge
  if (wasOn && b) await serial(() => b.audioControl(false))
}

/** A fill's message with the seconds since the press or the end of the spoken "yes". Only fills are timed: "Bought" / "Sold" from the server. */
const timed = (message: string, since: number) =>
  /^(Bought|Sold) /.test(message) ? `${message} · ${((Date.now() - since) / 1000).toFixed(1)} s` : message

/** The answer to a card, said at once on the glasses, then its result. */
async function answerCard(card: Card, yes: boolean, since: number, send: () => Promise<{ ok: boolean; message: string }>) {
  if (yes) {
    // Said on the glasses at once, before the network: the press is seen to land.
    note(`${card.action.type === 'buy' ? 'Buying' : 'Cashing out'} ${card.action.shares} ${card.action.sideName}...`, Infinity)
    await draw()
  }
  try {
    const r = await send()
    note(timed(r.message, since)) // replaces the server's toast of the same words
  } catch {
    note('', 0) // a slow exchange outlives the request: the server's toast says how it ended
  }
}

/** A press on the card's list: the item under the selection answers it. */
async function choose(ev: { currentSelectItemIndex?: number; currentSelectItemName?: string }) {
  const card = state?.card
  if (!card || card.id !== pageCard || answering) return
  const pressed = Date.now()
  // protobuf drops a zero index, so the first item arrives as undefined: anything unclear declines.
  const yes = ev.currentSelectItemName ? ev.currentSelectItemName === choices(card)[1] : ev.currentSelectItemIndex === 1
  await stopListening()
  answering = true
  try {
    await answerCard(card, yes, pressed, () => api.answer(card.id, yes))
  } finally {
    answering = false
  }
  return poll()
}

async function sendVoice() {
  if (mic !== 'on') return
  mic = 'sending'
  const ended = Date.now()
  clearTimeout(listenTimer)
  const b = bridge
  if (b) await serial(() => b.audioControl(false))
  const card = confirmFor
  confirmFor = null
  const pcm = new Uint8Array(audio.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of audio) { pcm.set(c, at); at += c.length }
  audio = []
  let asked = false // a spoken command queued a card
  if (pcm.length < MIN_AUDIO_BYTES) {
    note(card ? '' : 'Heard nothing', card ? 0 : NOTE_MS) // silence on a card just leaves it for scroll and tap
  } else {
    note('Thinking...', Infinity)
    await draw()
    try {
      const r = card ? await api.confirm(pcm, card) : await api.voice(pcm, state?.markets[focus]?.key ?? '')
      asked = !card && r.ok
      if (asked) spoke = true
      if (card) note(timed(r.message, ended))
      else note('', 0) // the server's toast says what it heard
    } catch (e) {
      note((e as Error).message)
    }
  }
  mic = 'off'
  await poll()
  // Only a card you just asked for listens, so a cash-out card raised by a rule never hears the TV.
  if (asked && state?.card?.key.startsWith('voice:')) await startListening(state.card.id)
}

// CLICK_EVENT is 0 and protobuf drops zero fields, so a tap arrives with eventType undefined.
// Resolve the default inside the envelope check (pattern from the Even Hub minimal template).
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

async function onEvent(event: Parameters<Parameters<EvenAppBridge['onEvenHubEvent']>[0]>[0]) {
  if (event.audioEvent) {
    if (mic !== 'starting' && mic !== 'on') return
    audio.push(event.audioEvent.audioPcm)
    if (mic === 'on' && endpoint?.(event.audioEvent.audioPcm)) void sendVoice() // you went quiet: no second tap
    return
  }
  // A list press arrives as listEvent; only its double press counts here.
  const types = [eventTypeOf(event.sysEvent), eventTypeOf(event.textEvent), event.listEvent?.eventType ?? null]
  const is = (t: OsEventTypeList) => types.includes(t)

  const b = bridge
  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    // Exit works on every screen. The system asks first, so the mic stops only once the exit is confirmed (below).
    if (b) void serial(() => b.shutDownPageContainer(1))
    return
  }
  if (is(OsEventTypeList.SYSTEM_EXIT_EVENT) || is(OsEventTypeList.ABNORMAL_EXIT_EVENT)) return stopListening()
  if (is(OsEventTypeList.FOREGROUND_ENTER_EVENT)) {
    shown = ''
    return poll()
  }
  // A card: the firmware list moves the selection itself, and a press picks. Anything but a press on it is ignored.
  if (event.listEvent) return (event.listEvent.eventType ?? OsEventTypeList.CLICK_EVENT) === OsEventTypeList.CLICK_EVENT ? choose(event.listEvent) : undefined
  if (is(OsEventTypeList.CLICK_EVENT) && mic === 'on') return sendVoice()
  if (pageCard) return // on a card page the list takes the input
  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) { focus--; return draw() }
  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) { focus++; return draw() }
  if (is(OsEventTypeList.CLICK_EVENT)) return startListening()
}

async function startGlasses() {
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no bridge')), BRIDGE_TIMEOUT_MS)),
    ])
  } catch {
    $('glasses').textContent = '· no glasses here'
    return
  }
  shown = renderScreen(null, focus, offline)
  pageCard = null // starts on the market page; the first poll switches to a card page if one is waiting
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(shown, null)))
  // A plain browser also gets a bridge, which answers 1 (invalid): the page says no glasses, the console keeps the code.
  if (result !== 0) console.warn('createStartUpPageContainer returned', result)
  $('glasses').textContent = result === 0 ? '· glasses on' : '· no glasses here'
  bridge.onEvenHubEvent(e => void onEvent(e))
}

// ── phone page: one screen. Games are tapped on and off, the two limits that matter are in view, the rest is under More.
//    Every change saves itself, as in the phone's own settings. ──

let config: ShownConfig | null = null
let games: Game[] = []
const BTC_DAILY: Game = { key: 'daily:BTC', title: 'BTC daily', startsAt: 0, polymarket: null }
const LIMITS_NOTE = 'Lower limits apply at once. Higher ones start 24 hours after you set them.'

function say(text: string, error = false) {
  $('message').textContent = text
  $('message').classList.toggle('error', error)
}

/** "Live", "Today 21:30", "Thu 09:20": when the game is, in the phone's own time. */
function kickoff(g: Game, now = Date.now()): string {
  if (!g.startsAt) return 'Hyperliquid daily, ends 03:00 UTC'
  if (g.startsAt <= now) return 'Live'
  const d = new Date(g.startsAt)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date(now).toDateString() ? `Today ${time}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function gameRow(g: Game, on: boolean): HTMLElement {
  const b = document.createElement('button')
  b.className = 'row'
  b.setAttribute('role', 'listitem')
  b.setAttribute('aria-pressed', String(on))
  const text = document.createElement('span')
  text.className = 'text'
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = g.title // exchange data: text, never HTML
  const sub = document.createElement('span')
  sub.className = 'sub'
  const when = kickoff(g)
  const live = document.createElement('span')
  live.className = when === 'Live' ? 'live' : ''
  live.textContent = when
  sub.append(live, g.startsAt ? (g.polymarket ? ' · Polymarket odds' : ' · testnet odds only') : '')
  text.append(title, sub)
  const check = document.createElement('span')
  check.className = 'check'
  check.textContent = '✓'
  check.setAttribute('aria-hidden', 'true')
  b.append(text, check)
  b.addEventListener('click', () => void toggle(g))
  return b
}

/** Offered games, BTC daily, then anything watched that is not offered (an id typed under More, a game that ended). */
function renderGames() {
  const on = new Set(config?.markets.map(m => m.key))
  const offered = [...games, BTC_DAILY]
  const others = (config?.markets ?? []).filter(m => !offered.some(g => g.key === m.key)).map((m): Game =>
    ({ key: m.key, title: state?.markets.find(x => x.key === m.key)?.title ?? m.key, startsAt: 0, polymarket: m.polymarket ?? null }))
  $('games').replaceChildren(...[...offered, ...others].map(g => gameRow(g, on.has(g.key))))
}

/** Shows the config in force: a refused value or a raise still waiting goes back to the limit that counts now. The markets box keeps what is being typed. */
function show(c: ShownConfig) {
  config = c
  for (const k of NUMBER_FIELDS) $<HTMLInputElement>(k).value = String(c[k])
  if (document.activeElement !== $('markets')) $<HTMLTextAreaElement>('markets').value = c.markets.map(marketLine).join('\n')
  renderGames()
}

/** The server names fields as the config does ("defaultBetUsd must not be above maxBetUsd"); the page says them as its labels. */
const plainly = (message: string) =>
  NUMBER_FIELDS.reduce((m, k) => m.replaceAll(k, `"${$(k).closest('label')?.querySelector('span')?.textContent ?? k}"`), message)

async function save(next: Config, done: string) {
  try {
    const shown = await api.putConfig(next)
    show(shown)
    say(shown.raisesAt ? `${done}. Higher limits start ${new Date(shown.raisesAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : done)
  } catch (e) {
    if (config) show(config) // back to what is in force
    say(plainly((e as Error).message), true)
  }
}

const current = (): Config => {
  const { raisesAt: _, ...c } = config!
  return c
}

async function toggle(g: Game) {
  if (!config) return say('Connect to your server first', true)
  const on = config.markets.some(m => m.key === g.key)
  const markets = on ? config.markets.filter(m => m.key !== g.key) : [...config.markets, g.polymarket ? { key: g.key, polymarket: g.polymarket } : { key: g.key }]
  config = { ...config, markets }
  renderGames() // the check moves on the tap, before the server answers
  await save({ ...current(), markets }, on ? `${g.title} is off the glasses` : `${g.title} is on the glasses`)
}

async function connect() {
  try {
    show(await api.getConfig())
    $('pair').hidden = true
    $('more-server').append($('server-group')) // connected: the server moves under More
    say(LIMITS_NOTE)
  } catch (e) {
    $('pair').hidden = false
    $('pair').append($('server-group'))
    say(api.getSettings().token ? `Cannot connect: ${(e as Error).message}` : 'Enter your server and token, then Connect', true)
    return
  }
  try { games = await api.getGames() } catch { games = [] } // an older server has no list: BTC daily and typed ids still work
  renderGames()
}

function startPhonePage() {
  const s = api.getSettings()
  $<HTMLInputElement>('server').value = s.server
  $<HTMLInputElement>('token').value = s.token
  $('connect').addEventListener('click', () => {
    api.saveSettings($<HTMLInputElement>('server').value.trim(), $<HTMLInputElement>('token').value.trim())
    void connect().then(poll)
  })
  for (const k of NUMBER_FIELDS) {
    $(k).addEventListener('change', () => {
      if (!config) return
      void save({ ...current(), [k]: Number($<HTMLInputElement>(k).value) }, 'Saved')
    })
  }
  $('save').addEventListener('click', () => {
    if (!config) return say('Connect to your server first', true)
    try {
      void save({ ...current(), markets: parseMarkets($<HTMLTextAreaElement>('markets').value) }, 'Markets saved')
    } catch (e) {
      say((e as Error).message, true)
    }
  })
  renderGames()
  void connect()
}

window.addEventListener('beforeunload', () => { if (mic !== 'off') void bridge?.audioControl(false) })
startPhonePage()
void startGlasses()
void poll()
setInterval(poll, POLL_MS)
