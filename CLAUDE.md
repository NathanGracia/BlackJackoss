# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

No build step — pure vanilla HTML/CSS/JS.

```bash
npx serve .        # http://localhost:3000  (recommended: avoids CORS issues on file://)
python -m http.server 8080   # alternative
```

Or just open `index.html` directly in a browser (Determinoss seed fetch may fail due to CORS).

## Architecture

Three IIFEs loaded in order via `<script>` tags:

1. **`js/config.js`** — exposes `window.Config.DETERMINOSS_TOKEN`. The token can also be loaded at runtime from a `token.txt` file served alongside `index.html` (gitignored). Token is optional; the game falls back to `Math.random()`.

2. **`js/strategy.js`** — exposes the `Strategy` object. Owns:
   - Raw strategy tables (`HARD_TABLE`, `SOFT_TABLE`, `PAIRS_TABLE`) for 6-deck S17 DAS Surrender
   - `getAction(hand, dealerUpcard, opts)` — returns `{ action, tableType, rowKey }` where action is `H/S/D/P/R`
   - `getHandTotal` / `getFullHandTotal` — hand scoring (soft ace handling)
   - `renderCharts()` — builds the three HTML strategy tables (`#chart-hard`, `#chart-soft`, `#chart-pairs`)
   - `highlightRow(tableType, rowKey)` / `clearHighlights()` — cyan highlight on the active strategy row

3. **`js/game.js`** — exposes the `Game` object. Owns everything else:
   - **FSM phases**: `IDLE → DEALING → INSURANCE? → PLAYER_TURN → DEALER_TURN → RESOLVING`
   - **Shoe**: 6-deck Fisher-Yates shuffle seeded by the Determinoss API (hex seed → sfc32 PRNG). Reshuffles when < 25% remains.
   - **State**: `{ phase, shoe, runningCount, balance, bet, insuranceBet, hands[], activeHandIdx, dealerCards[], splitCount }`
   - **Hi-Lo counting**: RC updated on every dealt/revealed card; TC = RC ÷ (shoe.length / 52)
   - **Modes**: `simple` (hides counting stats) vs `hard` (shows RC/TC/decks/shoe bar)
   - **Strategy feedback**: after each player action, compares against `Strategy.getAction()` and shows correct/incorrect feedback in `#strategy-feedback`; wrong-move row highlight persists until next deal
   - **History panel**: last N rounds stored in `handHistory[]` with net P&L, wrong-move flag, and per-action log

## Key rules implemented

6 decks · S17 · DAS · late surrender · split up to 4 hands · no re-split aces · BJ pays 3:2 · insurance on dealer Ace

## Determinoss integration

The `/seed` endpoint returns `{ seed: "<hex>", age_ms, frame_jpeg? }`. The seed drives the sfc32 PRNG for the shoe shuffle. `frame_jpeg` (base64) is displayed as a lava-lamp overlay during shuffle. Without a token, `frame_jpeg` is unavailable but the seed endpoint still works (no authentication required for the seed itself, only for the frame).

Token loading priority: `token.txt` (fetched at runtime, gitignored) → `window.Config.DETERMINOSS_TOKEN` (in `config.js`, also should not be committed with a real token).
