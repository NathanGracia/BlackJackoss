'use strict';

const https       = require('https');
const http        = require('http');
const db           = require('./db');
const { checkAchievements } = require('./achievements-def');

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

const PLAYER_TURN_MS  = 10000; // auto-stand after 10s
const INSURANCE_MS    = 8000;  // auto no-insurance after 8s

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
  betDeadline:      null,  // epoch ms — end of betting window
  resolveDeadline:  null,  // epoch ms — end of resolving phase
  playerDeadline:   null,  // epoch ms — end of current player's turn
  insuranceDeadline:null,  // epoch ms — end of insurance decision window
};

let _betTimerHandle       = null;

function _clearBetTimer() {
  clearTimeout(_betTimerHandle);
  _betTimerHandle  = null;
  state.betDeadline = null;
}
let _playerTimerHandle    = null;
let _insuranceTimerHandle = null;

let _broadcastFn    = null;  // injected by server.js
let _achievementFn  = null;  // injected by server.js — unicast(pseudo, msg)
let _seedJpeg    = null;  // last frame_jpeg from Determinoss (for broadcast)

function setBroadcastFn(fn)   { _broadcastFn   = fn; }
function setAchievementFn(fn) { _achievementFn = fn; }

function broadcast() {
  if (_broadcastFn) _broadcastFn(buildPublicState());
}

