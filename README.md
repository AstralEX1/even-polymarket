# Sideline Odds (even-polymarket)

Live odds and your bet on Even Realities G2 glasses. Polymarket gives the live odds, and the order goes to a Hyperliquid **testnet** outcome market. You say "20 on KC" and tap YES.

## Architecture

```
G2 glasses ──BLE── Even app WebView (app/)  ──HTTP + Bearer──▶  server/ (Node 22, no framework)
  text page / card + No|Yes list               GET  /api/state           ├─ session.ts  tick every 2 s: markets, mids, account, odds → rules → cards
  mic PCM 16 kHz → endpointer                  POST /api/answer          ├─ rules.ts    swing / cash-out cards, limits, equity
  phone page: server, token, limits            POST /api/voice           ├─ hyperliquid.ts  testnet /info + signed /exchange (IOC limit)
                                               GET|PUT /api/config       ├─ sign.ts     L1 action signing (msgpack + keccak + secp256k1)
                                                                         ├─ polymarket.ts   Gamma slug → CLOB midpoint
                                                                         ├─ stt.ts      OpenAI gpt-4o-mini-transcribe (optional)
                                                                         └─ fake.ts     scripted venue + odds for VENUE=fake
```

- The app holds no keys. The server holds the Hyperliquid **API wallet** key: it can trade but cannot withdraw.
- `assertTestnet` stops the server on any host other than `https://api.hyperliquid-testnet.xyz`.
- A YES runs these checks again on the server: card id and expiry, data younger than 10 s, daily-loss lock, cool-down, max bet at the worst fill price, and best price within slippage. Then it sends an IOC limit order with a client order id (`cloid`) and `expiresAfter` = nonce + 10 s.
- If the reply is lost (timeout, dropped connection or 5xx), the server waits until the order's expiry has passed, then asks `orderStatus` by `cloid` and sums `userFills` for that order. The result is a definite answer: never arrived, did not fill, or filled N at an average price. The answer is "unknown result" only when those reads fail too.
- Limits: lowering one applies at once, and raising one waits 24 h (`applyLimits`). The day's lock and cool-down survive a restart (`server/data/day.json`, atomic write).

## Run

Requires Node ≥ 22.18 (runs `.ts` directly).

```bash
npm install
cp .env.example .env        # set APP_TOKEN
npm run server              # :8788, VENUE=fake: no keys, scripted market
npm run dev                 # app on :5174
npm run sim                 # Even Hub simulator → http://localhost:5174
```

On the phone page, set the server to `http://localhost:8788` and the token to `APP_TOKEN`.

Live testnet: set `VENUE=hyperliquid`, `HL_ACCOUNT` (your testnet address) and `HL_AGENT_KEY` (from app.hyperliquid-testnet.xyz/API). Voice needs `OPENAI_API_KEY`.

### Real glasses

The app runs in the Even app's WebView on the phone, where `localhost` is the phone itself. The server stays on your machine (keys and the day boundary stay local) and is reached through an https tunnel:

```bash
tailscale funnel 8788                              # stable https://<machine>.<tailnet>.ts.net
# or: cloudflared tunnel --url http://127.0.0.1:8788   (new URL on every run: re-pack)
```

Set `PUBLIC_URL` to that address and `APP_TOKEN` to 16+ characters; the server refuses to start with a shorter one. Then run:

```bash
npm run pack      # build; whitelists PUBLIC_URL's origin and makes it the default server → sideline-odds.ehpk
```

## Test and build

```bash
npm test          # node --test (the live test runs only with LIVE=1)
npm run typecheck
npm run build     # app/dist
npm run pack      # app/dist → sideline-odds.ehpk (see Real glasses)
npm run e2e       # ~45 s in the simulator on the fake venue: the demo's swing card, cash out on the glasses list, server says "Sold"
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests and pack on every push to main and every PR. The e2e needs a display (it opens the simulator window), so it runs locally only.

## Layout

| Path | What |
|---|---|
| `server/src` | session, rules, venue (Hyperliquid), odds (Polymarket), HTTP, STT, config and limits |
| `server/test` | unit tests with fake fetch and clock; signing vectors from the Hyperliquid Python SDK |
| `app/src` | glasses UI (`main.ts`, `view.ts`), exit dialogue (`exit.ts`), voice end-pointing (`endpoint.ts`), API client |
| `app/test` | render limits, exit dialogue, endpointer, market parsing |
| `docs/screenshots` | simulator frames |

## Known limitations

- A lost settlement is read from its `userFills` entry (`dir: "Settlement"`, realised PnL). A holding that vanished without one, such as a sale on the web, is still judged by USDC over one 2 s tick, so a transfer at the same moment blurs it (`session.ts`).
- The day boundary uses the server's time zone, which is correct while the server runs on the user's machine.
- Resolving a lost reply assumes this machine's clock is at most 2 s ahead of Hyperliquid's (`EXPIRY_MARGIN_MS`).
- Speech end-pointing uses a fixed noise-floor ratio and is not tuned on real glasses.
- The default market (`27159`, KC vs BUF, 27 Nov 2026) expires. `daily:BTC` rolls over by itself.
