# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

```bash
# Install (compiles better-sqlite3 native module)
npm install

# Node direct
node server.js      # production
npm run dev         # hot-reload via node --watch

# Docker
docker compose up --build   # first run
docker compose up           # subsequent runs
```

Server serves static files + WebSocket on **http://localhost:3000**

## Pages

| File | Route | Description |
|---|---|---|
| `index.html` | `/` | Landing — Solo / Multiplayer choice |
| `solo.html` | `/solo.html` | Standalone solo trainer (no server needed) |
| `multi.html` | `/multi.html` | Multiplayer client (WebSocket) |

## Architecture

```
browser                          Node.js server
──────────────────────           ──────────────────────────────────────
js/game.js      (WS client)  ←→  server.js              (HTTP + WS router)
js/game-solo.js (standalone)      server/game-engine.js  (authoritative FSM)
js/strategy.js  (intact)          server/db.js            (SQLite layer)
js/achievements-client.js         server/achievements-def.js (19 defs)
js/sounds.js    (Web Audio)       data/blackjackoss.db
js/config.js    (WS_URL)
```

**Principle**: server is the source of truth. It broadcasts a full `state` snapshot after every mutation. The client is a pure renderer that sends actions.

## Server files

### `server.js`
HTTP static file server + WebSocket router. Loads `token.txt` or `DETERMINOSS_TOKEN` env var for Determinoss. Maps incoming WS messages to `game-engine` functions. On join: sends `{ type:'achievements', list }` unicast before first state broadcast.

### `server/game-engine.js`
Authoritative game logic:
- **FSM phases**: `IDLE → DEALING → INSURANCE? → PLAYER_TURN → DEALER_TURN → RESOLVING`
- **Auto-deal timer**: `BET_WINDOW_MS = 8000`. On entering IDLE, `_startBetTimer()` fires. At expiry: if any bet → `_autoDeal()`, else restart timer.
- **All-AUTO shortcut**: if all connected players have `autoBet = true`, `_checkAllAutoAndSkip()` applies each player's `lastBet` and calls `_autoDeal()` immediately (400ms delay) without waiting for the timer.
- `betDeadline` (epoch ms) is included in every broadcast so clients can animate a countdown bar.
- **Player turn timer**: `PLAYER_TURN_MS = 10000`. Auto-stand at expiry. `playerDeadline` broadcast so clients animate the seat border.
- **Resolve timer**: `RESOLVE_MS = 4000`. `resolveDeadline` set in `_enterResolving()`.
- **Shoe**: 6-deck Fisher-Yates with sfc32 PRNG seeded by Determinoss `/seed`. Reshuffles when < 25% remains.
- **Sequential turns**: `activePlayerIdx` points to the active player; `_advanceHand()` moves to next undone hand, then next player, then dealer.
- **Dealer skip**: dealer does not draw if all active hands are bust or surrendered.
- **Resolving**: payouts computed, `db.setBalance()` called per player, `_processAchievements()` runs per player, then `_enterIdle()` after 4s.
- **Disconnect handling**: immediate removal in IDLE; auto-stand in PLAYER_TURN; auto insurance in INSURANCE.
- **ALL IN detection**: `p._wasAllIn = p.balance === p.bet` set in `_autoDeal()` before balance deduction.

### `server/db.js`
SQLite layer using `better-sqlite3` (synchronous API). DB file: `data/blackjackoss.db`.

Schema:
- `players(pseudo PK, balance, created_at)` — default balance $1000
- `player_stats(pseudo PK, hands_played, blackjacks, all_ins, all_in_wins, splits, doubles, surrenders, max_win_streak, max_loss_streak, max_balance, min_balance)` — updated after each hand
- `achievements(pseudo, achievement_id, unlocked_at)` — one row per unlock

Auto-migrates from `data/balances.json` on first run (renames to `balances.json.migrated`).

API: `ensurePlayer()`, `getBalance()`, `setBalance()`, `getStats()`, `updateStats(pseudo, delta)`, `unlockAchievement(pseudo, id)` (returns bool isNew), `getAchievements(pseudo)` (returns string[]).

### `server/achievements-def.js`
`ACHIEVEMENTS` array of 19 objects: `{ id, name, desc, reward: { type, value }, icon }`.
`checkAchievements(stats, context)` — pure function, returns matching achievement defs given current stats + context (isBlackjack, isDealerBust, isAllIn, isAllInWin, netResult).

## Client files

### `js/config.js`
```js
window.Config = { DETERMINOSS_TOKEN: '', WS_URL: 'ws://localhost:3000' };
```

### `js/strategy.js` (unchanged from solo)
Exposes `Strategy`: `getAction()`, `getHandTotal()`, `getFullHandTotal()`, `renderCharts()`, `highlightRow()`, `clearHighlights()`, `cardValue()`.

