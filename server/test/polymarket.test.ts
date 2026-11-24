import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPolymarket, matchSides } from '../src/polymarket.ts'
import type { OutcomeSide } from '../src/types.ts'

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'

const side = (name: string, fullName: string, encoding = 0): OutcomeSide =>
  ({ name, fullName, coin: `#${encoding}`, token: `+${encoding}`, asset: 100_000_000 + encoding })

const KC = side('KC', 'Kansas City Chiefs', 271590)
const BUF = side('BUF', 'Buffalo Bills', 271591)
const LAC = side('LAC', 'Los Angeles Chargers')
const LAR = side('LAR', 'Los Angeles Rams')
const YES = side('Yes', 'Yes')
const NO = side('No', 'No')

// Trimmed from the real Gamma responses of 22.11.2026 (event nfl-kc-buf-2026-11-27 has 298 markets).
const MONEYLINE = {
  slug: 'nfl-kc-buf-2026-11-27', sportsMarketType: 'moneyline', closed: false,
  outcomes: '["Chiefs", "Bills"]',
  clobTokenIds: '["18005278857776594058753852610217882565789388916387610970562410402030021315766", "48587668859121385429521392778301244338034211032276628907358575749772967593139"]',
  positionIds: ['739324071129124003611782467086261467604674061908632831989153590311422787584', '739324071129124003611782467086261467604674061908632831989153590311422787585'],
}
const MONEYLINE_2H = {
  slug: 'nfl-kc-buf-2026-11-27-2h-moneyline', sportsMarketType: 'second_half_moneyline', closed: false,
  outcomes: '["Chiefs", "Bills"]',
  clobTokenIds: '["64012844487631325166295073504428678759712229814837869914372212843346490281012", "22167052941854841885822848620950360896096424489751542684088180179046269780250"]',
}
const SPREAD = {
  slug: 'nfl-kc-buf-2026-11-27-spread-away-1pt5', sportsMarketType: 'spreads', closed: false,
  outcomes: '["Chiefs", "Bills"]',
  clobTokenIds: '["113568071293869046093017271681665387527155051788955799976616551636678025285813", "75610114715182437884710232787459856913357622136446268878737739584868842296795"]',
}
const TOTAL = {
  slug: 'nfl-kc-buf-2026-11-27-total-24pt5', sportsMarketType: 'totals', closed: false,
  outcomes: '["Over", "Under"]',
  clobTokenIds: '["68912404761505218832219025575659583397914355196673649298794564865600535947697", "71538889780020875536475198455274605244120472543947064451047636977172100298320"]',
}
const BEARS_LEAVE = {
  slug: 'will-the-chicago-bears-leave-illinois-by-dec-31', closed: false,
  outcomes: '["Yes", "No"]',
  clobTokenIds: '["57459459588879709963273319381990007828380061496082234866420014454347747306788", "4274310553603736566486785899565424871651303818987087302859462265499335584347"]',
}
const token = (m: { clobTokenIds: string }, i: number) => JSON.parse(m.clobTokenIds)[i] as string

