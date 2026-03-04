'use strict';

const https       = require('https');
const http        = require('http');
const persistence = require('./persistence');

// ─── constants ────────────────────────────────────────────────────────────────
const NUM_DECKS     = 6;
const TOTAL_CARDS   = NUM_DECKS * 52;
const RESHUFFLE_PCT = 0.25;
const SUITS  = ['♠','♥','♦','♣'];
const RANKS  = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const HI_LO  = { '2':1,'3':1,'4':1,'5':1,'6':1,'7':0,'8':0,'9':0,'T':-1,'J':-1,'Q':-1,'K':-1,'A':-1 };
const SEED_URL      = 'https://determinoss.nathangracia.com/seed';
const BET_WINDOW_MS = 8000;  // betting window before auto-deal

const PHASE = { IDLE:'IDLE', DEALING:'DEALING', INSURANCE:'INSURANCE',
                PLAYER_TURN:'PLAYER_TURN', DEALER_TURN:'DEALER_TURN', RESOLVING:'RESOLVING' };

const PLAYER_TURN_MS = 10000; // auto-stand after 10s

// ─── sfc32 PRNG ───────────────────────────────────────────────────────────────
function _makeSfc32(a, b, c, d) {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    let t = (a + b | 0) + d | 0;
    d = d + 1 | 0; a = b ^ b >>> 9;
    b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}
function _rngFromHex(hex) {
  return _makeSfc32(
    parseInt(hex.slice(0,8),16), parseInt(hex.slice(8,16),16),
    parseInt(hex.slice(16,24),16), parseInt(hex.slice(24,32),16)
  );
}

// ─── hand helpers ─────────────────────────────────────────────────────────────
function cardValue(c) {
  if (c.rank === 'A') return 11;
  if ('TJQK'.includes(c.rank)) return 10;
  return parseInt(c.rank, 10);
}

function getHandTotal(cards, skipFaceDown = true) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (skipFaceDown && c.faceDown) continue;
    const v = cardValue(c); total += v;
    if (c.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, isSoft: aces > 0, isBust: total > 21 };
}

function isBlackjack(cards) {
  const vis = cards.filter(c => !c.faceDown);
  if (vis.length !== 2) return false;
  const vals = vis.map(cardValue);
  return (vals[0]===11&&vals[1]===10)||(vals[0]===10&&vals[1]===11);
}

function _dealerHasBJ(cards) {
  if (cards.length !== 2) return false;
  const vals = cards.map(cardValue);
  return (vals[0]===11&&vals[1]===10)||(vals[0]===10&&vals[1]===11);
}

// ─── shoe fetch ───────────────────────────────────────────────────────────────
function _fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e){ reject(e); } });
    }).on('error', reject);
  });
}

// ─── state ────────────────────────────────────────────────────────────────────
let state = {
  phase:           PHASE.IDLE,
  shoe:            [],
  runningCount:    0,
  players:         [],
  activePlayerIdx: 0,
  dealerCards:     [],
  betDeadline:     null,  // epoch ms — end of betting window
  resolveDeadline: null,  // epoch ms — end of resolving phase
  playerDeadline:  null,  // epoch ms — end of current player's turn
};

let _betTimerHandle    = null;
let _playerTimerHandle = null;

let _broadcastFn = null;  // injected by server.js
let _seedJpeg    = null;  // last frame_jpeg from Determinoss (for broadcast)

function setBroadcastFn(fn) { _broadcastFn = fn; }

function broadcast() {
  if (_broadcastFn) _broadcastFn(buildPublicState());
}

