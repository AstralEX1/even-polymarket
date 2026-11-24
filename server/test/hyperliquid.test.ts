import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertTestnet, createHyperliquid } from '../src/hyperliquid.ts'
import { signL1 } from '../src/sign.ts'

const BASE = 'https://api.hyperliquid-testnet.xyz'
const ACCOUNT = '0x00000000000000000000000000000000000a11ce'
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123' // Python SDK test key
const NOW = Date.UTC(2026, 10, 22, 16, 0)

// Trimmed from the real testnet outcomeMeta of 2026-11-22.
const outcomeMeta = {
  outcomes: [
    { outcome: 27234, name: 'Recurring', description: 'class:priceBinary|underlying:BTC|expiry:20261123-0300|targetPrice:60393|period:1d', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
    { outcome: 27235, name: 'Recurring', description: 'class:priceBinary|underlying:ETH|expiry:20261123-0300|targetPrice:1678.3|period:1d', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
    // Not in the sample: yesterday's and tomorrow's BTC dailies, shaped like 27234.
    { outcome: 27100, name: 'Recurring', description: 'class:priceBinary|underlying:BTC|expiry:20261122-0300|targetPrice:61000|period:1d', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
    { outcome: 27300, name: 'Recurring', description: 'class:priceBinary|underlying:BTC|expiry:20261124-0300|targetPrice:59999.5|period:1d', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
    { outcome: 26947, name: 'template:sportsContestWinner7', description: 'competition:NFL|contestType:game|officialSource:NFL|participantA:Arizona Cardinals|participantB:Kansas City Chiefs|resolutionDeadline:20261125-1800|scheduledStart:20261122-1800|season:2026|shortNameA:ARI|shortNameB:KC|sport:American football|stage:Week 11', sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }], quoteToken: 'USDC', venue: 'flip', deployerFeeScale: '1.0' },
    { outcome: 24274, name: 'template:sportsContestWinner7', description: 'competition:NBA|contestType:game|officialSource:ESPN|participantA:Atlanta Hawks|participantB:Dallas Mavericks|resolutionDeadline:20261017-0600|scheduledStart:20261017-0000|season:2027|shortNameA:Hawks|shortNameB:Mavericks|sport:basketball|stage:Preseason', sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }], quoteToken: 'USDC', venue: 'wren', deployerFeeScale: '1.0' },
    { outcome: 11629, name: 'template:sportsContestWinner', description: 'competition:US Midterms|contestType:race for Senate control|officialSource:https://www.congress.gov/|participantA:Democrats|participantB:Republicans|resolutionDeadline:20270215-1200|scheduledStart:20261104-0500|season:2026|sport:Politics|stage:Senate Control', sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }], quoteToken: 'USDC', venue: 'mkr' },
    { outcome: 10233, name: 'Argentina', description: 'This outcome resolves to Yes if Argentina is officially declared the 2026 HYPURR World Cup champion.', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
    { outcome: 27242, name: 'Recurring Named Outcome', description: 'index:0', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
    { outcome: 11074, name: 'template:binaryPrice', description: 'perp:BTC|threshold:100000|time:20261231-0000', sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }], quoteToken: 'USDC', venue: 'ar' },
    { outcome: 25500, name: 'template:priceTouch', description: 'perp:BTC|priceDescription:Hyperliquid BTC perp mark price|seconds:60|target:100000|time:20261231-1659', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC' },
    { outcome: 27203, name: 'template:sportsContestParticipant5', description: 'participant:Real Madrid', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC', venue: 'ae' },
  ],
  questions: [],
}

// Real spotClearinghouseState shape (trimmed) of an address that traded #272340 on testnet.
const spotState = {
  balances: [
    { coin: 'USDC', token: 0, total: '953.97256222', hold: '0.0', entryNtl: '0.0' },
    { coin: '+272340', total: '21.0', hold: '0.0', entryNtl: '10.70979' },
    { coin: '+272351', total: '0.0', hold: '0.0', entryNtl: '0.0' },
  ],
}

// Real l2Book of #272340.
const book = { coin: '#272340', time: 1795334213882, levels: [[{ px: '0.49999', sz: '23.0', n: 2 }], [{ px: '0.51', sz: '3.0', n: 1 }, { px: '0.51999', sz: '20.0', n: 1 }]] }

type Call = { url: URL; body: any; init: RequestInit }
const CLOID = '0x0000000000000000000000000000beef'

