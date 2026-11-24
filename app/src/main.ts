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
import type { Config, SessionState, ShownConfig } from '../../server/src/types.ts'
import { NUMBER_FIELDS } from '../../server/src/rules.ts'
import { renderScreen } from './view.ts'
import { endpointer } from './endpoint.ts'
import { marketLine, parseMarkets } from './markets.ts'
import * as api from './api.ts'

const POLL_MS = 1000
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
const note = (text: string, ms = NOTE_MS) => { voiceNote = { text, until: Date.now() + ms } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// ── glasses ────────────────────────────────────────────────

const textBox = (content: string, capture: boolean, height: number) => new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height, borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 1, containerName: 'main', content, isEventCapture: capture ? 1 : 0,
})

/** The firmware's own list draws the selection and scrolls it. No comes first, so a stray tap on a new card is a no. */
const choiceList = () => new ListContainerProperty({
  xPosition: 0, yPosition: CARD_TEXT_HEIGHT, width: 220, height: 288 - CARD_TEXT_HEIGHT,
  borderWidth: 0, borderColor: 5, paddingLength: 4, containerID: 2, containerName: 'choice', isEventCapture: 1,
  itemContainer: new ListItemContainerProperty({ itemCount: 2, itemWidth: 0, isItemSelectBorderEn: 1, itemName: ['No', 'Yes'] }),
})

const page = (text: string, card: boolean) => card
  ? { containerTotalNum: 2, textObject: [textBox(text, false, CARD_TEXT_HEIGHT)], listObject: [choiceList()] }
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
  const text = renderScreen(state, focus, offline, Date.now() < voiceNote.until ? voiceNote.text : '')
  $('preview').textContent = card ? `${text}\n\n[ No ]  Yes` : text
  const b = bridge
  if (!b) return
  if ((card?.id ?? null) !== pageCard) {
    // A fresh page per card: its list starts on No, and no choice carries over from the card before.
    pageCard = card?.id ?? null
    shown = text
    return serial(() => b.rebuildPageContainer(new RebuildPageContainer(page(text, !!card))))
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
  $('status').textContent = offline ? 'Server offline' : `Connected · ${state?.markets.length ?? 0} markets`
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
  note(ok ? (card ? 'Say "yes" or "no"' : 'Listening...') : 'Mic unavailable', ok ? Infinity : NOTE_MS)
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

/** A press on the card's list: the item under the selection answers it. */
async function choose(ev: { currentSelectItemIndex?: number; currentSelectItemName?: string }) {
  const card = state?.card
  if (!card || card.id !== pageCard || answering) return
  // protobuf drops a zero index, so "No" (item 0) arrives as undefined: anything unclear is a no.
  const yes = ev.currentSelectItemName ? ev.currentSelectItemName === 'Yes' : ev.currentSelectItemIndex === 1
  await stopListening()
  answering = true
  try {
    await api.answer(card.id, yes)
  } catch {
    // the next poll shows the server state either way
  } finally {
    answering = false
  }
  return poll()
}

async function sendVoice() {
  if (mic !== 'on') return
  mic = 'sending'
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
      note('', 0) // the server's toast says what it heard
    } catch (e) {
      note(`Voice: ${(e as Error).message}`)
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
    $('glasses').textContent = 'Glasses: not connected (plain browser)'
    return
  }
  shown = renderScreen(null, focus, offline)
  pageCard = null // starts on the market page; the first poll switches to a card page if one is waiting
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(shown, false)))
  $('glasses').textContent = result === 0 ? 'Glasses: connected' : `Glasses: display error ${result}`
  bridge.onEvenHubEvent(e => void onEvent(e))
}

// ── phone page ─────────────────────────────────────────────

const msg = (t: string) => { $('message').textContent = t }

/** Shows the limits in force; higher ones you asked for wait a day, and the page says when they start. */
function fillForm(c: ShownConfig, done: string) {
  for (const k of NUMBER_FIELDS) $<HTMLInputElement>(k).value = String(c[k])
  $<HTMLTextAreaElement>('markets').value = c.markets.map(marketLine).join('\n')
  msg(c.raisesAt ? `${done}. Higher limits start ${new Date(c.raisesAt).toLocaleString()}. Saving again replaces them.` : done)
}

async function startPhonePage() {
  const s = api.getSettings()
  $<HTMLInputElement>('server').value = s.server
  $<HTMLInputElement>('token').value = s.token

  $('connect').addEventListener('click', async () => {
    api.saveSettings($<HTMLInputElement>('server').value.trim(), $<HTMLInputElement>('token').value.trim())
    try {
      fillForm(await api.getConfig(), 'Connected')
    } catch (e) {
      msg(`Cannot connect: ${(e as Error).message}`)
    }
    void poll()
  })

  $('save').addEventListener('click', async () => {
    try {
      const c = { markets: parseMarkets($<HTMLTextAreaElement>('markets').value) } as Config
      for (const k of NUMBER_FIELDS) c[k] = Number($<HTMLInputElement>(k).value)
      fillForm(await api.putConfig(c), 'Saved')
    } catch (e) {
      msg((e as Error).message)
    }
  })

  try { fillForm(await api.getConfig(), '') } catch { msg('Set the server and token, then Connect') }
}

window.addEventListener('beforeunload', () => { if (mic !== 'off') void bridge?.audioControl(false) })
void startPhonePage()
void startGlasses()
void poll()
setInterval(poll, POLL_MS)