function buildPublicState() {
  return {
    phase:           state.phase,
    betDeadline:     state.betDeadline,
    resolveDeadline: state.resolveDeadline,
    playerDeadline:  state.playerDeadline,
    shoe:  { remaining: state.shoe.length, runningCount: state.runningCount },
    players: state.players.map(p => ({
      pseudo:       p.pseudo,
      balance:      p.balance,
      bet:          p.bet,
      insuranceBet: p.insuranceBet,
      hands:        p.hands,
      activeHandIdx:p.activeHandIdx,
      splitCount:   p.splitCount,
      seatIndex:    p.seatIndex,
      connected:    p.connected,
      readyToDeal:  p.bet > 0,
    })),
    activePlayerIdx: state.activePlayerIdx,
    dealerCards:     state.dealerCards,
    seedJpeg:        _seedJpeg,
  };
}

// ─── shoe ─────────────────────────────────────────────────────────────────────
async function initShoe(token) {
  let rng = Math.random;
  _seedJpeg = null;
  try {
    const url  = token ? `${SEED_URL}?token=${encodeURIComponent(token)}` : SEED_URL;
    const json = await _fetchJson(url);
    if (!json || !json.seed) {
      console.warn('[Shoe] Unexpected API response:', JSON.stringify(json));
      throw new Error('No seed field in response');
    }
    rng = _rngFromHex(json.seed);
    if (json.frame_jpeg) _seedJpeg = json.frame_jpeg;
    console.info(`[Shoe] seed ${json.seed.slice(0,16)}…`);
  } catch(e) {
    console.warn('[Shoe] seed fetch failed, using Math.random:', e.message);
  }
  const shoe = [];
  for (let d = 0; d < NUM_DECKS; d++)
    for (const suit of SUITS)
      for (const rank of RANKS)
        shoe.push({ rank, suit });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i+1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  state.shoe = shoe;
  state.runningCount = 0;
}

function needsReshuffle() {
  return state.shoe.length < TOTAL_CARDS * RESHUFFLE_PCT;
}

function dealCard(faceDown = false) {
  const card = { ...state.shoe.pop(), faceDown };
  if (!faceDown) state.runningCount += HI_LO[card.rank];
  return card;
}

function revealCard(card) {
  if (!card || !card.faceDown) return;
  card.faceDown = false;
  state.runningCount += HI_LO[card.rank];
}

// ─── player management ────────────────────────────────────────────────────────
function playerJoin(pseudo) {
  let p = state.players.find(pl => pl.pseudo === pseudo);
  if (p) {
    p.connected = true;
  } else {
    const balance = persistence.getBalance(pseudo);
    p = {
      pseudo, balance, bet: 0, insuranceBet: 0,
      hands: [], activeHandIdx: 0, splitCount: 0,
      seatIndex: state.players.length,
      connected: true, readyToDeal: false,
    };
    state.players.push(p);
  }
  // Start bet timer if we're idle and no timer running
  if (state.phase === PHASE.IDLE && !state.betDeadline) _startBetTimer();
  return p;
}

function playerDisconnect(pseudo) {
  const idx = state.players.findIndex(pl => pl.pseudo === pseudo);
  if (idx === -1) return;
  const p = state.players[idx];

  // IDLE: remove immediately — no ongoing game, clean exit
  if (state.phase === PHASE.IDLE) {
    state.players.splice(idx, 1);
    state.players.forEach((pl, i) => { pl.seatIndex = i; });
    broadcast();
    return;
  }

  // Mid-game: mark disconnected, will be removed at next IDLE
  p.connected = false;
  if (!p._insuranceDecided) p._insuranceDecided = true; // auto no-insurance
  broadcast();

  // Unblock PLAYER_TURN: auto-stand so the game doesn't freeze
  if (state.phase === PHASE.PLAYER_TURN &&
      state.players[state.activePlayerIdx]?.pseudo === pseudo) {
    const hand = p.hands[p.activeHandIdx];
    if (hand && !hand.done) {
      _clearPlayerTimer();
      hand.done = true;
      _advanceHand(p);
    }
  }

  // Unblock INSURANCE: if all remaining connected players have now decided, proceed
  if (state.phase === PHASE.INSURANCE) {
    const active = state.players.filter(pl => pl.hands.length > 0 && pl.connected);
    if (active.length === 0) { _enterResolving(); return; }
    if (active.every(pl => pl._insuranceDecided)) {
      _continueAfterInsurance().catch(console.error);
    }
  }
}