function client(reply: (path: string, body: any) => unknown, now = () => NOW) {
  const calls: Call[] = []
  const sleeps: number[] = []
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init.body))
    calls.push({ url, body, init })
    const r = reply(url.pathname, body)
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 })
  }) as typeof globalThis.fetch
  const venue = createHyperliquid({ base: BASE, account: ACCOUNT, agentKey: KEY, fetch, clock: now, sleep: async ms => { sleeps.push(ms) }, cloid: () => CLOID })
  return { venue, calls, sleeps }
}

const byType = (routes: Record<string, unknown>) => (_: string, body: any) => routes[body.type]

test('numeric key: sports title, side names and full names', async () => {
  const { venue, calls } = client(byType({ outcomeMeta }))
  assert.deepEqual(await venue.markets(['26947']), [{
    key: '26947',
    outcome: 26947,
    title: 'ARI vs KC',
    sides: [
      { name: 'ARI', fullName: 'Arizona Cardinals', coin: '#269470', token: '+269470', asset: 100269470 },
      { name: 'KC', fullName: 'Kansas City Chiefs', coin: '#269471', token: '+269471', asset: 100269471 },
    ],
    startsAt: Date.UTC(2026, 10, 22, 18, 0),
    endsAt: Date.UTC(2026, 10, 25, 18, 0),
  }])
  assert.deepEqual(calls[0].body, { type: 'outcomeMeta' })
  assert.equal(calls[0].url.href, `${BASE}/info`)
})

test('daily:BTC picks the nearest BTC daily still open', async () => {
  const [m] = await client(byType({ outcomeMeta })).venue.markets(['daily:BTC'])
  assert.equal(m.key, 'daily:BTC')
  assert.equal(m.outcome, 27234)
  assert.equal(m.title, 'BTC >= 60,393')
  assert.deepEqual(m.sides.map(s => [s.name, s.fullName, s.coin]), [['Yes', 'Yes', '#272340'], ['No', 'No', '#272341']])
  assert.equal(m.endsAt, Date.UTC(2026, 10, 23, 3, 0))

  const later = await client(byType({ outcomeMeta }), () => Date.UTC(2026, 10, 23, 4, 0)).venue.markets(['daily:BTC'])
  assert.equal(later[0].outcome, 27300)
  assert.equal(later[0].title, 'BTC >= 59,999.5')
})

test('past, unknown and unmatched keys are left out, order kept', async () => {
  const markets = await client(byType({ outcomeMeta })).venue.markets(['24274', '99999', 'daily:DOGE', 'nonsense', '10233', 'daily:ETH'])
  assert.deepEqual(markets.map(m => [m.key, m.title, m.endsAt]), [
    ['10233', 'Argentina', 0],
    ['daily:ETH', 'ETH >= 1,678.3', Date.UTC(2026, 10, 23, 3, 0)],
  ])
})

test('Yes / No sides of a participant contest keep their own names', async () => {
  const [m] = await client(byType({ outcomeMeta })).venue.markets(['11629'])
  assert.equal(m.title, 'Democrats vs Republicans')
  assert.deepEqual(m.sides.map(s => [s.name, s.fullName]), [['Yes', 'Yes'], ['No', 'No']])
})

test('template names fall back to the description', async () => {
  const [m] = await client(byType({ outcomeMeta })).venue.markets(['27242'])
  assert.equal(m.title, 'index:0')
})

test('outcomeMeta is cached for 60 s', async () => {
  let now = NOW
  const { venue, calls } = client(byType({ outcomeMeta }), () => now)
  await venue.markets(['26947'])
  now += 59_000
  await venue.markets(['daily:BTC'])
  assert.equal(calls.length, 1)
  now += 2_000
  await venue.markets(['daily:BTC'])
  assert.equal(calls.length, 2)
})

test('mids keep only outcome coins', async () => {
  const { venue } = client(byType({ allMids: { '#272340': '0.504995', '#272341': '0.495005', BTC: '84000.5', '@1': '1.0936' } }))
  assert.deepEqual(await venue.mids(), { '#272340': 0.504995, '#272341': 0.495005 })
})

test('account reads spot USDC and outcome holdings of the master address', async () => {
  const { venue, calls } = client(byType({ spotClearinghouseState: spotState }))
  assert.deepEqual(await venue.account(), { usdc: 953.97256222, holdings: [{ token: '+272340', shares: 21, cost: 10.70979 }] })
  assert.deepEqual(calls[0].body, { type: 'spotClearinghouseState', user: ACCOUNT })
})

