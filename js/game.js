/* ═══════════════════════════════════════════════════════════════
   BlackJackoss — Client WebSocket + Renderer
   Depends on: Strategy (js/strategy.js), Config (js/config.js)
   ═══════════════════════════════════════════════════════════════ */

const Game = (() => {
  'use strict';

  // ─── local state ──────────────────────────────────────────────
  let myPseudo    = null;
  let ws          = null;
  let lastState   = null;
  let _timerRafId      = null;
  let preSelectedAction = null;  // 'hit'|'stand'|'double'|'split'|'surrender'
  const _prev = { dealer: 0, hands: [] };

  // Client-only state
  let wrongHighlight     = null;  // { tableType, rowKey }
  let wrongHighlightTimer= null;
  let hadWrongAction     = false;
  let currentHandActionLog = [];
  let handHistory        = [];
  const HISTORY_MAX      = 4;

  // Mode (simple/hard) — client only
  let gameMode = 'simple';

  const ACTION_LABELS = { H:'Hit', S:'Stand', D:'Double', P:'Split', R:'Surrender' };
  const ACT_LABEL     = ACTION_LABELS;

  // ─── WebSocket ────────────────────────────────────────────────
  function connect() {
    const url = window.Config?.WS_URL || 'ws://localhost:3000';
    ws = new WebSocket(url);

    ws.onopen    = () => console.info('[WS] connected');
    ws.onclose   = () => {
      console.warn('[WS] disconnected — reconnecting in 2s');
      setTimeout(connect, 2000);
    };
    ws.onerror   = e => console.error('[WS] error', e);
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch(_) { return; }
      handleMessage(msg);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ─── message handler ──────────────────────────────────────────
  function handleMessage(msg) {
    if (msg.type === 'welcome') {
      // Already joined — show table
      showTable();
      updateBalanceDisplay(msg.balance);
    }

    if (msg.type === 'state') {
      const prev = lastState;
      lastState  = msg.state;
      onState(msg.state, prev);
    }

    if (msg.type === 'error') {
      console.warn('[Server]', msg.message);
    }
  }

  // ─── join screen ──────────────────────────────────────────────
  function showJoinScreen() {
    document.getElementById('join-screen')?.removeAttribute('hidden');
    document.getElementById('game-wrapper')?.setAttribute('hidden', '');
  }

  function showTable() {
    document.getElementById('join-screen')?.setAttribute('hidden', '');
    document.getElementById('game-wrapper')?.removeAttribute('hidden');
  }

  // ─── state renderer ───────────────────────────────────────────
  function onState(state, prev) {
    const me = state.players.find(p => p.pseudo === myPseudo);

    // Update seed overlay if present
    if (state.seedJpeg) _showSeedImage(state.seedJpeg);

    // Bet countdown bar
    updateBetTimer(state);

    // Update shoe bar + count
    updateShoeBar(state.shoe);
    updateCountDisplay(state.shoe);

    // Render dealer
    renderDealerHand(state.dealerCards, state.phase);

    // Render all seats (other players + me compact overview)
    renderSeats(state);

    // Render my hands full-size
    if (me) {
      updateBalanceDisplay(me.balance);
      updateBetDisplay(me.bet, me.hands);
      renderMyHands(me, state);
      // Show/hide player-area
      const pa = document.getElementById('player-area');
      if (pa) pa.hidden = !me.hands.length;
    }

    // Detect "just became my turn" → fire pre-selected action
    _checkPreSelectTrigger(state, prev);

    // Buttons
    updateButtons(state, me);

    // Strategy feedback — only when it's my turn
    if (me && state.phase === 'PLAYER_TURN') {
      const activePseudo = state.players[state.activePlayerIdx]?.pseudo;
      if (activePseudo === myPseudo) {
        const hand = me.hands[me.activeHandIdx];
        if (hand && !hand.done) updateStrategyHighlight(hand, state.dealerCards, me);
      }
    }

    // Reset card animation counters on IDLE
    if (state.phase === 'IDLE') { _prev.dealer = 0; _prev.hands = []; }

    // Detect phase transition → IDLE : reset wrong highlight
    if (prev && prev.phase !== 'IDLE' && state.phase === 'IDLE') {
      clearWrongHighlight();
      setStrategyFeedback('', '');
      Strategy.clearHighlights();
      // Add to history if we were playing
      if (prev.phase === 'RESOLVING' && me) {
        _addToHistory(state, prev, me);
      }
    }

    // Message area
    updateMessageArea(state, me, prev);
  }

  // ─── dealer rendering ─────────────────────────────────────────
  function renderDealerHand(cards, phase) {
    const container = document.getElementById('dealer-cards');
    if (!container) return;
    container.innerHTML = '';
    cards.forEach((card, i) => {
      const el = createCardElement(card);
      if (i >= _prev.dealer) el.classList.add('card-enter');
      container.appendChild(el);
    });
    _prev.dealer = cards.length;

    const revealed = phase === 'DEALER_TURN' || phase === 'RESOLVING' || phase === 'IDLE';
    const scoreEl  = document.getElementById('dealer-score');
    if (!scoreEl) return;

    if (!cards.length) { scoreEl.textContent = '—'; return; }

    if (revealed) {
      let total = 0, aces = 0;
      cards.forEach(c => {
        const v = _cardValue(c); total += v;
        if (c.rank === 'A') aces++;
      });
      while (total > 21 && aces > 0) { total -= 10; aces--; }
      scoreEl.textContent = total > 21 ? `${total} BUST` : String(total);
    } else {
      const vis = cards.filter(c => !c.faceDown);
      if (!vis.length) { scoreEl.textContent = '—'; return; }
      let total = 0, aces = 0;
      vis.forEach(c => { const v = _cardValue(c); total += v; if (c.rank==='A') aces++; });
      while (total > 21 && aces > 0) { total -= 10; aces--; }
      scoreEl.textContent = total + ' +?';
    }
  }

  // ─── my hands ─────────────────────────────────────────────────
  function renderMyHands(me, state) {
    const container = document.getElementById('hands-container');
    if (!container) return;
    container.innerHTML = '';
    if (!me.hands.length) return;

    const compact  = me.hands.length >= 3;
    const isMyTurn = state.phase === 'PLAYER_TURN' && state.players[state.activePlayerIdx]?.pseudo === myPseudo;

    me.hands.forEach((hand, idx) => {
      const active = isMyTurn && idx === me.activeHandIdx && !hand.done;
      const box    = document.createElement('div');
      box.className = 'hand-box' + (active ? ' active-hand' : '');

      const row = document.createElement('div');
      row.className = 'cards-row';
      const prevCount = _prev.hands[idx] || 0;
      hand.cards.forEach((c, ci) => {
        const el = createCardElement(c, compact);
        if (ci >= prevCount) el.classList.add('card-enter');
        row.appendChild(el);
      });
      _prev.hands[idx] = hand.cards.length;
      box.appendChild(row);

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

      if (me.hands.length > 1) {
        const lbl = document.createElement('div');
        lbl.className = 'hand-label';
        lbl.textContent = `HAND ${idx+1}  $${hand.bet}`;
        box.appendChild(lbl);
      }
      container.appendChild(box);
    });
  }

  // ─── table seats (all players) ────────────────────────────────
  function renderSeats(state) {
    const container = document.getElementById('table-seats');
    if (!container) return;
    container.innerHTML = '';

    const activePseudo = state.players[state.activePlayerIdx]?.pseudo;
    const sorted = [...state.players].sort((a, b) => a.seatIndex - b.seatIndex);

    sorted.forEach(p => {
      const isMe     = p.pseudo === myPseudo;
      const isActive = p.pseudo === activePseudo && state.phase === 'PLAYER_TURN';

      const seat = document.createElement('div');
      seat.className = ['seat', isMe ? 'my-seat' : '', isActive ? 'active-seat' : '',
                        !p.connected ? 'disconnected' : ''].filter(Boolean).join(' ');

      // Name row
      const nameRow = document.createElement('div');
      nameRow.className = 'seat-name-row';
      if (isActive) {
        const dot = document.createElement('span');
        dot.className = 'seat-active-dot'; dot.textContent = '▶';
        nameRow.appendChild(dot);
      }
      const nameEl = document.createElement('span');
      nameEl.className = 'seat-name';
      nameEl.textContent = p.pseudo + (isMe ? ' ★' : '');
      nameRow.appendChild(nameEl);
      seat.appendChild(nameRow);

      // Cards
      if (p.hands.length) {
        p.hands.forEach(hand => {
          const row = document.createElement('div');
          row.className = 'cards-row';
          hand.cards.forEach(c => row.appendChild(createCardElement(c, true)));
          seat.appendChild(row);
          const { total, isBust } = Strategy.getHandTotal(hand.cards);
          const sc = document.createElement('div');
          sc.className = 'seat-score' + (isBust ? ' bust' : '');
          sc.textContent = hand.surrendered ? 'SURR' :
                           (_isBlackjack(hand.cards) && !hand.fromSplit) ? 'BJ' :
                           isBust ? total + ' B' : String(total);
          seat.appendChild(sc);
        });
      } else {
        const w = document.createElement('div');
        w.className = 'seat-waiting';
        w.textContent = state.phase === 'IDLE' ? (p.bet > 0 ? `$${p.bet} ✓` : '—') : 'out';
        seat.appendChild(w);
      }

      // Info: balance + bet
      const info = document.createElement('div');
      info.className = 'seat-info';
      info.innerHTML = `<span class="seat-balance">$${p.balance}</span>`;
      if (p.bet > 0 && !p.hands.length) info.innerHTML += `<span class="seat-bet"> $${p.bet}</span>`;
      seat.appendChild(info);

      container.appendChild(seat);
    });
  }

  // ─── pre-select ───────────────────────────────────────────────
  function _checkPreSelectTrigger(state, prev) {
    if (!myPseudo || !preSelectedAction) return;
    const nowMyTurn = state.phase === 'PLAYER_TURN' &&
                      state.players[state.activePlayerIdx]?.pseudo === myPseudo;
    const wasMyTurn = prev?.phase === 'PLAYER_TURN' &&
                      prev?.players?.[prev?.activePlayerIdx]?.pseudo === myPseudo;
    if (nowMyTurn && !wasMyTurn) {
      const action = preSelectedAction;
      _setPreSelect(null);
      setTimeout(() => send({ type: 'action', action }), 150);
    }
  }

  function _setPreSelect(action) {
    preSelectedAction = action;
    const hint  = document.getElementById('preselect-hint');
    const label = document.getElementById('preselect-label');
    document.querySelectorAll('.action-btn').forEach(b => b.classList.remove('preselected'));
    if (!action) { if (hint) hint.hidden = true; return; }
    const names = { hit:'Hit', stand:'Stand', double:'Double', split:'Split', surrender:'Surrender' };
    if (label) label.textContent = `⏳ ${names[action]} préselectionné`;
    if (hint)  hint.hidden = false;
    const idMap = { hit:'btn-hit', stand:'btn-stand', double:'btn-double', split:'btn-split', surrender:'btn-surrender' };
    document.getElementById(idMap[action])?.classList.add('preselected');
  }

  // ─── buttons ──────────────────────────────────────────────────
  function updateButtons(state, me) {
    const phase      = state.phase;
    const isMyTurn   = phase === 'PLAYER_TURN' && me &&
                       state.players[state.activePlayerIdx]?.pseudo === myPseudo;
    const isOtherTurn = phase === 'PLAYER_TURN' && !isMyTurn;
    const isIdle     = phase === 'IDLE';
    const isIns      = phase === 'INSURANCE' && me && me.hands.length > 0 && !me._insuranceDecided;

    document.querySelectorAll('.chip').forEach(btn => {
      if (btn.id === 'btn-auto-bet') return;
      btn.disabled = !isIdle || !me;
    });

    const btnIns   = document.getElementById('btn-insurance');
    const btnNoIns = document.getElementById('btn-no-insurance');
    if (btnIns)   { btnIns.hidden   = !isIns; btnIns.disabled   = !isIns; }
    if (btnNoIns) { btnNoIns.hidden = !isIns; btnNoIns.disabled = !isIns; }

    // During other player's turn → enable buttons for pre-select (except already done constraints)
    if (isOtherTurn && me?.hands.length) {
      _setBtn('btn-hit',       false);
      _setBtn('btn-stand',     false);
      _setBtn('btn-double',    false);
      _setBtn('btn-split',     false);
      _setBtn('btn-surrender', false);
      return;
    }

    let canHit=false, canStand=false, canDouble=false, canSplit=false, canSurrender=false;
    if (isMyTurn && me) {
      const hand = me.hands[me.activeHandIdx];
      if (hand && !hand.done) {
        const { total } = Strategy.getHandTotal(hand.cards);
        canHit       = total < 21 && !hand.isAceSplit;
        canStand     = true;
        canDouble    = hand.cards.length === 2 && me.balance >= hand.bet;
        canSplit     = hand.cards.length === 2 &&
                       _cardValue(hand.cards[0]) === _cardValue(hand.cards[1]) &&
                       me.splitCount < 3 && me.balance >= hand.bet &&
                       !(hand.isAceSplit || (_cardValue(hand.cards[0])===11 && hand.fromSplit));
        canSurrender = hand.cards.length === 2 && !hand.fromSplit && me.hands.length === 1;
      }
    }

    _setBtn('btn-hit',       !isMyTurn || !canHit);
    _setBtn('btn-stand',     !isMyTurn || !canStand);
    _setBtn('btn-double',    !isMyTurn || !canDouble);
    _setBtn('btn-split',     !isMyTurn || !canSplit);
    _setBtn('btn-surrender', !isMyTurn || !canSurrender);
  }

  function _setBtn(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }

  // ─── message area ─────────────────────────────────────────────
  function updateMessageArea(state, me, prev) {
    const el = document.getElementById('message-area');
    if (!el) return;

    if (state.phase === 'IDLE' && prev && prev.phase === 'RESOLVING') {
      // Show payout result
      if (!me) { el.textContent = ''; el.className = 'message-area'; return; }
      // Calculate net for this round from previous resolving state
      const prevMe = prev.players?.find(p => p.pseudo === myPseudo);
      if (prevMe) {
        const net = me.balance - prevMe.balance;
        el.textContent = (net >= 0 ? '+$' : '-$') + Math.abs(net);
        el.className = 'message-area ' + (net > 0 ? 'win' : net < 0 ? 'loss' : 'push');
      }
      return;
    }

    if (state.phase === 'IDLE') {
      el.textContent = prev?.phase === 'IDLE' ? 'Place your bet and deal.' : '';
      el.className   = 'message-area';
    } else if (state.phase === 'INSURANCE') {
      el.textContent = 'Dealer shows Ace — Insurance?';
      el.className   = 'message-area info';
    } else if (state.phase === 'DEALING') {
      el.textContent = '';
      el.className   = 'message-area';
    } else if (state.phase === 'DEALER_TURN') {
      el.textContent = 'Dealer plays…';
      el.className   = 'message-area info';
    }
  }

  // ─── strategy highlight ───────────────────────────────────────
  function updateStrategyHighlight(hand, dealerCards, me) {
    if (wrongHighlight) {
      Strategy.highlightRow(wrongHighlight.tableType, wrongHighlight.rowKey);
      return;
    }
    if (!dealerCards.length) return;
    const dealerUpcard = _cardValue(dealerCards[0]);
    const { canDouble, canSplit, canSurrender } = _getAvail(hand, me);
    const isFirst = hand.cards.length === 2 && !hand.fromSplit;
    const { tableType, rowKey } = Strategy.getAction(hand.cards, dealerUpcard,
      { canDouble, canSplit, canSurrender: isFirst && canSurrender, isFirstAction: isFirst });
    Strategy.highlightRow(tableType, rowKey);
  }

  function checkActionFeedback(chosenAction, hand, dealerCards, me) {
    const dealerUpcard = _cardValue(dealerCards[0]);
    const { canDouble, canSplit, canSurrender } = _getAvail(hand, me);
    const isFirst = hand.cards.length === 2 && !hand.fromSplit;
    const { action: rec, tableType, rowKey } = Strategy.getAction(hand.cards, dealerUpcard,
      { canDouble, canSplit, canSurrender: isFirst && canSurrender, isFirstAction: isFirst });

    currentHandActionLog.push({
      handIdx: me.activeHandIdx,
      cards: hand.cards.map(c => ({ rank: c.rank, suit: c.suit })),
      takenAction: chosenAction, correctAction: rec, wasCorrect: chosenAction === rec,
    });

    if (chosenAction === rec) {
      setStrategyFeedback(`✓ Correct — ${ACTION_LABELS[rec]}`, 'correct');
      clearWrongHighlight();
    } else {
      hadWrongAction = true;
      const el = document.getElementById('strategy-feedback');
      if (el) el.classList.remove('wrong');
      requestAnimationFrame(() =>
        setStrategyFeedback(`✗ Mauvaise déc. ! Il fallait : ${ACTION_LABELS[rec]}`, 'wrong')
      );
      clearTimeout(wrongHighlightTimer);
      wrongHighlight = { tableType, rowKey };
      wrongHighlightTimer = setTimeout(clearWrongHighlight, 5000);
    }
  }

  function clearWrongHighlight() {
    wrongHighlight = null;
    clearTimeout(wrongHighlightTimer);
  }

  function _getAvail(hand, me) {
    const { total } = Strategy.getHandTotal(hand.cards);
    return {
      canDouble:    hand.cards.length === 2 && me.balance >= hand.bet,
      canSplit:     hand.cards.length === 2 &&
                    _cardValue(hand.cards[0]) === _cardValue(hand.cards[1]) &&
                    me.splitCount < 3 && me.balance >= hand.bet,
      canSurrender: hand.cards.length === 2 && !hand.fromSplit && me.hands.length === 1,
    };
  }

  // ─── card rendering ───────────────────────────────────────────
  function createCardElement(card, compact = false) {
    const div = document.createElement('div');
    div.className = 'card' + (compact ? ' compact' : '');
    if (card.faceDown) {
      div.innerHTML = `<div class="card-face-down"></div>`;
      return div;
    }
    const sClass = (card.suit === '♥' || card.suit === '♦') ? 'suit-red' : 'suit-black';
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
      </div>`;
    return div;
  }

  // ─── display helpers ──────────────────────────────────────────
  function updateBalanceDisplay(balance) {
    const el = document.getElementById('balance-display');
    if (el && balance !== undefined) el.textContent = '$' + balance;
  }

  function updateBetDisplay(bet, hands) {
    const el = document.getElementById('bet-display');
    if (!el) return;
    if (hands && hands.length > 0) {
      const total = hands.reduce((s, h) => s + h.bet, 0);
      el.textContent = '$' + total;
    } else {
      el.textContent = '$' + (bet || 0);
    }
  }

  function updateShoeBar(shoe) {
    const fill = document.getElementById('shoe-fill');
    if (!fill || !shoe) return;
    const pct = (shoe.remaining / (6 * 52)) * 100;
    fill.style.width = pct + '%';
  }

  function updateCountDisplay(shoe) {
    if (!shoe) return;
    const rc    = shoe.runningCount;
    const decks = shoe.remaining / 52;
    const tc    = decks > 0 ? rc / decks : 0;

    const rcEl    = document.getElementById('rc-value');
    const tcEl    = document.getElementById('tc-value');
    const decksEl = document.getElementById('decks-value');
    if (rcEl) { rcEl.textContent = rc > 0 ? '+'+rc : String(rc); rcEl.className = 'stat-value '+(rc>0?'positive':rc<0?'negative':'neutral'); }
    if (tcEl) { tcEl.textContent = (tc>0?'+':'')+tc.toFixed(1); tcEl.className = 'stat-value '+(tc>0?'positive':tc<0?'negative':'neutral'); }
    if (decksEl) decksEl.textContent = decks.toFixed(1);
  }

  function setStrategyFeedback(text, type) {
    const el = document.getElementById('strategy-feedback');
    if (el) { el.textContent = text; el.className = 'strategy-feedback ' + (type||''); }
  }

  // ─── bet countdown bar ────────────────────────────────────────
  function updateBetTimer(state) {
    const wrap  = document.getElementById('bet-timer-wrap');
    const bar   = document.getElementById('bet-timer-bar');
    const label = document.getElementById('bet-timer-label');
    if (!wrap || !bar || !label) return;

    cancelAnimationFrame(_timerRafId);

    if (state.phase !== 'IDLE' || !state.betDeadline) {
      wrap.hidden = true;
      return;
    }

    wrap.hidden = false;

    const total    = 8000; // must match BET_WINDOW_MS
    const deadline = state.betDeadline;

    function tick() {
      const remaining = Math.max(0, deadline - Date.now());
      const pct       = remaining / total;
      bar.style.width = (pct * 100) + '%';
      label.textContent = Math.ceil(remaining / 1000) + 's';

      // Color urgency
      const urgency = pct < 0.25 ? 'critical' : pct < 0.5 ? 'urgent' : '';
      bar.className   = 'bet-timer-bar ' + urgency;
      label.className = 'bet-timer-label ' + urgency;

      if (remaining > 0) _timerRafId = requestAnimationFrame(tick);
      else { bar.style.width = '0%'; label.textContent = '0s'; }
    }

    tick();
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

  // ─── history ──────────────────────────────────────────────────
  function _addToHistory(state, prevState, me) {
    const prevMe = prevState.players?.find(p => p.pseudo === myPseudo);
    if (!prevMe) return;
    const net = me.balance - prevMe.balance;

    const playerParts = (prevMe.hands || []).map(h => {
      if (h.surrendered) return 'SURR';
      const { total, isBust } = Strategy.getHandTotal(h.cards);
      if (isBust) return 'BUST';
      if (_isBlackjack(h.cards) && !h.fromSplit) return 'BJ';
      return String(total);
    });

    const { total: dt, isBust: db } = Strategy.getFullHandTotal(prevState.dealerCards || []);
    const dealerText = db ? 'BUST' : String(dt);

    handHistory.unshift({
      playerText:   playerParts.join(' / ') || '—',
      dealerText,
      decisionClass: hadWrongAction ? 'bad' : 'good',
      net,
      actions:  [...currentHandActionLog],
      dealerUp: prevState.dealerCards?.[0] || { rank:'?', suit:'' },
    });
    if (handHistory.length > HISTORY_MAX) handHistory.pop();

    hadWrongAction       = false;
    currentHandActionLog = [];
    _renderHistory();
  }

  function _renderHistory() {
    const el = document.getElementById('history-list');
    if (!el) return;
    el.innerHTML = '';
    if (!handHistory.length) { el.innerHTML = '<div class="history-empty">No hands yet</div>'; return; }
    handHistory.forEach(entry => {
      const sign   = entry.net > 0 ? '+' : '';
      const netCls = entry.net > 0 ? 'pos' : entry.net < 0 ? 'neg' : 'zero';
      const icon   = entry.decisionClass === 'good' ? '✓' : '✗';
      const div    = document.createElement('div');
      div.className = `history-entry h-${entry.decisionClass}`;
      div.innerHTML = `
        <div class="h-row">
          <span class="h-icon">${icon}</span>
          <span class="h-net h-net-${netCls}">${sign}$${entry.net}</span>
        </div>
        <div class="h-totals">${entry.playerText} <span class="h-vs">vs</span> ${entry.dealerText}</div>`;
      div.addEventListener('mouseenter', () => _showDetail(entry, div));
      div.addEventListener('mouseleave',  _hideDetail);
      el.appendChild(div);
    });
  }

  function _ensureDetailPopup() {
    if (document.getElementById('history-detail')) return;
    const el = document.createElement('div');
    el.id = 'history-detail'; el.className = 'history-detail';
    document.body.appendChild(el);
  }

  function _showDetail(entry, anchor) {
    const popup = document.getElementById('history-detail');
    if (!popup) return;
    const byHand = {};
    (entry.actions||[]).forEach(a => (byHand[a.handIdx]=byHand[a.handIdx]||[]).push(a));
    const hCount = Object.keys(byHand).length;
    let html = `<div class="hd-dealer">Dealer up : ${entry.dealerUp.rank}${entry.dealerUp.suit}</div>`;
    if (!entry.actions?.length) {
      html += `<div class="hd-no-actions">BJ / auto</div>`;
    } else {
      Object.entries(byHand).forEach(([hi, actions]) => {
        if (hCount>1) html+=`<div class="hd-hand-label">Hand ${+hi+1}</div>`;
        actions.forEach((a,i) => {
          const cards = a.cards.map(c=>c.rank+c.suit).join(' ');
          const cls   = a.wasCorrect ? 'hd-ok' : 'hd-err';
          html += `<div class="hd-action">
            <span class="hd-num">${i+1}.</span>
            <span class="hd-cards">${cards}</span>
            <span class="hd-act">${ACT_LABEL[a.takenAction]}</span>
            <span class="${cls}">${a.wasCorrect?'✓':'✗'}</span>
            ${!a.wasCorrect?`<span class="hd-should">→ ${ACT_LABEL[a.correctAction]}</span>`:''}
          </div>`;
        });
      });
    }
    popup.innerHTML = html;
    const rect = anchor.getBoundingClientRect();
    let top = rect.top, left = rect.right + 8;
    popup.classList.add('visible');
    const maxTop = window.innerHeight - popup.offsetHeight - 8;
    if (top > maxTop) top = maxTop;
    popup.style.top = top + 'px'; popup.style.left = left + 'px';
  }

  function _hideDetail() {
    document.getElementById('history-detail')?.classList.remove('visible');
  }

  // ─── util ─────────────────────────────────────────────────────
  function _cardValue(c) {
    if (!c) return 0;
    if (c.rank === 'A') return 11;
    if ('TJQK'.includes(c.rank)) return 10;
    return parseInt(c.rank, 10);
  }

  function _isBlackjack(cards) {
    const vis = (cards||[]).filter(c => !c.faceDown);
    if (vis.length !== 2) return false;
    const vals = vis.map(_cardValue);
    return (vals[0]===11&&vals[1]===10)||(vals[0]===10&&vals[1]===11);
  }

  function _escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ─── init ─────────────────────────────────────────────────────
  function init() {
    Strategy.renderCharts();
    _ensureDetailPopup();

    // Join screen
    const joinForm = document.getElementById('join-form');
    if (joinForm) {
      joinForm.addEventListener('submit', e => {
        e.preventDefault();
        const input  = document.getElementById('join-pseudo');
        const pseudo = (input?.value || '').trim();
        if (!pseudo) return;
        myPseudo = pseudo;
        send({ type: 'join', pseudo });
      });
    }

    // Betting chips
    document.querySelectorAll('.chip[data-amount]').forEach(btn => {
      btn.addEventListener('click', () => send({ type:'bet', amount: parseInt(btn.dataset.amount,10) }));
    });
    document.getElementById('btn-clear-bet')?.addEventListener('click', () => send({ type:'clearBet' }));

    // Actions — capture action + check feedback before sending
    const actionBtns = [
      ['btn-hit',       'hit',       'H'],
      ['btn-stand',     'stand',     'S'],
      ['btn-double',    'double',    'D'],
      ['btn-split',     'split',     'P'],
      ['btn-surrender', 'surrender', 'R'],
    ];
    actionBtns.forEach(([id, action, code]) => {
      document.getElementById(id)?.addEventListener('click', () => {
        if (!lastState || !myPseudo) return;
        const isMyTurn = lastState.phase === 'PLAYER_TURN' &&
                         lastState.players[lastState.activePlayerIdx]?.pseudo === myPseudo;
        const isOtherTurn = lastState.phase === 'PLAYER_TURN' && !isMyTurn;

        if (isOtherTurn) {
          // Pre-select mode: toggle or set
          _setPreSelect(preSelectedAction === action ? null : action);
          return;
        }

        // My turn: send immediately
        const me   = lastState.players.find(p => p.pseudo === myPseudo);
        const hand = me?.hands[me.activeHandIdx];
        if (me && hand && lastState.dealerCards.length) {
          checkActionFeedback(code, hand, lastState.dealerCards, me);
        }
        send({ type:'action', action });
      });
    });

    // Cancel pre-select
    document.getElementById('preselect-cancel')?.addEventListener('click', () => _setPreSelect(null));

    // Insurance
    document.getElementById('btn-insurance')?.addEventListener('click', () =>
      send({ type:'insurance', take: true }));
    document.getElementById('btn-no-insurance')?.addEventListener('click', () =>
      send({ type:'insurance', take: false }));

    // Shuffle
    document.getElementById('btn-shuffle')?.addEventListener('click', () =>
      send({ type:'shuffle' }));

    // Auto-bet toggle (client-only, sends bet on click)
    let autoBet = false;
    const autoBetBtn = document.getElementById('btn-auto-bet');
    if (autoBetBtn) {
      autoBetBtn.addEventListener('click', () => {
        autoBet = !autoBet;
        autoBetBtn.classList.toggle('active', autoBet);
        if (autoBet && lastState?.phase === 'IDLE') send({ type:'bet', amount: 5 });
      });
    }

    // Mode toggle
    const modeBtn   = document.getElementById('mode-toggle');
    const modeLabel = document.getElementById('mode-label');
    document.body.classList.add('simple-mode');
    if (modeBtn) {
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

    // Strategy toggle
    const stratBtn = document.getElementById('strategy-toggle');
    const panel    = document.getElementById('strategy-panel');
    if (stratBtn && panel) {
      stratBtn.addEventListener('click', () => panel.classList.toggle('collapsed'));
    }

    // Connect WebSocket
    connect();

    // Show join screen until we get welcome
    showJoinScreen();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {};
})();