function getPlayer(pseudo) {
  return state.players.find(p => p.pseudo === pseudo);
}

// ─── betting ──────────────────────────────────────────────────────────────────
function playerBet(pseudo, amount) {
  if (state.phase !== PHASE.IDLE) return { error: 'Not in IDLE' };
  const p = getPlayer(pseudo);
  if (!p) return { error: 'Unknown player' };
  if (p.balance <= 0) return { error: 'No balance' };
  const actual = Math.min(amount, p.balance);
  p.bet = Math.min(p.bet + actual, p.balance);
  broadcast();
  return {};
}

function playerClearBet(pseudo) {
  if (state.phase !== PHASE.IDLE) return { error: 'Not in IDLE' };
  const p = getPlayer(pseudo);
  if (!p) return { error: 'Unknown player' };
  p.bet = 0;
  broadcast();
  return {};
}

// ─── token ────────────────────────────────────────────────────────────────────
let _dealToken = '';
function setToken(t) { _dealToken = t; }

function _checkImmediateBlackjacks(activePlayers) {
  // If all active players have BJ or are done after BJ check, go to resolving
  let allDone = true;
  for (const p of activePlayers) {
    if (isBlackjack(p.hands[0].cards)) {
      p.hands[0].done = true;
    } else {
      allDone = false;
    }
  }

  if (allDone && _dealerHasBJ(state.dealerCards)) {
    revealCard(state.dealerCards[1]);
    broadcast();
    _enterResolving();
    return;
  }

  // Find first non-done player
  _enterPlayerTurn();
}

// ─── insurance ────────────────────────────────────────────────────────────────
async function playerInsurance(pseudo, take) {
  if (state.phase !== PHASE.INSURANCE) return { error: 'Not in INSURANCE' };
  const p = getPlayer(pseudo);
  if (!p || !p.hands.length) return { error: 'Not playing' };
  if (p._insuranceDecided) return {};

  p._insuranceDecided = true;
  if (take) {
    const maxIns = Math.floor(p.bet / 2);
    if (p.balance >= maxIns) {
      p.insuranceBet = maxIns;
      p.balance -= maxIns;
    }
  }

  // Check if all connected active players have decided
  const active = state.players.filter(pl => pl.hands.length > 0 && pl.connected);
  if (!active.every(pl => pl._insuranceDecided)) { broadcast(); return {}; }

  await _continueAfterInsurance();
  return {};
}

async function _continueAfterInsurance() {
  if (state.phase !== PHASE.INSURANCE) return;
  const active = state.players.filter(pl => pl.hands.length > 0);

  const dealerBJ = _dealerHasBJ(state.dealerCards);
  if (dealerBJ) {
    revealCard(state.dealerCards[1]);
    broadcast();
    await sleep(400);
    _enterResolving();
    return;
  }

  // No dealer BJ — mark BJ hands as done, then player turns
  active.forEach(pl => {
    if (isBlackjack(pl.hands[0].cards)) pl.hands[0].done = true;
  });
  broadcast();
  _enterPlayerTurn();
}

// ─── player turn timer ────────────────────────────────────────────────────────
function _startPlayerTimer() {
  clearTimeout(_playerTimerHandle);
  state.playerDeadline = Date.now() + PLAYER_TURN_MS;
  _playerTimerHandle   = setTimeout(_onPlayerTimerFired, PLAYER_TURN_MS);
}

function _clearPlayerTimer() {
  clearTimeout(_playerTimerHandle);
  _playerTimerHandle  = null;
  state.playerDeadline = null;
}