test('best: lowest ask for Buy, highest bid for Sell, null when empty', async () => {
  const { venue, calls } = client(byType({ l2Book: book }))
  assert.equal(await venue.best('#272340', 'Buy'), 0.51)
  assert.equal(await venue.best('#272340', 'Sell'), 0.49999)
  assert.deepEqual(calls[0].body, { type: 'l2Book', coin: '#272340' })
  const empty = client(byType({ l2Book: { coin: '#1', time: 1, levels: [[], []] } })).venue
  assert.equal(await empty.best('#1', 'Buy'), null)
  assert.equal(await empty.best('#1', 'Sell'), null)
})

const filled = { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '20.0', avgPx: '0.5105', oid: 77747314 } }] } } }

test('order sends a signed IOC limit with wire strings, a client order id and an expiry', async () => {
  const { venue, calls } = client(() => filled)
  assert.deepEqual(await venue.order(100272340, 'Buy', 20, 0.51999), { shares: 20, avgPrice: 0.5105 })
  const [call] = calls
  assert.equal(call.url.href, `${BASE}/exchange`)
  const action = {
    type: 'order',
    orders: [{ a: 100272340, b: true, p: '0.52', s: '20', r: false, t: { limit: { tif: 'Ioc' } }, c: CLOID }],
    grouping: 'na',
  }
  const expiresAfter = NOW + 10_000
  assert.deepEqual(call.body, { action, nonce: NOW, signature: signL1(KEY, action, NOW, false, null, expiresAfter), vaultAddress: null, expiresAfter })
  assert.deepEqual(Object.keys(call.body.action), ['type', 'orders', 'grouping'])
  assert.deepEqual(Object.keys(call.body.action.orders[0]), ['a', 'b', 'p', 's', 'r', 't', 'c'])
  assert.match(call.body.signature.r, /^0x[0-9a-f]{1,64}$/)
  assert.match(call.body.signature.s, /^0x[0-9a-f]{1,64}$/)
  assert.ok([27, 28].includes(call.body.signature.v))
  assert.ok(call.init.signal instanceof AbortSignal)
})

test('limit price rounds to 4 decimals toward the book', async () => {
  const { venue, calls } = client(() => filled)
  await venue.order(100272341, 'Sell', 3, 0.49999)
  await venue.order(100272341, 'Buy', 3, 0.52) // 0.52 * 1e4 is 5200.000000000001 in floats
  await venue.order(100272341, 'Sell', 3, 0.5)
  assert.deepEqual(calls.map(c => [c.body.action.orders[0].b, c.body.action.orders[0].p]), [[false, '0.4999'], [true, '0.52'], [false, '0.5']])
})

