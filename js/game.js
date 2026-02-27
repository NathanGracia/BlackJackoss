/* ═══════════════════════════════════════════════════════════════
   BlackJackoss — Game Engine (IIFE)
   Depends on: Strategy (js/strategy.js)
   ═══════════════════════════════════════════════════════════════ */

const Game = (() => {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  //  CONSTANTS
  // ─────────────────────────────────────────────────────────────
  const NUM_DECKS     = 6;
  const TOTAL_CARDS   = NUM_DECKS * 52;
  const RESHUFFLE_PCT = 0.25; // reshuffle when < 25% remain
  const SUITS = ['♠','♥','♦','♣'];
  const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

  // Hi-Lo count values
  const HI_LO = {
    '2':1,'3':1,'4':1,'5':1,'6':1,
    '7':0,'8':0,'9':0,
    'T':-1,'J':-1,'Q':-1,'K':-1,'A':-1,
  };

  const SEED_URL = 'https://determinoss.nathangracia.com/seed';

  // ── sfc32 seeded PRNG ──────────────────────────────────────
  // 4×uint32 state → float [0, 1)
  function _makeSfc32(a, b, c, d) {
    return function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      let t = (a + b | 0) + d | 0;
      d = d + 1 | 0;
      a = b ^ b >>> 9;
      b = c + (c << 3) | 0;
      c = c << 21 | c >>> 11;
      c = c + t | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  // Derive 4×uint32 from the first 32 hex chars (128 bits) of the seed
  function _rngFromHex(hex) {
    return _makeSfc32(
      parseInt(hex.slice( 0,  8), 16),
      parseInt(hex.slice( 8, 16), 16),
      parseInt(hex.slice(16, 24), 16),
      parseInt(hex.slice(24, 32), 16),
    );
  }

  // FSM phases
  const PHASE = {
    IDLE:        'IDLE',
    DEALING:     'DEALING',
    INSURANCE:   'INSURANCE',
    PLAYER_TURN: 'PLAYER_TURN',
    DEALER_TURN: 'DEALER_TURN',
    RESOLVING:   'RESOLVING',
  };

  // ─────────────────────────────────────────────────────────────
  //  STATE
  // ─────────────────────────────────────────────────────────────
  let state = {
    phase:        PHASE.IDLE,
    shoe:         [],
    runningCount: 0,
    balance:      1000,
    bet:          0,
    insuranceBet: 0,

    // Hands: array of hand objects
    // hand = { cards: [], bet: number, doubled: false, isAceSplit: false, done: boolean }
    hands:        [],
    activeHandIdx: 0,
    dealerCards:  [],

    splitCount:   0, // how many splits have occurred (max 3)
  };

  // ─────────────────────────────────────────────────────────────
  //  MODE (simple | hard)
  // ─────────────────────────────────────────────────────────────
  let gameMode  = 'simple'; // 'simple' = no counting, 'hard' = full counting
  let autoBet   = false;    // auto-place minimum bet ($5) at start of each round
  const AUTO_BET_AMOUNT = 5;

  // ─────────────────────────────────────────────────────────────
  //  WRONG-ACTION STATE
  // ─────────────────────────────────────────────────────────────
  let wrongHighlight  = null;  // { tableType, rowKey } — persists after a wrong move
  let wrongHighlightTimer = null;

  // ─────────────────────────────────────────────────────────────
  //  SHOE MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  // Token chargé depuis .env au runtime (via fetch, fonctionne avec npx serve)
  let _token = '';

  async function _loadToken() {
    // 1. token.txt (gitignore, servi normalement par npx serve)
    try {
      const res = await fetch('token.txt', { cache: 'no-store' });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text) { _token = text; console.info('[Config] Token chargé depuis token.txt'); return; }
      }
    } catch (_) {}
    // 2. Fallback : config.js (vide par défaut, ne jamais commit le token dedans)
    _token = window.Config?.DETERMINOSS_TOKEN || '';
    if (_token) console.info('[Config] Token chargé depuis config.js');
    else        console.warn('[Config] Aucun token — frame_jpeg indisponible');
  }

  function _seedUrl() {
    return _token ? `${SEED_URL}?token=${encodeURIComponent(_token)}` : SEED_URL;
  }

  function _showSeedImage(base64) {
    const overlay = document.getElementById('seed-overlay');
    const img     = document.getElementById('seed-img');
    if (!overlay || !img || !base64) return;
    img.src = `data:image/jpeg;base64,${base64}`;
    overlay.classList.add('visible');
    clearTimeout(_showSeedImage._timer);
    _showSeedImage._timer = setTimeout(() => overlay.classList.remove('visible'), 2800);
  }

  async function initShoe() {
    // Fetch a deterministic seed from the server
    let rng = Math.random;
    try {
      const res = await fetch(_seedUrl(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      rng = _rngFromHex(json.seed);
      console.info(`[Shoe] seed ${json.seed.slice(0, 16)}… (age ${json.age_ms} ms)`);
      if (json.frame_jpeg) _showSeedImage(json.frame_jpeg);
    } catch (e) {
      console.warn('[Shoe] Seed fetch failed — using Math.random:', e.message);
    }

    // Build 6-deck shoe
    const shoe = [];
    for (let d = 0; d < NUM_DECKS; d++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          shoe.push({ rank, suit });
        }
      }
    }
    // Fisher-Yates with seeded RNG
    for (let i = shoe.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
    state.shoe = shoe;
    state.runningCount = 0;
    updateCountDisplay();
    updateShoeBar();
  }

  function needsReshuffle() {
    return state.shoe.length < TOTAL_CARDS * RESHUFFLE_PCT;
  }

  /**
   * Deal a card from the shoe.
   * @param {boolean} faceDown — whether card is dealt face-down
   * @returns card object (or null if shoe empty)
   */
  function dealCard(faceDown = false) {
    if (state.shoe.length === 0) return null;
    const card = { ...state.shoe.pop(), faceDown };
    if (!faceDown) {
      state.runningCount += HI_LO[card.rank];
    }
    updateCountDisplay();
    updateShoeBar();
    return card;
  }

  /**
   * Reveal a face-down card (dealer hole card).
   */
  function revealCard(card) {
    if (!card || !card.faceDown) return;
    card.faceDown = false;
    state.runningCount += HI_LO[card.rank];
    updateCountDisplay();
  }

  function getTrueCount() {
    const decksRemaining = state.shoe.length / 52;
    if (decksRemaining <= 0) return 0;
    return state.runningCount / decksRemaining;
  }

  function getDecksRemaining() {
    return state.shoe.length / 52;
  }

  // ─────────────────────────────────────────────────────────────
  //  FSM
  // ─────────────────────────────────────────────────────────────

  function transitionTo(phase) {
    state.phase = phase;
    switch (phase) {
      case PHASE.IDLE:        enterIdle();        break;
      case PHASE.DEALING:     enterDealing();     break;
      case PHASE.INSURANCE:   enterInsurance();   break;
      case PHASE.PLAYER_TURN: enterPlayerTurn();  break;
      case PHASE.DEALER_TURN: enterDealerTurn();  break;
      case PHASE.RESOLVING:   enterResolving();   break;
    }
  }

  // ── IDLE ──────────────────────────────────────────────────────
  async function enterIdle() {
    clearHands();
    state.bet = 0;
    state.insuranceBet = 0;
    state.splitCount = 0;
    updateBetDisplay();
    updateBalanceDisplay();
    setDealerScore('—');
    Strategy.clearHighlights();
    clearWrongHighlight();
    setStrategyFeedback('', '');
    updateCountDisplay();

    // Disable everything until shoe is confirmed ready
    enableChips(false);
    setButtonStates({
      deal: false, hit: false, stand: false,
      double: false, split: false, surrender: false,
      insurance: false, noIns: false,
    });

    if (needsReshuffle()) {
      setMessage('🎲 Fetching seed…', 'info');
      await initShoe();
      setMessage('♻ New shoe — place your bet.', 'info');
    } else {
      setMessage('Place your bet and deal.', '');
    }

    enableChips(true);

    // Auto-bet minimum
    if (autoBet && state.balance >= AUTO_BET_AMOUNT) {
      state.bet = AUTO_BET_AMOUNT;
      updateBetDisplay();
      updateDealButton();
    }
  }

  // ── DEALING ───────────────────────────────────────────────────
  function enterDealing() {
    enableChips(false);
    setButtonStates({
      deal: false, hit: false, stand: false,
      double: false, split: false, surrender: false,
      insurance: false, noIns: false,
    });

    // Init hands
    state.hands = [{
      cards:    [],
      bet:      state.bet,
      doubled:  false,
      isAceSplit: false,
      done:     false,
    }];
    state.dealerCards = [];
    state.activeHandIdx = 0;

    clearHands();
    setMessage('');

    // Deal sequence: Player, Dealer, Player, Dealer(faceDown)
    const dealSequence = async () => {
      const p1 = dealCard();
      state.hands[0].cards.push(p1);
      renderAllHands();
      await delay(250);

      const d1 = dealCard();
      state.dealerCards.push(d1);
      renderDealerHand();
      await delay(250);

      const p2 = dealCard();
      state.hands[0].cards.push(p2);
      renderAllHands();
      await delay(250);

      const d2 = dealCard(true); // hole card — face down
      state.dealerCards.push(d2);
      renderDealerHand();
      await delay(200);

      // Check for dealer Ace — offer insurance (regardless of player BJ)
      if (d1.rank === 'A') {
        transitionTo(PHASE.INSURANCE);
        return;
      }

      // Check for player blackjack (no dealer Ace)
      if (_isBlackjack(state.hands[0].cards)) {
        // Dealer peek for BJ (checks hole card regardless of face-down)
        const dealerHasBlackjack = _dealerHasBlackjack();
        revealCard(state.dealerCards[1]);
        renderDealerHand(true);
        if (dealerHasBlackjack) {
          setMessage('PUSH — Both Blackjack!', 'push');
        } else {
          setMessage('BLACKJACK! 🃏 3:2', 'bj');
        }
        transitionTo(PHASE.RESOLVING);
        return;
      }

      transitionTo(PHASE.PLAYER_TURN);
    };

    dealSequence().catch(console.error);
  }

  // ── INSURANCE ─────────────────────────────────────────────────
  function enterInsurance() {
    setMessage('Dealer shows Ace — Insurance?', 'info');
    setButtonStates({
      deal: false, hit: false, stand: false,
      double: false, split: false, surrender: false,
      insurance: true, noIns: true,
    });
  }

  // ── PLAYER TURN ───────────────────────────────────────────────
  function enterPlayerTurn() {
    clearWrongHighlight();
    setStrategyFeedback('', '');
    setMessage('');
    updateAvailableActions();
    updateStrategyHighlight();
  }

  // ── DEALER TURN ───────────────────────────────────────────────
  function enterDealerTurn() {
    setButtonStates({
      deal: false, hit: false, stand: false,
      double: false, split: false, surrender: false,
      insurance: false, noIns: false,
    });
    Strategy.clearHighlights();

    const dealerPlay = async () => {
      // Reveal hole card with animation
      const holeCard = state.dealerCards[1];
      revealCard(holeCard);
      renderDealerHand(true);
      await delay(400);

      // Dealer hits on soft 16 or less, hard 16 or less, soft 17 hits or less
      // S17 = dealer stands on soft 17
      let { total, isSoft } = Strategy.getFullHandTotal(state.dealerCards);
      while (total < 17 || (total === 17 && false /* S17: never hit soft 17 */)) {
        const card = dealCard();
        state.dealerCards.push(card);
        renderDealerHand(true);
        await delay(350);
        const result = Strategy.getFullHandTotal(state.dealerCards);
        total = result.total;
        isSoft = result.isSoft;
      }

      // S17: dealer stands on HARD 17 or more, and on SOFT 17 or more
      // Dealer must hit soft 16 and below — which the loop above handles.
      // Actually per S17 rule: dealer stands on soft 17.
      // The loop condition is: hit if total < 17. Perfect for S17.

      setDealerScore(String(total) + (total > 21 ? ' BUST' : ''));
      transitionTo(PHASE.RESOLVING);
    };

    dealerPlay().catch(console.error);
  }

  // ── RESOLVING ─────────────────────────────────────────────────
  function enterResolving() {
    setButtonStates({
      deal: false, hit: false, stand: false,
      double: false, split: false, surrender: false,
      insurance: false, noIns: false,
    });

    const { total: dealerTotal } = Strategy.getFullHandTotal(state.dealerCards);
    const dealerBust = dealerTotal > 21;
    const dealerBJ   = _dealerHasBlackjack();

    let resultMessages = [];

    // Resolve insurance bet first
    if (state.insuranceBet > 0) {
      if (dealerBJ) {
        const win = state.insuranceBet * 2;
        state.balance += win;
        resultMessages.push(`Insurance +$${win}`);
      } else {
        resultMessages.push(`Insurance -$${state.insuranceBet}`);
      }
    }

    // Resolve each hand
    state.hands.forEach((hand, idx) => {
      if (hand.surrendered) {
        // Already handled
        state.balance += Math.floor(hand.bet / 2);
        resultMessages.push(`Hand ${idx+1}: Surrender (-$${Math.ceil(hand.bet/2)})`);
        return;
      }

      const { total: playerTotal } = Strategy.getFullHandTotal(hand.cards);
      const playerBust = playerTotal > 21;
      const playerBJ   = _isBlackjack(hand.cards) && state.hands.length === 1 && !hand.fromSplit;

      if (playerBust) {
        resultMessages.push(`Hand ${idx+1}: BUST -$${hand.bet}`);
        return;
      }

      if (playerBJ && !dealerBJ) {
        // Blackjack pays 3:2
        const payout = Math.floor(hand.bet * 1.5);
        state.balance += hand.bet + payout;
        resultMessages.push(`Hand ${idx+1}: BLACKJACK +$${payout}`);
        return;
      }

      if (playerBJ && dealerBJ) {
        state.balance += hand.bet; // push
        resultMessages.push(`Hand ${idx+1}: PUSH (both BJ)`);
        return;
      }

      if (dealerBJ) {
        resultMessages.push(`Hand ${idx+1}: LOSE -$${hand.bet}`);
        return;
      }

      if (dealerBust) {
        state.balance += hand.bet * 2;
        resultMessages.push(`Hand ${idx+1}: WIN +$${hand.bet}`);
        return;
      }

      if (playerTotal > dealerTotal) {
        state.balance += hand.bet * 2;
        resultMessages.push(`Hand ${idx+1}: WIN +$${hand.bet}`);
      } else if (playerTotal === dealerTotal) {
        state.balance += hand.bet; // push
        resultMessages.push(`Hand ${idx+1}: PUSH`);
      } else {
        resultMessages.push(`Hand ${idx+1}: LOSE -$${hand.bet}`);
      }
    });

    // Determine overall message
    const wins    = resultMessages.filter(m => m.includes('WIN') || m.includes('BLACKJACK'));
    const losses  = resultMessages.filter(m => m.includes('LOSE') || m.includes('BUST') || m.includes('Surrender'));
    const pushes  = resultMessages.filter(m => m.includes('PUSH'));

    let msgClass = 'info';
    if (wins.length > 0 && losses.length === 0) msgClass = 'win';
    else if (losses.length > 0 && wins.length === 0) msgClass = 'loss';
    else if (pushes.length > 0 && wins.length === 0) msgClass = 'push';

    const single = resultMessages.length === 1;
    if (single) {
      const m = resultMessages[0].replace(/^Hand \d+: /, '');
      setMessage(m, msgClass);
    } else {
      setMessage(resultMessages.join(' | '), msgClass);
    }

    updateBalanceDisplay();

    // Return to IDLE after showing result
    setTimeout(() => {
      transitionTo(PHASE.IDLE);
    }, 1800);
  }

  // ─────────────────────────────────────────────────────────────
  //  PLAYER ACTIONS
  // ─────────────────────────────────────────────────────────────

  function actionHit() {
    if (state.phase !== PHASE.PLAYER_TURN) return;
    checkAction('H');
    const hand = state.hands[state.activeHandIdx];
    const card = dealCard();
    hand.cards.push(card);
    renderAllHands();

    const { total, isBust } = Strategy.getHandTotal(hand.cards);

    if (isBust) {
      hand.done = true;
      setHandScore(state.activeHandIdx, total + ' BUST', true);
      setMessage(`Bust! (${total})`, 'loss');
      advanceHand();
    } else if (total === 21) {
      hand.done = true;
      setHandScore(state.activeHandIdx, '21');
      advanceHand();
    } else {
      updateAvailableActions();
      updateStrategyHighlight();
    }
  }

  function actionStand() {
    if (state.phase !== PHASE.PLAYER_TURN) return;
    checkAction('S');
    state.hands[state.activeHandIdx].done = true;
    advanceHand();
  }

  function actionDouble() {
    if (state.phase !== PHASE.PLAYER_TURN) return;
    checkAction('D');
    const hand = state.hands[state.activeHandIdx];
    const extraBet = hand.bet;
    if (state.balance < extraBet) return;

    state.balance -= extraBet;
    hand.bet += extraBet;
    hand.doubled = true;
    updateBalanceDisplay();
    updateBetDisplay();

    const card = dealCard();
    hand.cards.push(card);
    renderAllHands();

    hand.done = true;
    const { total, isBust } = Strategy.getHandTotal(hand.cards);
    if (isBust) setHandScore(state.activeHandIdx, total + ' BUST', true);
    advanceHand();
  }

  function actionSplit() {
    if (state.phase !== PHASE.PLAYER_TURN) return;
    checkAction('P');
    const hand = state.hands[state.activeHandIdx];

    // Validate: exactly 2 cards, same value
    if (hand.cards.length !== 2) return;
    const v1 = Strategy.cardValue(hand.cards[0]);
    const v2 = Strategy.cardValue(hand.cards[1]);
    if (v1 !== v2) return;
    if (state.balance < hand.bet) return;

    state.balance -= hand.bet;
    state.splitCount++;
    updateBalanceDisplay();

    const isAceSplit = v1 === 11;

    // Create two new hands
    const card1 = hand.cards[0];
    const card2 = hand.cards[1];

    const newHand1 = {
      cards:      [card1],
      bet:        hand.bet,
      doubled:    false,
      isAceSplit: isAceSplit,
      fromSplit:  true,
      done:       false,
    };
    const newHand2 = {
      cards:      [card2],
      bet:        hand.bet,
      doubled:    false,
      isAceSplit: isAceSplit,
      fromSplit:  true,
      done:       false,
    };

    // Replace current hand with two new ones
    state.hands.splice(state.activeHandIdx, 1, newHand1, newHand2);

    // Deal one card to each new hand
    newHand1.cards.push(dealCard());
    newHand2.cards.push(dealCard());

    // Ace split: auto-stand each hand (one card only, no re-split)
    if (isAceSplit) {
      newHand1.done = true;
      newHand2.done = true;
      renderAllHands();
      advanceHand();
      return;
    }

    renderAllHands();
    updateAvailableActions();
    updateStrategyHighlight();
  }

  function actionSurrender() {
    if (state.phase !== PHASE.PLAYER_TURN) return;
    checkAction('R');
    const hand = state.hands[state.activeHandIdx];
    hand.surrendered = true;
    hand.done = true;
    setMessage(`Surrendered — lose $${Math.ceil(hand.bet/2)}`, 'loss');
    advanceHand();
  }

  function actionInsurance() {
    if (state.phase !== PHASE.INSURANCE) return;
    const maxIns = Math.floor(state.bet / 2);
    if (state.balance < maxIns) return;
    state.insuranceBet = maxIns;
    state.balance -= maxIns;
    updateBalanceDisplay();
    _afterInsurance();
  }

  function actionNoInsurance() {
    if (state.phase !== PHASE.INSURANCE) return;
    state.insuranceBet = 0;
    _afterInsurance();
  }

  function _afterInsurance() {
    setButtonStates({ insurance: false, noIns: false });
    const dealerBJ = _dealerHasBlackjack(); // peek at hole card
    const playerBJ = _isBlackjack(state.hands[0].cards);

    if (dealerBJ) {
      revealCard(state.dealerCards[1]);
      renderDealerHand(true);
      if (playerBJ) {
        setMessage('PUSH — Both Blackjack!', 'push');
      } else {
        setMessage('Dealer Blackjack!', 'loss');
      }
      transitionTo(PHASE.RESOLVING);
      return;
    }

    // No dealer BJ — reveal hole card for transparency, then continue
    if (playerBJ) {
      revealCard(state.dealerCards[1]);
      renderDealerHand(true);
      setMessage('BLACKJACK! 🃏 3:2', 'bj');
      transitionTo(PHASE.RESOLVING);
      return;
    }

    transitionTo(PHASE.PLAYER_TURN);
  }

  // ─────────────────────────────────────────────────────────────
  //  HAND ADVANCE
  // ─────────────────────────────────────────────────────────────

  function advanceHand() {
    // Find next undone hand
    const nextIdx = state.hands.findIndex((h, i) => i > state.activeHandIdx && !h.done);
    if (nextIdx !== -1) {
      state.activeHandIdx = nextIdx;
      renderAllHands();
      // If ace split hand has 21 or bust, it's already done
      updateAvailableActions();
      updateStrategyHighlight();
    } else {
      // Check if all hands busted / surrendered
      const anyAlive = state.hands.some(h => {
        if (h.surrendered) return false;
        const { isBust } = Strategy.getHandTotal(h.cards);
        return !isBust;
      });

      if (!anyAlive) {
        transitionTo(PHASE.RESOLVING);
      } else {
        transitionTo(PHASE.DEALER_TURN);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  AVAILABLE ACTIONS
  // ─────────────────────────────────────────────────────────────

  function getAvailableActions(hand) {
    const { total } = Strategy.getHandTotal(hand.cards);
    const isFirstAction = hand.cards.length === 2 && !hand.fromSplit;
    const isFirstActionAnySplit = hand.cards.length === 2; // 2 cards including after split

    const canHit       = !hand.done && total < 21 && !hand.isAceSplit;
    const canStand     = !hand.done;
    const canDouble    = isFirstActionAnySplit && state.balance >= hand.bet;
    const canSurrender = isFirstAction && state.hands.length === 1 && !hand.fromSplit;
    const canSplit     = (
      isFirstActionAnySplit &&
      hand.cards.length === 2 &&
      Strategy.cardValue(hand.cards[0]) === Strategy.cardValue(hand.cards[1]) &&
      state.splitCount < 3 &&
      state.balance >= hand.bet &&
      // No re-split of aces
      !(hand.isAceSplit || (Strategy.cardValue(hand.cards[0]) === 11 && hand.fromSplit))
    );

    return { canHit, canStand, canDouble, canSurrender, canSplit };
  }

  function updateAvailableActions() {
    if (state.phase !== PHASE.PLAYER_TURN) return;
    const hand = state.hands[state.activeHandIdx];
    const { canHit, canStand, canDouble, canSurrender, canSplit } = getAvailableActions(hand);

    setButtonStates({
      hit:       canHit,
      stand:     canStand,
      double:    canDouble,
      split:     canSplit,
      surrender: canSurrender,
      deal:      false,
      insurance: false,
      noIns:     false,
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  BETTING
  // ─────────────────────────────────────────────────────────────

  function addBet(amount) {
    if (state.phase !== PHASE.IDLE) return;
    if (state.balance <= 0) return;
    const actual = Math.min(amount, state.balance);
    state.bet += actual;
    if (state.bet > state.balance) state.bet = state.balance;
    updateBetDisplay();
    updateDealButton();
  }

  function clearBet() {
    if (state.phase !== PHASE.IDLE) return;
    state.bet = 0;
    updateBetDisplay();
    updateDealButton();
  }

  function dealStart() {
    if (state.phase !== PHASE.IDLE) return;
    if (state.bet <= 0) return;
    if (state.balance < state.bet) return;

    state.balance -= state.bet;
    updateBalanceDisplay();

    transitionTo(PHASE.DEALING);
  }

  // ─────────────────────────────────────────────────────────────
  //  STRATEGY FEEDBACK & WRONG-ACTION HIGHLIGHT
  // ─────────────────────────────────────────────────────────────

  const ACTION_LABELS = { H: 'Hit', S: 'Stand', D: 'Double', P: 'Split', R: 'Surrender' };

  /**
   * Called before executing a player action.
   * Compares chosen action vs strategy recommendation and shows feedback.
   */
  function checkAction(chosenAction) {
    if (state.phase !== PHASE.PLAYER_TURN) return;

    const hand = state.hands[state.activeHandIdx];
    const dealerUpcard = Strategy.cardValue(state.dealerCards[0]);
    const { canDouble, canSplit, canSurrender } = getAvailableActions(hand);
    const isFirstAction = hand.cards.length === 2 && !hand.fromSplit;

    const { action: recommended, tableType, rowKey } = Strategy.getAction(
      hand.cards, dealerUpcard,
      { canDouble, canSplit, canSurrender: isFirstAction && canSurrender, isFirstAction }
    );

    if (chosenAction === recommended) {
      setStrategyFeedback(`✓ Correct — ${ACTION_LABELS[recommended]}`, 'correct');
      clearWrongHighlight();
    } else {
      // Re-trigger shake animation even on consecutive wrong moves
      const el = document.getElementById('strategy-feedback');
      if (el) el.classList.remove('wrong');
      requestAnimationFrame(() => {
        setStrategyFeedback(
          `✗ Mauvaise déc. ! Il fallait : ${ACTION_LABELS[recommended]}`,
          'wrong'
        );
      });
      // Persist the highlight on the correct row
      clearTimeout(wrongHighlightTimer);
      wrongHighlight = { tableType, rowKey };
      wrongHighlightTimer = setTimeout(clearWrongHighlight, 5000);
    }
  }

  function clearWrongHighlight() {
    wrongHighlight = null;
    clearTimeout(wrongHighlightTimer);
  }

  // ─────────────────────────────────────────────────────────────
  //  STRATEGY HIGHLIGHT
  // ─────────────────────────────────────────────────────────────

  function updateStrategyHighlight() {
    if (state.phase !== PHASE.PLAYER_TURN) {
      // Keep wrong highlight visible even outside player turn
      if (!wrongHighlight) Strategy.clearHighlights();
      return;
    }

    // If a wrong move was just made, keep that row highlighted (not the new hand's row)
    if (wrongHighlight) {
      Strategy.highlightRow(wrongHighlight.tableType, wrongHighlight.rowKey);
      return;
    }

    const hand = state.hands[state.activeHandIdx];
    const dealerUpcard = Strategy.cardValue(state.dealerCards[0]);
    const { canDouble, canSplit, canSurrender } = getAvailableActions(hand);
    const isFirstAction = hand.cards.length === 2 && !hand.fromSplit;

    const { action, tableType, rowKey } = Strategy.getAction(
      hand.cards,
      dealerUpcard,
      { canDouble, canSplit, canSurrender: isFirstAction && canSurrender, isFirstAction }
    );

    Strategy.highlightRow(tableType, rowKey);
  }

  // ─────────────────────────────────────────────────────────────
  //  RENDERING
  // ─────────────────────────────────────────────────────────────

  function _suitClass(suit) {
    return (suit === '♥' || suit === '♦') ? 'suit-red' : 'suit-black';
  }

  /**
   * Create a card DOM element.
   * @param {Object} card — { rank, suit, faceDown }
   * @param {boolean} compact — use compact size
   */
  function createCardElement(card, compact = false) {
    const div = document.createElement('div');
    div.className = 'card' + (compact ? ' compact' : '');

    if (card.faceDown) {
      div.innerHTML = `<div class="card-face-down"></div>`;
      return div;
    }

    const sClass = _suitClass(card.suit);
    div.innerHTML = `
      <div class="card-front">
        <div class="card-corner ${sClass}">
          <span class="corner-rank">${card.rank}</span>
          <span class="corner-suit">${card.suit}</span>
        </div>
        <span class="card-suit-big ${sClass}">${card.suit}</span>
        <div class="card-corner bottom-right ${sClass}">
          <span class="corner-rank">${card.rank}</span>
          <span class="corner-suit">${card.suit}</span>
        </div>
      </div>
    `;

    div.style.setProperty('--card-w', compact ? '55px' : '70px');
    div.style.setProperty('--card-h', compact ? '78px' : '96px');

    return div;
  }

  function renderDealerHand(revealed = false) {
    const container = document.getElementById('dealer-cards');
    if (!container) return;
    container.innerHTML = '';

    state.dealerCards.forEach(card => {
      const el = createCardElement(card);
      el.classList.add('card-enter');
      container.appendChild(el);
    });

    // Update dealer score
    if (revealed) {
      const { total, isBust } = Strategy.getFullHandTotal(state.dealerCards);
      setDealerScore(isBust ? `${total} BUST` : String(total));
    } else {
      // Show only upcard value
      const visible = state.dealerCards.filter(c => !c.faceDown);
      if (visible.length > 0) {
        const { total } = Strategy.getHandTotal(visible);
        setDealerScore(String(total) + ' +?');
      }
    }
  }

  function renderAllHands() {
    const container = document.getElementById('hands-container');
    if (!container) return;
    container.innerHTML = '';

    const compact = state.hands.length >= 3;

    state.hands.forEach((hand, idx) => {
      const box = document.createElement('div');
      box.className = 'hand-box' + (idx === state.activeHandIdx && !hand.done ? ' active-hand' : '');

      // Cards row
      const cardsRow = document.createElement('div');
      cardsRow.className = 'cards-row';
      hand.cards.forEach(card => {
        const el = createCardElement(card, compact);
        el.classList.add('card-enter');
        cardsRow.appendChild(el);
      });
      box.appendChild(cardsRow);

      // Score
      const { total, isBust } = Strategy.getHandTotal(hand.cards);
      const scoreEl = document.createElement('div');
      scoreEl.className = 'hand-score' + (isBust ? ' bust' : '');

      let scoreText = String(total);
      if (isBust) scoreText += ' BUST';
      if (hand.doubled) scoreText += ' ×2';
      if (hand.surrendered) scoreText = 'Surrender';
      if (_isBlackjack(hand.cards) && !hand.fromSplit) scoreText = 'BJ';

      scoreEl.textContent = scoreText;
      box.appendChild(scoreEl);

      // Label
      if (state.hands.length > 1) {
        const labelEl = document.createElement('div');
        labelEl.className = 'hand-label';
        labelEl.textContent = `HAND ${idx + 1}  $${hand.bet}`;
        box.appendChild(labelEl);
      }

      container.appendChild(box);
    });

    // Update bet display to reflect total bets
    const totalBet = state.hands.reduce((sum, h) => sum + h.bet, 0);
    document.getElementById('bet-display').textContent = '$' + totalBet;
  }

  function clearHands() {
    const dc = document.getElementById('dealer-cards');
    const hc = document.getElementById('hands-container');
    if (dc) dc.innerHTML = '';
    if (hc) hc.innerHTML = '';
  }

  // ─────────────────────────────────────────────────────────────
  //  DISPLAY UPDATES
  // ─────────────────────────────────────────────────────────────

  function updateCountDisplay() {
    const rc = state.runningCount;
    const tc = getTrueCount();
    const decks = getDecksRemaining();

    const rcEl = document.getElementById('rc-value');
    const tcEl = document.getElementById('tc-value');
    const decksEl = document.getElementById('decks-value');
    const rcChip  = document.getElementById('stat-rc');
    const tcChip  = document.getElementById('stat-tc');

    if (rcEl) {
      rcEl.textContent = rc > 0 ? '+' + rc : String(rc);
      rcEl.className = 'stat-value ' + (rc > 0 ? 'positive' : rc < 0 ? 'negative' : 'neutral');
    }
    if (tcEl) {
      const tcStr = (tc > 0 ? '+' : '') + tc.toFixed(1);
      tcEl.textContent = tcStr;
      tcEl.className = 'stat-value ' + (tc > 0 ? 'positive' : tc < 0 ? 'negative' : 'neutral');
    }
    if (decksEl) {
      decksEl.textContent = decks.toFixed(1);
    }
  }

  function updateShoeBar() {
    const fill   = document.getElementById('shoe-fill');
    const bar    = document.getElementById('shoe-bar');
    if (!fill || !bar) return;

    const pct = (state.shoe.length / TOTAL_CARDS) * 100;
    fill.style.width = pct + '%';
  }

  function updateBalanceDisplay() {
    const el = document.getElementById('balance-display');
    if (el) el.textContent = '$' + state.balance;
  }

  function updateBetDisplay() {
    const el = document.getElementById('bet-display');
    if (el) el.textContent = '$' + state.bet;
  }

  function updateDealButton() {
    const btn = document.getElementById('btn-deal');
    if (!btn) return;
    btn.disabled = !(state.bet > 0 && state.balance >= 0);
  }

  function setDealerScore(text) {
    const el = document.getElementById('dealer-score');
    if (el) el.textContent = text;
  }

  function setHandScore(idx, text, bust = false) {
    const container = document.getElementById('hands-container');
    if (!container) return;
    const boxes = container.querySelectorAll('.hand-box');
    if (boxes[idx]) {
      const scoreEl = boxes[idx].querySelector('.hand-score');
      if (scoreEl) {
        scoreEl.textContent = text;
        if (bust) scoreEl.classList.add('bust');
      }
    }
  }

  function setMessage(text, type = '') {
    const el = document.getElementById('message-area');
    if (!el) return;
    el.textContent = text;
    el.className = 'message-area ' + type;
  }

  function setStrategyFeedback(text, type = '') {
    const el = document.getElementById('strategy-feedback');
    if (!el) return;
    el.textContent = text;
    el.className = 'strategy-feedback ' + type;
  }

  function enableChips(enabled) {
    document.querySelectorAll('.chip').forEach(btn => {
      btn.disabled = !enabled;
    });
  }

  /**
   * Set button enabled/disabled states.
   * Pass only the buttons you want to change; omitted ones are unchanged.
   */
  function setButtonStates(states) {
    const map = {
      deal:       'btn-deal',
      hit:        'btn-hit',
      stand:      'btn-stand',
      double:     'btn-double',
      split:      'btn-split',
      surrender:  'btn-surrender',
      insurance:  'btn-insurance',
      noIns:      'btn-no-insurance',
    };
    for (const [key, val] of Object.entries(states)) {
      const id = map[key];
      if (!id) continue;
      const btn = document.getElementById(id);
      if (!btn) continue;

      if (key === 'insurance' || key === 'noIns') {
        btn.hidden    = !val;
        btn.disabled  = !val;
      } else {
        btn.disabled = !val;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────────────────────

  // Peek at dealer's hole card regardless of face-down status (for dealer BJ check)
  function _dealerHasBlackjack() {
    const cards = state.dealerCards;
    if (cards.length !== 2) return false;
    const vals = cards.map(c => Strategy.cardValue(c));
    return (vals[0] === 11 && vals[1] === 10) || (vals[0] === 10 && vals[1] === 11);
  }

  function _isBlackjack(cards) {
    const visible = cards.filter(c => !c.faceDown);
    if (visible.length !== 2) return false;
    const vals = visible.map(c => Strategy.cardValue(c));
    return (
      (vals[0] === 11 && vals[1] === 10) ||
      (vals[0] === 10 && vals[1] === 11)
    );
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────────────────────
  //  INIT
  // ─────────────────────────────────────────────────────────────

  function init() {
    // Charger le token depuis .env puis démarrer
    _loadToken().then(() => _boot());
  }

  function _boot() {
    // Render strategy charts
    Strategy.renderCharts();

    // Wire up buttons
    document.getElementById('btn-deal')?.addEventListener('click', dealStart);
    document.getElementById('btn-hit')?.addEventListener('click', actionHit);
    document.getElementById('btn-stand')?.addEventListener('click', actionStand);
    document.getElementById('btn-double')?.addEventListener('click', actionDouble);
    document.getElementById('btn-split')?.addEventListener('click', actionSplit);
    document.getElementById('btn-surrender')?.addEventListener('click', actionSurrender);
    document.getElementById('btn-insurance')?.addEventListener('click', actionInsurance);
    document.getElementById('btn-no-insurance')?.addEventListener('click', actionNoInsurance);
    document.getElementById('btn-clear-bet')?.addEventListener('click', clearBet);

    // Chip buttons
    document.querySelectorAll('.chip[data-amount]').forEach(btn => {
      btn.addEventListener('click', () => addBet(parseInt(btn.dataset.amount, 10)));
    });

    // Strategy toggle
    const toggleBtn  = document.getElementById('strategy-toggle');
    const panel      = document.getElementById('strategy-panel');
    if (toggleBtn && panel) {
      toggleBtn.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
      });
    }

    // Auto-bet toggle
    const autoBetBtn = document.getElementById('btn-auto-bet');
    if (autoBetBtn) {
      autoBetBtn.addEventListener('click', () => {
        autoBet = !autoBet;
        autoBetBtn.classList.toggle('active', autoBet);
        // Apply immediately if currently in IDLE with no bet
        if (autoBet && state.phase === PHASE.IDLE && state.bet === 0 && state.balance >= AUTO_BET_AMOUNT) {
          state.bet = AUTO_BET_AMOUNT;
          updateBetDisplay();
          updateDealButton();
        }
      });
    }

    // Mode toggle (simple / hard)
    const modeBtn   = document.getElementById('mode-toggle');
    const modeLabel = document.getElementById('mode-label');
    if (modeBtn) {
      // Apply simple mode on startup
      document.body.classList.add('simple-mode');

      modeBtn.addEventListener('click', () => {
        if (gameMode === 'simple') {
          gameMode = 'hard';
          document.body.classList.remove('simple-mode');
          modeBtn.classList.add('hard');
          if (modeLabel) modeLabel.textContent = 'HARD';
        } else {
          gameMode = 'simple';
          document.body.classList.add('simple-mode');
          modeBtn.classList.remove('hard');
          if (modeLabel) modeLabel.textContent = 'SIMPLE';
        }
      });
    }

    // Bouton SHUFFLE forcé
    document.getElementById('btn-shuffle')?.addEventListener('click', async () => {
      if (state.phase !== PHASE.IDLE) return;
      enableChips(false);
      setButtonStates({ deal: false });
      setMessage('🎲 Fetching seed…', 'info');
      await initShoe();
      setMessage('♻ New shoe — place your bet.', 'info');
      enableChips(true);
      updateDealButton();
    });

    // Enter IDLE state
    transitionTo(PHASE.IDLE);
  }

  // ─────────────────────────────────────────────────────────────
  //  BOOT
  // ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API (mostly for debugging)
  return {
    state,
    phase: PHASE,
    initShoe,
    getTrueCount,
    getDecksRemaining,
    actionHit,
    actionStand,
    actionDouble,
    actionSplit,
    actionSurrender,
    actionInsurance,
    actionNoInsurance,
  };

})();