function _onPlayerTimerFired() {
  if (state.phase !== PHASE.PLAYER_TURN) return;
  const p = state.players[state.activePlayerIdx];
  if (!p) return;
  const hand = p.hands[p.activeHandIdx];
  if (hand && !hand.done) {
    state.playerDeadline = null;
    hand.done = true;
    broadcast();
    _advanceHand(p);
  }
}

// ─── player turn ──────────────────────────────────────────────────────────────
function _enterPlayerTurn() {
  state.phase = PHASE.PLAYER_TURN;
  // Find first active player with undone hands
  const idx = state.players.findIndex(p => p.hands.length > 0 && p.hands.some(h => !h.done));
  if (idx === -1) {
    _clearPlayerTimer();
    _enterDealerTurn();
    return;
  }
  state.activePlayerIdx = idx;
  // Find first undone hand for that player
  const p = state.players[idx];
  p.activeHandIdx = p.hands.findIndex(h => !h.done);
  _startPlayerTimer();
  broadcast();
}

function _advanceHand(player) {
  // Next undone hand for this player
  const nextIdx = player.hands.findIndex((h, i) => i > player.activeHandIdx && !h.done);
  if (nextIdx !== -1) {
    player.activeHandIdx = nextIdx;
    _startPlayerTimer();
    broadcast();
    return;
  }
  // All hands done for this player → next player
  const curIdx = state.players.indexOf(player);
  let nextPlayerIdx = -1;
  for (let i = curIdx + 1; i < state.players.length; i++) {
    if (state.players[i].hands.length > 0 && state.players[i].hands.some(h => !h.done)) {
      nextPlayerIdx = i;
      break;
    }
  }
  if (nextPlayerIdx !== -1) {
    state.activePlayerIdx = nextPlayerIdx;
    state.players[nextPlayerIdx].activeHandIdx = state.players[nextPlayerIdx].hands.findIndex(h => !h.done);
    _startPlayerTimer();
    broadcast();
  } else {
    _clearPlayerTimer();
    _enterDealerTurn();
  }
}

// ─── player actions ───────────────────────────────────────────────────────────
function _validateAction(pseudo) {
  if (state.phase !== PHASE.PLAYER_TURN) return { error: 'Not in PLAYER_TURN' };
  const p = getPlayer(pseudo);
  if (!p) return { error: 'Unknown player' };
  if (state.players[state.activePlayerIdx]?.pseudo !== pseudo) return { error: 'Not your turn' };
  return { p, hand: p.hands[p.activeHandIdx] };
}

function actionHit(pseudo) {
  const v = _validateAction(pseudo);
  if (v.error) return v;
  const { p, hand } = v;
  _clearPlayerTimer();

  hand.cards.push(dealCard());
  const { total, isBust } = getHandTotal(hand.cards);
  if (isBust || total === 21) hand.done = true;
  if (!hand.done) _startPlayerTimer(); // player still needs to decide
  broadcast();
  if (hand.done) _advanceHand(p);
  return {};
}

function actionStand(pseudo) {
  const v = _validateAction(pseudo);
  if (v.error) return v;
  const { p, hand } = v;
  _clearPlayerTimer();
  hand.done = true;
  broadcast();
  _advanceHand(p);
  return {};
}

function actionDouble(pseudo) {
  const v = _validateAction(pseudo);
  if (v.error) return v;
  const { p, hand } = v;
  if (hand.cards.length !== 2) return { error: 'Double only on first 2 cards' };
  if (p.balance < hand.bet) return { error: 'Insufficient balance' };
  _clearPlayerTimer();
  p.balance -= hand.bet;
  hand.bet   *= 2;
  hand.doubled = true;
  hand.cards.push(dealCard());
  hand.done = true;
  broadcast();
  _advanceHand(p);
  return {};
}

