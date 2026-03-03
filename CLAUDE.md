# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

```bash
# Docker (hot-reload, recommended for dev)
docker compose up --build   # first run
docker compose up           # subsequent runs (node --watch inside container)

# Node direct
npm install && node server.js
npm run dev   # hot-reload via node --watch
```

Server serves static files + WebSocket on http://localhost:3000

## Pages

| File | Route | Description |
|---|---|---|
| `index.html` | `/` | Landing — two mode buttons |
| `solo.html` | `/solo.html` | Standalone solo trainer (no server needed) |
| `multi.html` | `/multi.html` | Multiplayer client (WebSocket) |

## Architecture

```
browser                          Node.js server
──────────────────────           ──────────────────────────────
js/game.js      (WS client)  ←→  server.js          (HTTP + WS router)
js/game-solo.js (standalone)      server/game-engine.js  (authoritative FSM)
js/strategy.js  (intact)          server/persistence.js  (balances.json)
js/config.js    (WS_URL)          data/balances.json
```

**Principle**: server is the source of truth. It broadcasts a full `state` snapshot after every mutation. The client is a pure renderer that sends actions.

## Server files

### `server.js`
HTTP static file server + WebSocket router. Loads `token.txt` or `DETERMINOSS_TOKEN` env var for Determinoss. Maps incoming WS messages to `game-engine` functions.

### `server/game-engine.js`
Authoritative game logic:
- **FSM phases**: `IDLE → DEALING → INSURANCE? → PLAYER_TURN → DEALER_TURN → RESOLVING`
- **Auto-deal timer**: `BET_WINDOW_MS = 8000`. On entering IDLE, `_startBetTimer()` fires. At expiry: if any bet → `_autoDeal()`, else restart timer.
- `betDeadline` (epoch ms) is included in every broadcast so clients can animate a countdown bar.
- **Shoe**: 6-deck Fisher-Yates with sfc32 PRNG seeded by Determinoss `/seed`. Reshuffles when < 25% remains.
- **Sequential turns**: `activePlayerIdx` points to the active player; `advanceHand()` moves to next undone hand, then next player, then dealer.
- **Resolving**: payouts computed, `persistence.setBalance()` called per player, then `_enterIdle()` after 2s.

### `server/persistence.js`
Reads/writes `data/balances.json` synchronously. Default balance: **$1000**.

## Client files

### `js/config.js`
```js
window.Config = { DETERMINOSS_TOKEN: '', WS_URL: 'ws://localhost:3000' };
```

### `js/strategy.js` (unchanged)
Exposes `Strategy` object: `getAction()`, `getHandTotal()`, `getFullHandTotal()`, `renderCharts()`, `highlightRow()`, `clearHighlights()`, `cardValue()`.

### `js/game.js` (multiplayer client)
WebSocket client + renderer for `multi.html`. Key behaviors:
- Connects to `Config.WS_URL` on load. Reconnects on close.
- **Join screen**: pseudo input → `{ type: 'join', pseudo }` → server replies `welcome` → table shown.
- **`onState(state, prev)`**: called on every broadcast. Renders dealer, seats row, my hands, buttons, countdown bar, strategy highlight.
- **`renderSeats(state)`**: all players displayed in a compact row (`#table-seats`). Active player gets `active-seat` class + `▶` indicator. My seat gets `my-seat` + `★`.
- **Pre-select**: during another player's turn, action buttons are clickable. Clicking sets `preSelectedAction`. `_checkPreSelectTrigger()` fires the action when the turn switches to me.
- **Card animation fix**: `_prev = { dealer, hands[] }` tracks rendered card counts. Only cards at index ≥ previous count receive `.card-enter`. Reset on IDLE.
- **Bet countdown bar**: `updateBetTimer(state)` animates via `requestAnimationFrame` using `state.betDeadline`. Colors: violet → amber (<50%) → red (<25%).
- **Strategy feedback**: client-side only, same as solo. `checkActionFeedback()` compares chosen vs `Strategy.getAction()`.

### `js/game-solo.js` (standalone solo)
Original game logic (FSM, shoe, all actions). Loads only in `solo.html`. No WebSocket.

## WebSocket protocol

### Client → Server
```js
{ type: 'join',      pseudo }
{ type: 'bet',       amount }
{ type: 'clearBet' }
{ type: 'action',    action }   // 'hit'|'stand'|'double'|'split'|'surrender'
{ type: 'insurance', take: bool }
{ type: 'shuffle' }
```

### Server → Client
```js
{ type: 'welcome', pseudo, balance }   // unicast on join
{ type: 'state',   state }             // broadcast after every mutation
{ type: 'error',   message }           // unicast on invalid action
```

### State shape
```js
{
  phase:           'IDLE|DEALING|INSURANCE|PLAYER_TURN|DEALER_TURN|RESOLVING',
  betDeadline:     1234567890,   // epoch ms, null outside IDLE
  shoe:            { remaining: 312, runningCount: 0 },
  players: [{
    pseudo, balance, bet, insuranceBet,
    hands,           // [{ cards, bet, doubled, isAceSplit, fromSplit, surrendered, done }]
    activeHandIdx, splitCount, seatIndex, connected,
  }],
  activePlayerIdx: 0,
  dealerCards:     [],
  seedJpeg:        null,   // base64 lava-lamp frame during shuffle
}
```

## Key rules implemented

6 decks · S17 · DAS · late surrender · split up to 4 hands · no re-split aces · BJ pays 3:2 · insurance on dealer Ace

## Determinoss integration

The `/seed` endpoint returns `{ seed: "<hex>", age_ms, frame_jpeg? }`. The seed drives the sfc32 PRNG for the shoe shuffle. `frame_jpeg` (base64) is broadcast in `state.seedJpeg` during shuffle.

Token loading priority (server-side): `token.txt` → `DETERMINOSS_TOKEN` env var.