test('order errors carry the exchange message', async () => {
  const noMatch = { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match against any resting orders. asset=100272340' }] } } }
  await assert.rejects(client(() => noMatch).venue.order(100272340, 'Buy', 5, 0.4), { message: noMatch.response.data.statuses[0].error })
  const err = { status: 'err', response: 'User or API Wallet 0xabc does not exist.' }
  await assert.rejects(client(() => err).venue.order(100272340, 'Buy', 5, 0.4), { message: 'User or API Wallet 0xabc does not exist.' })
})

test('fractional or zero shares are refused before sending', async () => {
  const { venue, calls } = client(() => filled)
  await assert.rejects(venue.order(100272340, 'Buy', 1.5, 0.5), /positive whole number/)
  await assert.rejects(venue.order(100272340, 'Buy', 0, 0.5), /positive whole number/)
  assert.equal(calls.length, 0)
})

test('HTTP errors name the status and body', async () => {
  const { venue } = client(() => new Response('null', { status: 500 }))
  await assert.rejects(venue.best('#999990', 'Buy'), { message: 'Hyperliquid HTTP 500: null' })
})

test('assertTestnet accepts only the testnet host over https', () => {
  assertTestnet('https://api.hyperliquid-testnet.xyz')
  assertTestnet('https://api.hyperliquid-testnet.xyz/')
  assert.throws(() => assertTestnet('https://api.hyperliquid.xyz'))
  assert.throws(() => assertTestnet('https://api.hyperliquid-testnet.xyz.evil.com'))
  assert.throws(() => assertTestnet('https://evil.com/api.hyperliquid-testnet.xyz'))
  assert.throws(() => assertTestnet('http://api.hyperliquid-testnet.xyz'))
  assert.throws(() => createHyperliquid({ base: 'https://api.hyperliquid.xyz', account: ACCOUNT, agentKey: KEY }))
})

test('template outcomes get a readable title', async () => {
  const ms = await client(byType({ outcomeMeta })).venue.markets(['11074', '25500', '27203'])
  assert.deepEqual(ms.map(m => m.title), ['BTC >= 100,000', 'BTC touches 100,000', 'Real Madrid'])
})

test('an order whose reply is lost stays an unknown result while the book cannot be asked; a 4xx is a refusal', async () => {
  const dropped = client(() => { throw new TypeError('fetch failed') })
  await assert.rejects(dropped.venue.order(100272340, 'Buy', 5, 0.4), { name: 'UnknownResult', message: 'fetch failed' })
  const gateway = client(() => new Response('bad gateway', { status: 502 }))
  await assert.rejects(gateway.venue.order(100272340, 'Buy', 5, 0.4), { name: 'UnknownResult' })
  const refused = client(() => new Response('{"error":"bad"}', { status: 422 }))
  await assert.rejects(refused.venue.order(100272340, 'Buy', 5, 0.4), (e: Error) => e.name === 'Error' && /HTTP 422/.test(e.message))
  assert.equal(refused.calls.length, 1) // a sure refusal does not ask the book
})

/** The order request is lost; reads answer from `routes`. */
const lostReply = (routes: Record<string, unknown>) => client((path, body) => {
  if (path === '/exchange') throw new TypeError('fetch failed')
  return routes[body.type]
})

test('a lost reply waits out the expiry, then the book says the order never arrived', async () => {
  const { venue, calls, sleeps } = lostReply({ orderStatus: { status: 'unknownOid' } })
  await assert.rejects(venue.order(100272340, 'Buy', 20, 0.52), (e: Error) => e.name === 'Error' && /never reached Hyperliquid/.test(e.message))
  assert.deepEqual(sleeps, [12_000]) // expiresAfter (nonce + 10 s) + 2 s for clock skew
  assert.deepEqual(calls[1].body, { type: 'orderStatus', user: ACCOUNT, oid: CLOID })
  assert.equal(calls.length, 2)
})

test('a lost reply of an order that filled is summed from its own fills', async () => {
  const { venue } = lostReply({
    orderStatus: { status: 'order', order: { order: { oid: 42 }, status: 'filled' } },
    userFills: [{ oid: 42, px: '0.51', sz: '15' }, { oid: 7, px: '0.9', sz: '100' }, { oid: 42, px: '0.52', sz: '5' }],
  })
  const f = await venue.order(100272340, 'Buy', 20, 0.52)
  assert.equal(f.shares, 20)
  assert.ok(Math.abs(f.avgPrice - 0.5125) < 1e-12)
})

test('a lost reply of an order that reached the book without a fill is a sure "not filled"', async () => {
  const { venue } = lostReply({ orderStatus: { status: 'order', order: { order: { oid: 42 }, status: 'canceled' } }, userFills: [{ oid: 7, px: '0.9', sz: '1' }] })
  await assert.rejects(venue.order(100272340, 'Buy', 20, 0.52), (e: Error) => e.name === 'Error' && /did not fill/.test(e.message))
})

test('settlements: settlement fills at or after a time, summed by spot token', async () => {
  // The three settlements are trimmed from testnet userFills of 2026-11-23/24; the sale is a plain trade.
  const fills = [
    { coin: '#273760', px: '0.0', sz: '72.0', side: 'A', dir: 'Settlement', closedPnl: '-35.28', time: 1795442406106, oid: 65835645930 },
    { coin: '#273761', px: '1.0', sz: '68.0', side: 'A', dir: 'Settlement', closedPnl: '34.68', time: 1795442406106, oid: 65835645932 },
    { coin: '#272341', px: '0.0', sz: '3.0', side: 'A', dir: 'Settlement', closedPnl: '-1.47', time: 1795402812933, oid: 65822469377 },
    { coin: '#273220', px: '0.49', sz: '9.0', side: 'A', dir: 'Sell', closedPnl: '-0.18', time: 1795442406500, oid: 1 },
  ]
  const { venue, calls } = client(byType({ userFills: fills }))
  assert.deepEqual(await venue.settlements(1795440000000), { '+273760': -35.28, '+273761': 34.68 })
  assert.deepEqual(calls[0].body, { type: 'userFills', user: ACCOUNT })
})

test('upcoming: games kicking off within a week or begun within 4 h, soonest first; not dailies, props or old games', async () => {
  const games = await client(byType({ outcomeMeta })).venue.upcoming()
  assert.deepEqual(games.map(g => [g.key, g.title, g.startsAt]), [['26947', 'ARI vs KC', Date.UTC(2026, 10, 22, 18, 0)]])
  const later = await client(byType({ outcomeMeta }), () => Date.UTC(2026, 10, 22, 23, 0)).venue.upcoming()
  assert.equal(later.length, 0) // 5 h after kick-off it is taken as over
})