function actionSplit(pseudo) {
  const v = _validateAction(pseudo);
  if (v.error) return v;
  const { p, hand } = v;
  if (hand.cards.length !== 2) return { error: 'Split only on first 2 cards' };
  if (cardValue(hand.cards[0]) !== cardValue(hand.cards[1])) return { error: 'Not a pair' };
  if (p.balance < hand.bet) return { error: 'Insufficient balance' };
  if (p.splitCount >= 3) return { error: 'Max splits reached' };
  _clearPlayerTimer();
  p.balance -= hand.bet;
  p.splitCount++;
  const isAce = cardValue(hand.cards[0]) === 11;
  const h1 = { cards:[hand.cards[0]], bet:hand.bet, doubled:false, isAceSplit:isAce, fromSplit:true, surrendered:false, done:false };
  const h2 = { cards:[hand.cards[1]], bet:hand.bet, doubled:false, isAceSplit:isAce, fromSplit:true, surrendered:false, done:false };
  h1.cards.push(dealCard());
  h2.cards.push(dealCard());
  if (isAce) { h1.done = true; h2.done = true; }
  p.hands.splice(p.activeHandIdx, 1, h1, h2);
  if (isAce) {
    _advanceHand(p); // handles timer for next player
  } else {
    _startPlayerTimer(); // player plays first split hand
    broadcast();
  }
  return {};
}

function actionSurrender(pseudo) {
  const v = _validateAction(pseudo);
  if (v.error) return v;
  const { p, hand } = v;
  if (hand.cards.length !== 2 || hand.fromSplit) return { error: 'Surrender not allowed' };
  _clearPlayerTimer();
  hand.surrendered = true;
  hand.done = true;
  broadcast();
  _advanceHand(p);
  return {};
}

// ─── dealer turn ──────────────────────────────────────────────────────────────
async function _enterDealerTurn() {
  state.phase = PHASE.DEALER_TURN;
  // Reveal hole card
  revealCard(state.dealerCards[1]);
  broadcast();
  await sleep(400);

  // Skip dealer play if all active hands are bust or surrendered
  const activePlayers = state.players.filter(p => p.hands.length > 0);
  const allResolved   = activePlayers.length > 0 && activePlayers.every(p =>
    p.hands.every(h => h.surrendered || getHandTotal(h.cards, false).isBust)
  );

  if (!allResolved) {
    // S17 rule
    while (true) {
      const { total, isSoft } = getHandTotal(state.dealerCards, false);
      if (total > 17 || (total === 17 && !isSoft)) break;
      state.dealerCards.push(dealCard());
      broadcast();
      await sleep(350);
    }
  }

  _enterResolving();
}

// ─── resolving ────────────────────────────────────────────────────────────────
const RESOLVE_MS = 4000;

function _enterResolving() {
  state.phase = PHASE.RESOLVING;
  state.resolveDeadline = Date.now() + RESOLVE_MS;
  const { total: dt } = getHandTotal(state.dealerCards, false);
  const dealerBust = dt > 21;
  const dealerBJ   = _dealerHasBJ(state.dealerCards);

  state.players.forEach(p => {
    if (!p.hands.length) return;

    // Insurance payout
    if (p.insuranceBet > 0) {
      if (dealerBJ) p.balance += p.insuranceBet * 3; // win 2:1 → get back 3x
      // lost: already deducted
    }
    p.insuranceBet = 0;

    p.hands.forEach(hand => {
      if (hand.surrendered) {
        p.balance += Math.floor(hand.bet / 2); // get back half
        return;
      }
      const { total: pt } = getHandTotal(hand.cards, false);
      const bust = pt > 21;
      const bj   = isBlackjack(hand.cards) && !hand.fromSplit;

      if (bust) return; // lose, nothing back

      if (bj && !dealerBJ) {
        p.balance += hand.bet + Math.floor(hand.bet * 1.5); // 3:2
        return;
      }
      if (bj && dealerBJ) { p.balance += hand.bet; return; } // push
      if (dealerBJ) return; // lose
      if (dealerBust) { p.balance += hand.bet * 2; return; }
      if (pt > dt)  { p.balance += hand.bet * 2; return; }
      if (pt === dt){ p.balance += hand.bet; return; }
      // pt < dt → lose
    });

    persistence.setBalance(p.pseudo, p.balance);
  });

  broadcast();

  setTimeout(_enterIdle, RESOLVE_MS);
}