/** Fake fetch over exact URLs. Unknown URLs get the CLOB's real 404 body. */
function fake(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (!(url in routes)) return Response.json({ error: 'No orderbook exists for the requested token id' }, { status: 404 })
    const body = routes[url]
    if (body instanceof Error) throw body
    return Response.json(body)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

test('matchSides: NFL nicknames match full team names, either order', () => {
  assert.deepEqual(matchSides(['Chiefs', 'Bills'], [KC, BUF]), [0, 1])
  assert.deepEqual(matchSides(['Bills', 'Chiefs'], [KC, BUF]), [1, 0])
  assert.deepEqual(matchSides(['Commanders', 'Bengals'], [side('CIN', 'Cincinnati Bengals'), side('WSH', 'Washington Commanders')]), [1, 0])
  assert.deepEqual(matchSides(['49ers', 'Rams'], [side('SF', 'San Francisco 49ers'), LAR]), [0, 1])
})

test('matchSides: equal names, abbreviations and full names, any casing', () => {
  assert.deepEqual(matchSides(['KC', 'BUF'], [KC, BUF]), [0, 1])
  assert.deepEqual(matchSides(['Kansas City Chiefs', 'Buffalo Bills'], [KC, BUF]), [0, 1])
  assert.deepEqual(matchSides(['CHIEFS', 'bills'], [KC, BUF]), [0, 1])
  assert.deepEqual(matchSides(['chiefs', 'BILLS'], [side('kc', 'KANSAS CITY CHIEFS'), side('buf', 'buffalo bills')]), [0, 1])
  assert.deepEqual(matchSides(['KC wins', 'BUF wins'], [KC, BUF]), [0, 1])
})

test('matchSides: Yes and No', () => {
  assert.deepEqual(matchSides(['Yes', 'No'], [YES, NO]), [0, 1])
  assert.deepEqual(matchSides(['yes', 'no'], [NO, YES]), [1, 0])
  assert.equal(matchSides(['Yes', 'No'], [KC, BUF]), null)
})

test('matchSides: Over / Under never match teams', () => {
  assert.equal(matchSides(['Over', 'Under'], [KC, BUF]), null)
  assert.equal(matchSides(['Over', 'Under'], [YES, NO]), null)
})

test('matchSides: whole words only', () => {
  assert.equal(matchSides(['Rams', 'Chiefs'], [side('NYR', 'Ramsey'), KC]), null)
  assert.equal(matchSides(['K', 'Bills'], [KC, BUF]), null)
  assert.equal(matchSides(['', 'Bills'], [KC, BUF]), null)
})

test('matchSides: two teams from one city', () => {
  assert.deepEqual(matchSides(['Chargers', 'Rams'], [LAC, LAR]), [0, 1])
  assert.deepEqual(matchSides(['Rams', 'Chargers'], [LAC, LAR]), [1, 0])
  assert.equal(matchSides(['Los Angeles', 'Los Angeles'], [LAC, LAR]), null)
  assert.equal(matchSides(['Los Angeles', 'Rams'], [LAC, LAR]), null)
})

test('matchSides: both sides on one outcome is no match', () => {
  assert.equal(matchSides(['Chiefs', 'Bills'], [KC, side('KC', 'Kansas City Chiefs')]), null)
})

test('prices: market slug, midpoint of side 0, side 1 mirrored', async () => {
  const { fetch, calls } = fake({
    [`${GAMMA}/markets?slug=nfl-kc-buf-2026-11-27`]: [MONEYLINE],
    [`${CLOB}/midpoint?token_id=${token(MONEYLINE, 0)}`]: { mid: '0.41' },
    [`${CLOB}/midpoint?token_id=${token(MONEYLINE, 1)}`]: { mid: '0.59' },
  })
  const pm = createPolymarket({ fetch })
  assert.deepEqual(await pm.prices('nfl-kc-buf-2026-11-27', [KC, BUF]), [0.41, 1 - 0.41])
  assert.deepEqual(await pm.prices('nfl-kc-buf-2026-11-27', [BUF, KC]), [0.59, 1 - 0.59])
  assert.equal(calls.filter(u => u.startsWith(GAMMA)).length, 1)
  assert.equal(calls.filter(u => u.startsWith(CLOB)).length, 2)
})

test('prices: Yes / No market', async () => {
  const { fetch } = fake({
    [`${GAMMA}/markets?slug=${BEARS_LEAVE.slug}`]: [BEARS_LEAVE],
    [`${CLOB}/midpoint?token_id=${token(BEARS_LEAVE, 0)}`]: { mid: '0.105' },
  })
  assert.deepEqual(await createPolymarket({ fetch }).prices(BEARS_LEAVE.slug, [YES, NO]), [0.105, 1 - 0.105])
})

test('prices: event slug picks the full-game moneyline over spreads and the 2H moneyline', async () => {
  const { fetch } = fake({
    [`${GAMMA}/markets?slug=chiefs-bills`]: [],
    [`${GAMMA}/events?slug=chiefs-bills`]: [{ slug: 'chiefs-bills', markets: [SPREAD, TOTAL, MONEYLINE_2H, MONEYLINE] }],
    [`${CLOB}/midpoint?token_id=${token(MONEYLINE, 0)}`]: { mid: '0.41' },
  })
  assert.deepEqual(await createPolymarket({ fetch }).prices('chiefs-bills', [KC, BUF]), [0.41, 1 - 0.41])
})

test('prices: event with several matching markets and no moneyline is null', async () => {
  const { fetch, calls } = fake({
    [`${GAMMA}/markets?slug=x`]: [],
    [`${GAMMA}/events?slug=x`]: [{ markets: [SPREAD, MONEYLINE_2H] }],
  })
  assert.equal(await createPolymarket({ fetch }).prices('x', [KC, BUF]), null)
  assert.equal(calls.filter(u => u.startsWith(CLOB)).length, 0)
})

test('prices: a soccer event with three Yes/No moneylines (home, draw, away) is null for a Yes/No side', async () => {
  const yesNo = (slug: string) => ({ ...BEARS_LEAVE, slug, sportsMarketType: 'moneyline' })
  const { fetch, calls } = fake({
    [`${GAMMA}/markets?slug=epl-hul-bri`]: [],
    [`${GAMMA}/events?slug=epl-hul-bri`]: [{ markets: [yesNo('hull-win'), yesNo('draw'), yesNo('brighton-win')] }],
  })
  assert.equal(await createPolymarket({ fetch }).prices('epl-hul-bri', [YES, NO]), null)
  assert.equal(calls.filter(u => u.startsWith(CLOB)).length, 0)
})

test('prices: closed markets are skipped', async () => {
  const { fetch } = fake({ [`${GAMMA}/markets?slug=old`]: [{ ...MONEYLINE, closed: true }], [`${GAMMA}/events?slug=old`]: [] })
  await assert.rejects(createPolymarket({ fetch }).prices('old', [KC, BUF]), /no open market "old"/)
})

test('prices: sides that do not match give null without a CLOB request', async () => {
  const { fetch, calls } = fake({ [`${GAMMA}/markets?slug=${TOTAL.slug}`]: [TOTAL] })
  assert.equal(await createPolymarket({ fetch }).prices(TOTAL.slug, [KC, BUF]), null)
  assert.equal(calls.length, 1)
})

test('prices: resolution is cached 10 minutes', async () => {
  let now = 0
  const { fetch, calls } = fake({
    [`${GAMMA}/markets?slug=nfl-kc-buf-2026-11-27`]: [MONEYLINE],
    [`${CLOB}/midpoint?token_id=${token(MONEYLINE, 0)}`]: { mid: '0.41' },
  })
  const pm = createPolymarket({ fetch, clock: () => now })
  const gamma = () => calls.filter(u => u.startsWith(GAMMA)).length
  await pm.prices('nfl-kc-buf-2026-11-27', [KC, BUF])
  now = 9 * 60_000
  await pm.prices('nfl-kc-buf-2026-11-27', [KC, BUF])
  assert.equal(gamma(), 1)
  now = 10 * 60_000
  await pm.prices('nfl-kc-buf-2026-11-27', [KC, BUF])
  assert.equal(gamma(), 2)
})

test('prices: an unknown slug throws and is retried only after a minute', async () => {
  let now = 0
  const { fetch, calls } = fake({ [`${GAMMA}/markets?slug=nope`]: [], [`${GAMMA}/events?slug=nope`]: [] })
  const pm = createPolymarket({ fetch, clock: () => now })
  await assert.rejects(pm.prices('nope', [KC, BUF]), /Polymarket: no open market "nope"/)
  now = 59_000
  await assert.rejects(pm.prices('nope', [KC, BUF]), /no open market/)
  assert.equal(calls.length, 2)
  now = 60_000
  await assert.rejects(pm.prices('nope', [KC, BUF]), /no open market/)
  assert.equal(calls.length, 4)
})

test('prices: HTTP and network errors are readable', async () => {
  const { fetch } = fake({ [`${GAMMA}/markets?slug=nfl-kc-buf-2026-11-27`]: [MONEYLINE], [`${GAMMA}/markets?slug=down`]: new TypeError('fetch failed') })
  const pm = createPolymarket({ fetch })
  await assert.rejects(pm.prices('nfl-kc-buf-2026-11-27', [KC, BUF]), {
    message: 'Polymarket HTTP 404 /midpoint: No orderbook exists for the requested token id',
  })
  await assert.rejects(pm.prices('down', [KC, BUF]), { message: 'Polymarket unreachable (/markets): fetch failed' })
})

test('prices: a midpoint outside 0..1 throws', async () => {
  const { fetch } = fake({
    [`${GAMMA}/markets?slug=nfl-kc-buf-2026-11-27`]: [MONEYLINE],
    [`${CLOB}/midpoint?token_id=${token(MONEYLINE, 0)}`]: {},
  })
  await assert.rejects(createPolymarket({ fetch }).prices('nfl-kc-buf-2026-11-27', [KC, BUF]), /bad midpoint/)
})

// Hyperliquid testnet outcome → Polymarket slug for the demo, checked 22.11.2026. Run with LIVE=1.
const DEMO: [string, string, OutcomeSide, OutcomeSide][] = [
  ['27159', 'nfl-kc-buf-2026-11-27', KC, BUF],
  ['27150', 'nfl-phi-dal-2026-11-26', side('PHI', 'Philadelphia Eagles'), side('DAL', 'Dallas Cowboys')],
  ['27143', 'nfl-chi-det-2026-11-26', side('CHI', 'Chicago Bears'), side('DET', 'Detroit Lions')],
  ['27119', 'nfl-gb-la-2026-11-26', side('GB', 'Green Bay Packers'), LAR],
  ['27039', 'nfl-cin-was-2026-11-24', side('CIN', 'Cincinnati Bengals'), side('WSH', 'Washington Commanders')],
  ['26947', 'nfl-ari-kc-2026-11-22', side('ARI', 'Arizona Cardinals'), KC],
]

test('live: demo games price on Polymarket', { skip: !process.env.LIVE }, async () => {
  const pm = createPolymarket()
  for (const [outcome, slug, a, b] of DEMO) {
    const p = await pm.prices(slug, [a, b])
    assert.ok(p && p[0] > 0 && p[0] < 1, `${outcome} ${slug}: ${p}`)
    console.log(outcome, slug, `${a.name} ${p[0]} / ${b.name} ${p[1]}`)
  }
})