function buildPublicState() {
  return {
    phase:           state.phase,
    betDeadline:      state.betDeadline,
    resolveDeadline:  state.resolveDeadline,
    playerDeadline:   state.playerDeadline,
    insuranceDeadline:state.insuranceDeadline,
    shoe:  { remaining: state.shoe.length, runningCount: state.runningCount },
    players: state.players.map(p => ({
      pseudo:       p.pseudo,
      balance:      p.balance,
      bet:          p.bet,
      insuranceBet:     p.insuranceBet,
      insuranceDecided: p._insuranceDecided,
      hands:            p.hands,
      activeHandIdx:p.activeHandIdx,
      splitCount:   p.splitCount,
      seatIndex:    p.seatIndex,
      connected:    p.connected,
      readyToDeal:  p.bet > 0,
      autoBet:      p.autoBet,
      skin:         p.skin,
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
    const balance = db.getBalance(pseudo);
    p = {
      pseudo, balance, bet: 0, insuranceBet: 0,
      hands: [], activeHandIdx: 0, splitCount: 0,
      seatIndex: state.players.length,
      connected: true, readyToDeal: false,
      autoBet: false, lastBet: 5, skin: '',
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

const VALID_SKINS = new Set(['','theme-fire','theme-volcano','theme-kaleidoscope','theme-underdog','theme-zen','theme-veteran','theme-pain','theme-legend','theme-streak','theme-vip','theme-gold','theme-ashes','theme-divine']);
function playerSetSkin(pseudo, skin) {
  const p = getPlayer(pseudo);
if (!p || !VALID_SKINS.has(skin)) return;
  p.skin = skin;
  broadcast();
}

const REFILL_AMOUNT = 100;
function playerRefill(pseudo) {
  const p = getPlayer(pseudo);
  if (!p || p.balance > 0 || state.phase !== PHASE.IDLE) return { error: 'Cannot refill now' };
  p.balance = REFILL_AMOUNT;
  db.setBalance(pseudo, REFILL_AMOUNT);
  broadcast();
  return {};
}

function playerSetAutoBet(pseudo, enabled) {
  const p = getPlayer(pseudo);
  if (!p) return;
  p.autoBet = !!enabled;
  if (state.phase === PHASE.IDLE) _checkAllAutoAndSkip();
  else broadcast();
}

function _checkAllAutoAndSkip() {
  if (state.phase !== PHASE.IDLE) return;
  const connected = state.players.filter(p => p.connected);
  if (connected.length === 0) return;
  if (!connected.every(p => p.autoBet)) return;
  // All players on auto — apply last bets and skip the window
  _clearBetTimer();
  connected.forEach(p => {
    if (p.balance > 0) p.bet = Math.min(p.lastBet, p.balance);
  });
  if (!connected.some(p => p.bet > 0)) { _startBetTimer(); return; } // nobody can bet
  broadcast();
  setTimeout(() => _autoDeal().catch(console.error), 400);
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
  _clearInsuranceTimer();
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

// ─── insurance timer ──────────────────────────────────────────────────────────
function _startInsuranceTimer() {
  clearTimeout(_insuranceTimerHandle);
  state.insuranceDeadline = Date.now() + INSURANCE_MS;
  _insuranceTimerHandle   = setTimeout(_onInsuranceTimerFired, INSURANCE_MS);
}

function _clearInsuranceTimer() {
  clearTimeout(_insuranceTimerHandle);
  _insuranceTimerHandle    = null;
  state.insuranceDeadline  = null;
}

async function _onInsuranceTimerFired() {
  if (state.phase !== PHASE.INSURANCE) return;
  // Auto no-insurance for all players who haven't decided yet
  state.players.forEach(p => {
    if (p.hands.length > 0 && !p._insuranceDecided) {
      p._insuranceDecided = true;
    }
  });
  _clearInsuranceTimer();
  await _continueAfterInsurance();
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

  // Auto-done: ace splits (1 card only) + any hand that immediately hits 21
  const { total: t1 } = getHandTotal(h1.cards, false);
  const { total: t2 } = getHandTotal(h2.cards, false);
  if (isAce || t1 === 21) h1.done = true;
  if (isAce || t2 === 21) h2.done = true;

  p.hands.splice(p.activeHandIdx, 1, h1, h2);

  if (h1.done) {
    // h1 auto-done — broadcast split result, then advance to h2 (or end round)
    broadcast();
    _advanceHand(p);
  } else {
    // Start timer first so playerDeadline is included in the broadcast
    _startPlayerTimer();
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

// ─── achievement processing ───────────────────────────────────────────────────
function _processAchievements(p, dealerBust) {
  if (!_achievementFn) return;

  const stats = db.getStats(p.pseudo);
  if (!stats) return;

  const delta = {
    hands_played:   0, hands_won: 0, hands_lost: 0,
    blackjacks:     0, surrenders: 0, all_ins: 0, all_in_wins: 0,
    doubles_won:    0, splits4_done: 0, splits4_won: 0, small_hand_wins: 0,
  };

  const wasAllIn   = p._wasAllIn;   // set in _autoDeal
  let   roundWon   = false;
  let   roundLost  = false;
  const isSplit4   = p.hands.length === 4;
  let   allSplit4Won = isSplit4;

  p.hands.forEach(hand => {
    if (hand.surrendered) { delta.surrenders++; roundLost = true; return; }
    const { total: pt } = getHandTotal(hand.cards, false);
    const bust = pt > 21;
    const bj   = isBlackjack(hand.cards) && !hand.fromSplit;
    const won  = hand.net > 0;
    const lost = hand.net < 0;

    if (bj)  delta.blackjacks++;
    if (won) {
      delta.hands_won++;
      roundWon = true;
      if (hand.doubled)              delta.doubles_won++;
      if (wasAllIn)                  delta.all_in_wins++;
      if (!isSplit4 && pt <= 12)     delta.small_hand_wins++;
      if (isSplit4 && !won)          allSplit4Won = false;
    } else {
      if (isSplit4) allSplit4Won = false;
    }
    if (lost) { delta.hands_lost++; roundLost = true; }
  });

  delta.hands_played = 1;
  if (wasAllIn) delta.all_ins++;
  if (isSplit4) delta.splits4_done++;
  if (isSplit4 && allSplit4Won) delta.splits4_won++;

  // Streaks (replace, not additive)
  const newWinStreak = roundWon && !roundLost
    ? (stats.win_streak || 0) + 1 : 0;
  const newAllInStreak = wasAllIn
    ? (stats.consecutive_all_ins || 0) + 1 : 0;

  db.updateStats(p.pseudo, {
    ...delta,
    win_streak:          newWinStreak,
    consecutive_all_ins: newAllInStreak,
  });

  const fresh = db.getStats(p.pseudo);
  const candidates = checkAchievements(fresh, { balance: p.balance });

  for (const ach of candidates) {
    const isNew = db.unlockAchievement(p.pseudo, ach.id);
    if (!isNew) continue;

    // Credit balance reward
    if (ach.reward.type === 'balance') {
      p.balance += ach.reward.value;
      db.setBalance(p.pseudo, p.balance);
    }

    _achievementFn(p.pseudo, { type: 'achievement_unlocked', achievement: {
      id:     ach.id,
      name:   ach.name,
      desc:   ach.desc,
      icon:   ach.icon,
      reward: ach.reward,
    }});
  }
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
        const back = Math.floor(hand.bet / 2);
        p.balance += back;
        hand.net = -(hand.bet - back); // lose half
        return;
      }
      const { total: pt } = getHandTotal(hand.cards, false);
      const bust = pt > 21;
      const bj   = isBlackjack(hand.cards) && !hand.fromSplit;

      if (bust) { hand.net = -hand.bet; return; } // lose, nothing back

      if (bj && !dealerBJ) {
        const profit = Math.floor(hand.bet * 1.5);
        p.balance += hand.bet + profit; // 3:2
        hand.net = profit;
        return;
      }
      if (bj && dealerBJ) { p.balance += hand.bet; hand.net = 0; return; } // push
      if (dealerBJ) { hand.net = -hand.bet; return; } // lose
      if (dealerBust || pt > dt) { p.balance += hand.bet * 2; hand.net = hand.bet; return; }
      if (pt === dt) { p.balance += hand.bet; hand.net = 0; return; }
      hand.net = -hand.bet; // pt < dt
    });

    db.setBalance(p.pseudo, p.balance);
    _processAchievements(p, dealerBust);
  });

  broadcast();

  setTimeout(_enterIdle, RESOLVE_MS);
}

// ─── idle + bet timer ─────────────────────────────────────────────────────────
function _enterIdle() {
  _clearPlayerTimer();
  _clearInsuranceTimer();
  state.phase = PHASE.IDLE;
  state.resolveDeadline = null;
  // Remove players who disconnected during the game
  state.players = state.players.filter(p => p.connected);
  // Recompact seat indices
  state.players.forEach((p, i) => {
    p.seatIndex = i;
    if (p.bet > 0) p.lastBet = p.bet;  // save before clearing
    p.bet = 0; p.hands = []; p.activeHandIdx = 0; p.splitCount = 0;
    p._insuranceDecided = false;
  });
  state.dealerCards     = [];
  state.activePlayerIdx = 0;
  if (state.players.length === 0) { state.betDeadline = null; broadcast(); return; }
  const connected = state.players.filter(p => p.connected);
  const allAuto = connected.length > 0 && connected.every(p => p.autoBet);
  if (allAuto) {
    _checkAllAutoAndSkip();
  } else {
    _startBetTimer();
  }
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
      p._wasAllIn = p.balance === p.bet; // all chips are in the bet
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
    _startInsuranceTimer();
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
  setAchievementFn,
  buildPublicState,
  initShoe,
  setToken,
  playerJoin,
  playerDisconnect,
  playerBet,
  playerClearBet,
  playerRefill,
  playerSetAutoBet,
  playerSetSkin,
  playerInsurance,
  actionHit,
  actionStand,
  actionDouble,
  actionSplit,
  actionSurrender,
  forceShuffle,
};