// ─── idle + bet timer ─────────────────────────────────────────────────────────
function _enterIdle() {
  _clearPlayerTimer();
  state.phase = PHASE.IDLE;
  state.resolveDeadline = null;
  // Remove players who disconnected during the game
  state.players = state.players.filter(p => p.connected);
  // Recompact seat indices
  state.players.forEach((p, i) => {
    p.seatIndex = i;
    p.bet = 0; p.hands = []; p.activeHandIdx = 0; p.splitCount = 0;
    p._insuranceDecided = false;
  });
  state.dealerCards     = [];
  state.activePlayerIdx = 0;
  if (state.players.length > 0) _startBetTimer();
  else { state.betDeadline = null; broadcast(); }
}

function _startBetTimer() {
  clearTimeout(_betTimerHandle);
  state.betDeadline = Date.now() + BET_WINDOW_MS;
  broadcast();
  _betTimerHandle = setTimeout(_onBetTimerFired, BET_WINDOW_MS);
}

async function _onBetTimerFired() {
  if (state.phase !== PHASE.IDLE) return;
  const anyBet = state.players.some(p => p.connected && p.bet > 0);
  if (!anyBet) {
    // Nobody bet — restart timer
    _startBetTimer();
    return;
  }
  // Auto-deal
  state.betDeadline = null;
  await _autoDeal();
}

async function _autoDeal() {
  if (state.phase !== PHASE.IDLE) return;

  if (needsReshuffle()) {
    await initShoe(_dealToken);
    broadcast();
    await sleep(600);
    _seedJpeg = null;
  }

  state.phase = PHASE.DEALING;

  state.players.forEach(p => {
    if (p.bet > 0 && p.connected) {
      p.balance -= p.bet;
      p.hands = [{ cards:[], bet: p.bet, doubled:false, isAceSplit:false, fromSplit:false, surrendered:false, done:false }];
      p.activeHandIdx = 0;
      p.splitCount = 0;
    } else {
      p.hands = [];
    }
  });
  state.dealerCards = [];
  const active = state.players.filter(p => p.hands.length > 0);

  broadcast();
  await sleep(200);

  for (const p of active) { p.hands[0].cards.push(dealCard()); broadcast(); await sleep(250); }
  const dealerUp = dealCard(); state.dealerCards.push(dealerUp); broadcast(); await sleep(250);
  for (const p of active) { p.hands[0].cards.push(dealCard()); broadcast(); await sleep(250); }
  const dealerHole = dealCard(true); state.dealerCards.push(dealerHole); broadcast(); await sleep(200);

  if (dealerUp.rank === 'A') {
    state.phase = PHASE.INSURANCE;
    active.forEach(p => p._insuranceDecided = false);
    broadcast();
    return;
  }

  _checkImmediateBlackjacks(active);
}

// ─── forced shuffle ───────────────────────────────────────────────────────────
async function forceShuffle(pseudo) {
  if (state.phase !== PHASE.IDLE) return { error: 'Not in IDLE' };
  await initShoe(_dealToken);
  broadcast();
  await sleep(300);
  _seedJpeg = null;
  broadcast();
  return {};
}

// ─── util ─────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  setBroadcastFn,
  buildPublicState,
  initShoe,
  setToken,
  playerJoin,
  playerDisconnect,
  playerBet,
  playerClearBet,
  playerInsurance,
  actionHit,
  actionStand,
  actionDouble,
  actionSplit,
  actionSurrender,
  forceShuffle,
};