### `js/game.js` (multiplayer client)
WebSocket client + renderer for `multi.html`. Key behaviors:
- Connects to `Config.WS_URL` on load. Reconnects on close.
- **Join screen**: pseudo input → `{ type: 'join' }` → server `welcome` → table shown.
- **`onState(state, prev)`**: called on every broadcast. Renders dealer, seats, buttons, timers.
- **`renderSeats(state)`**: arc layout (`#table-seats`). My seat: `my-seat` + `★`. Active: `active-seat` + `▶`. Full cards for me, compact for others.
- **ALL IN tracking**: `_allInPlayers` Set. When `me_.balance === 0 && hands.length > 0` in DEALING → `.allin` on `#table-seats` (red gradient bg). On win: massive fireworks + special toast.
- **AUTO button**: sends `{ type:'setAutoBet', enabled }`. Guard prevents double-bet when server pre-applies lastBet in all-auto path.
- **NO INS button**: always active (not disabled during other phases).
- **Pre-select**: action buttons clickable during other player's turn for pre-selection. `_checkPreSelectTrigger()` auto-fires queued action when turn switches to me.
- **Countdown bars**: `updateBetTimer`, `updateResolveTimer`, `updatePlayerTimer` via RAF. Player turn border uses conic-gradient `::before` mask.
- **Achievements**: `AchievementsClient.init()` on load; handles `{ type:'achievements' }` and `{ type:'achievement_unlocked' }` WS messages.
- **Fireworks**: `_spawnFireworks(cx,cy)` for double wins (7 burst points spread across viewport); `_spawnMassiveFireworks()` for ALL IN wins (3 waves × up to 8 points).

### `js/sounds.js`
Web Audio API procedural sounds. All synthesized — no audio files.
- `win()` / `loss()` / `doubleWin()` / `blackjack()` — layered oscillators (sawtooth, square, sine, noise) with frequency sweeps and chords.

### `js/achievements-client.js`
`window.AchievementsClient` IIFE:
- **Toast queue**: `_showing` flag prevents overlapping toasts. 5s auto-dismiss, click to dismiss.
- `_applySkin(skinValue)`: removes all SKIN_CLASSES from `.game-table`, applies new one, persists to `localStorage('bj-skin')`.
- `_buildPanel()`: `#achievements-panel` overlay with grid of `.ach-card` (unlocked/locked states, apply buttons for skin rewards).
- API: `init(allAchievements)`, `setUnlocked(list)`, `onUnlocked(ach)`, `openPanel()`, `closePanel()`.

### `js/game-solo.js` (standalone)
Original solo game logic. Loads only in `solo.html`. No WebSocket.

## WebSocket protocol

### Client → Server
```js
{ type: 'join',       pseudo }
{ type: 'bet',        amount }
{ type: 'clearBet' }
{ type: 'action',     action }       // 'hit'|'stand'|'double'|'split'|'surrender'
{ type: 'insurance',  take: bool }
{ type: 'setAutoBet', enabled: bool }
{ type: 'shuffle' }
```

### Server → Client
```js
{ type: 'welcome',             pseudo, balance }         // unicast on join
{ type: 'achievements',        list: [{id,name,...}] }   // unicast on join
{ type: 'state',               state }                   // broadcast after every mutation
{ type: 'error',               message }                 // unicast on invalid action
{ type: 'achievement_unlocked', achievement }            // unicast on unlock
```

### State shape
```js
{
  phase:           'IDLE|DEALING|INSURANCE|PLAYER_TURN|DEALER_TURN|RESOLVING',
  betDeadline:     1234567890,   // epoch ms, null outside IDLE
  resolveDeadline: 1234567890,   // epoch ms, null outside RESOLVING
  playerDeadline:  1234567890,   // epoch ms, null outside PLAYER_TURN
  shoe:            { remaining: 312, runningCount: 0 },
  players: [{
    pseudo, balance, bet, insuranceBet,
    hands,           // [{ cards, bet, doubled, isAceSplit, fromSplit, surrendered, done }]
    activeHandIdx, splitCount, seatIndex, connected,
    autoBet,         // bool — auto-replay last bet
    lastBet,         // number — last bet amount for AUTO replay
  }],
  activePlayerIdx: 0,
  dealerCards:     [],
  seedJpeg:        null,   // base64 lava-lamp frame during shuffle
}
```

## Key rules implemented

6 decks · S17 · DAS · late surrender · split up to 4 hands · no re-split aces · BJ pays 3:2 · insurance on dealer Ace

## Data

```
data/
└── blackjackoss.db     # SQLite — players, player_stats, achievements (auto-created)
```

If `data/balances.json` exists (old format), it is migrated automatically on first run and renamed to `balances.json.migrated`.

## Achievements system

19 achievements defined in `server/achievements-def.js`, grouped by:
- **All In**: Tout ou Rien, All In Hero, Triple Fougue
- **Blackjack**: Natural, Favori des Dieux
- **Mains**: Quatuor, Maître du Split, David vs Goliath
- **Sessions**: Habitué (100), Vétéran (500), Légende (1000)
- **Balance**: High Roller ($5k), Millionnaire ($10k), Rock Bottom ($0)
- **Streaks**: En Feu (×5), Inarrêtable (×10)

Rewards: balance credit (+$X) or skin class unlocked on `.game-table`.

Flow: `_processAchievements(p, dealerBust)` runs in `_enterResolving()` → calls `checkAchievements()` → unlocks new ones → credits balance if needed → sends `achievement_unlocked` unicast → client shows Steam-style toast + updates gallery.

## Skin themes

13 CSS themes applied as a class on `.game-table`:
`theme-fire`, `theme-volcano`, `theme-kaleidoscope`, `theme-underdog`, `theme-zen`, `theme-veteran`, `theme-pain`, `theme-legend`, `theme-streak`, `theme-vip`, `theme-gold`, `theme-ashes`, `theme-divine`

Selected via the `🏆` achievements panel. Persisted in `localStorage('bj-skin')`.

## Determinoss integration

The `/seed` endpoint returns `{ seed: "<hex>", age_ms, frame_jpeg? }`. The seed drives the sfc32 PRNG for the shoe shuffle. `frame_jpeg` (base64) is broadcast in `state.seedJpeg` during shuffle.

Token loading priority (server-side): `token.txt` → `DETERMINOSS_TOKEN` env var.
