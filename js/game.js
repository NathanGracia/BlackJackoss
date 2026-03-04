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
  let _timerRafId          = null;
  let _resolveRafId        = null;
  let _playerTimerRafId    = null;
  let _insuranceTimerRafId = null;
  let preSelectedAction = null;  // 'hit'|'stand'|'double'|'split'|'surrender'
  const _prev = { dealer: 0, hands: [] };

  // Client-only state
  let handHistory      = [];
  let autoBet          = false;
  let neverInsurance   = false;    // auto-decline insurance
  let _lastBetAmount   = 5;        // replayed by AUTO
  let _tookInsurance   = null;   // true/false/null
  let _prevIdleBalance = null;   // balance before bet deduction, for net P&L
  const _allInPlayers  = new Set(); // pseudos who went all-in this round

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
      showTable();
      updateBalanceDisplay(msg.balance);
      // Restore skin from localStorage
      const savedSkin = localStorage.getItem('bj-skin') || '';
      send({ type: 'setSkin', skin: savedSkin });
    }

    if (msg.type === 'achievements') {
      AchievementsClient.setUnlocked(msg.list);
    }

    if (msg.type === 'achievement_unlocked') {
      AchievementsClient.onUnlocked(msg.achievement);
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
    if (me) AchievementsClient.setSkin(me.skin || '');

    // Update seed overlay if present
    if (state.seedJpeg) _showSeedImage(state.seedJpeg);

    // Bet countdown bar
    updateBetTimer(state);

    // Resolve countdown bar (dealer area)
    updateResolveTimer(state);

    // Player turn countdown border
    updatePlayerTimer(state);

    // Insurance countdown bar
    updateInsuranceTimer(state);

    // Update shoe bar + count
    updateShoeBar(state.shoe);
    updateCountDisplay(state.shoe);

    // Render dealer
    renderDealerHand(state.dealerCards, state.phase);

    // Render all seats (other players + me compact overview)
    renderSeats(state);

    // Floating action toasts on player actions
    if (prev?.phase === 'PLAYER_TURN') {
      state.players.forEach(p => {
        const prevP = prev.players?.find(pp => pp.pseudo === p.pseudo);
        const action = _detectPlayerAction(prevP, p);
        if (action) {
          _showActionToast(p.pseudo, action);
          if      (action === 'BUST')      Sounds.bust();
          else if (action === '21')        Sounds.twentyone();
          else if (action === 'SURRENDER') Sounds.surrender();
          else                             Sounds.action();
        }
      });
    }

    // Net P&L toasts on resolving
    if (state.phase === 'RESOLVING' && prev?.phase !== 'RESOLVING') {
      state.players.forEach(p => {
        let winIdx = 0;
        p.hands.forEach((hand, hi) => {
          if (hand.net == null) return;
          const isBJ = _isBlackjack(hand.cards) && !hand.fromSplit && hand.net > 0;
          const wIdx = hand.net > 0 ? winIdx++ : 0;
          setTimeout(() => _showNetToast(p.pseudo, hand, hi, wIdx), hi * 200);
        });
      });
    }

    // Floating toasts on insurance decisions
    if (prev?.phase === 'INSURANCE') {
      state.players.forEach(p => {
        const prevP = prev.players?.find(pp => pp.pseudo === p.pseudo);
        if (!prevP || prevP.insuranceDecided || !p.insuranceDecided) return;
        _showActionToast(p.pseudo, p.insuranceBet > 0 ? 'INSURE' : 'NO INS');
      });
    }

    // Update balance + bet display (arc view in renderSeats handles card rendering)
    if (me) {
      updateBalanceDisplay(me.balance);
      updateBetDisplay(me.bet, me.hands);
      // Show refill button if broke and IDLE
      const refillBtn = document.getElementById('btn-refill');
      if (refillBtn) refillBtn.hidden = !(me.balance === 0 && state.phase === 'IDLE');
    }

    // Detect "just became my turn" → fire pre-selected action
    _checkPreSelectTrigger(state, prev);

    // Buttons
    updateButtons(state, me);

    // Reset card animation counters on IDLE
    if (state.phase === 'IDLE') { _prev.dealer = 0; _prev.hands = []; }

    // Record pre-bet balance when IDLE→DEALING (balance hasn't been deducted yet)
    if (state.phase === 'DEALING' && prev?.phase === 'IDLE') {
      const prevMeIdle = prev.players?.find(p => p.pseudo === myPseudo);
      if (prevMeIdle) {
        _prevIdleBalance = prevMeIdle.balance;
        if (prevMeIdle.bet > 0) _lastBetAmount = prevMeIdle.bet;
      }
      // Detect all-in players (balance === 0 after deal deduction)
      _allInPlayers.clear();
      state.players.forEach(p => {
        if (p.balance === 0 && p.hands.length > 0) {
          _allInPlayers.add(p.pseudo);
          _showAllInAnnounce(p.pseudo);
        }
      });
    }

    // Clear all-in tracker on IDLE
    if (state.phase === 'IDLE') _allInPlayers.clear();

    // Add to history when round ends
    if (prev && prev.phase === 'RESOLVING' && state.phase === 'IDLE' && me) {
      _addToHistory(state, prev, me);
      _tookInsurance = null;
    }

    // Auto-bet: replay last bet amount when a new round starts
    // Guard: skip if server already pre-set the bet (all-auto skip path)
    if (autoBet && state.phase === 'IDLE' && prev?.phase !== 'IDLE') {
      const meNow = state.players?.find(p => p.pseudo === myPseudo);
      if (!meNow || meNow.bet === 0) send({ type: 'bet', amount: _lastBetAmount });
    }

    // Message area
    updateMessageArea(state, me, prev);
  }

  // ─── dealer rendering ─────────────────────────────────────────
  function renderDealerHand(cards, phase) {
    const container = document.getElementById('dealer-cards');
    if (!container) return;
    container.innerHTML = '';
    let dealerNew = 0;
    cards.forEach((card, i) => {
      const el = createCardElement(card);
      if (i >= _prev.dealer) { el.classList.add('card-enter'); dealerNew++; }
      container.appendChild(el);
    });
    if (dealerNew > 0) Sounds.deal();
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
      let playerNew = 0;
      hand.cards.forEach((c, ci) => {
        const el = createCardElement(c, compact);
        if (ci >= prevCount) { el.classList.add('card-enter'); playerNew++; }
        row.appendChild(el);
      });
      if (playerNew > 0) Sounds.deal();
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

  // ─── arc table seats (all players) ───────────────────────────
  function renderSeats(state) {
    const container = document.getElementById('table-seats');
    if (!container) return;
    container.innerHTML = '';

    const me_ = state.players.find(p => p.pseudo === myPseudo);
    const isAllIn = me_ && me_.balance === 0 && me_.hands.length > 0;
    container.classList.toggle('allin', !!isAllIn);

    const activePseudo = state.players[state.activePlayerIdx]?.pseudo;
    const sorted = [...state.players].sort((a, b) => a.seatIndex - b.seatIndex);
    if (!sorted.length) return;

    // Rotate so that I am always at the center position (circular table view)
    const N      = sorted.length;
    const center = Math.floor(N / 2);
    const meIdx  = sorted.findIndex(p => p.pseudo === myPseudo);
    const offset = meIdx >= 0 ? ((meIdx - center) % N + N) % N : 0;
    const display = sorted.map((_, i) => sorted[(offset + i) % N]);

    display.forEach((p, i) => {
      const isMe     = p.pseudo === myPseudo;
      const isActive = p.pseudo === activePseudo && state.phase === 'PLAYER_TURN';
      const allDone  = p.hands.length > 0 && p.hands.every(h => h.done);
      const isDone    = state.phase === 'PLAYER_TURN' && allDone && !isActive;
      const isWaiting = state.phase === 'PLAYER_TURN' && p.hands.length > 0 && !allDone && !isActive;

      const seat = document.createElement('div');
      seat.dataset.pseudo = p.pseudo;
      seat.className = [
        'seat',
        isMe          ? 'my-seat'      : '',
        isActive      ? 'active-seat'  : '',
        isDone        ? 'done-seat'    : '',
        isWaiting     ? 'waiting-seat' : '',
        !p.connected  ? 'disconnected' : '',
        p.skin        || '',
      ].filter(Boolean).join(' ');

      // Arc lift: seats farther from center are raised toward the dealer
      const dist = Math.abs(i - center);
      seat.style.transform = `translateY(-${dist * 26}px)`;

      // ── Name row ──
      const nameRow = document.createElement('div');
      nameRow.className = 'seat-name-row';
      if (isActive) {
        const dot = document.createElement('span');
        dot.className = 'seat-active-dot';
        dot.textContent = '▶';
        nameRow.appendChild(dot);
      }
      const nameEl = document.createElement('span');
      nameEl.className = 'seat-name';
      nameEl.textContent = (isMe ? '★ ' : '') + p.pseudo;
      nameRow.appendChild(nameEl);
      seat.appendChild(nameRow);

      // ── Hands ──
      if (p.hands.length) {
        const compact   = !isMe;
        const handsWrap = document.createElement('div');
        handsWrap.className = 'seat-hands' + (p.hands.length > 1 ? ' split' : '');

        p.hands.forEach((hand, hi) => {
          const isActiveHand = isActive && hi === p.activeHandIdx && !hand.done;

          const box = document.createElement('div');
          box.className = 'seat-hand-box'
            + (isActiveHand ? ' active-hand' : '')
            + (hand.done    ? ' done-hand'   : '');

          if (p.hands.length > 1) {
            const lbl = document.createElement('div');
            lbl.className = 'seat-hand-label';
            lbl.textContent = `H${hi + 1}`;
            box.appendChild(lbl);
          }

          const row = document.createElement('div');
          row.className = 'cards-row';
          const prevCount = isMe ? (_prev.hands[hi] || 0) : 0;
          hand.cards.forEach((c, ci) => {
            const el = createCardElement(c, compact);
            if (isMe && ci >= prevCount) el.classList.add('card-enter');
            row.appendChild(el);
          });
          if (isMe) _prev.hands[hi] = hand.cards.length;
          box.appendChild(row);

          const { total, isBust } = Strategy.getHandTotal(hand.cards);
          const isBJ = _isBlackjack(hand.cards) && !hand.fromSplit;
          let scoreText = isBJ             ? 'BJ'
                        : hand.surrendered  ? 'SURR'
                        : isBust            ? `${total} BUST`
                        :                     String(total);
          if (isMe && hand.doubled && !isBJ && !isBust) scoreText += ' ×2';
          const sc = document.createElement('div');
          sc.className = 'seat-score' + (isBust ? ' bust' : '') + (isMe ? ' my-score' : '');
          sc.textContent = scoreText;
          box.appendChild(sc);

          if (p.hands.length > 1) {
            const hbet = document.createElement('div');
            hbet.className = 'seat-hand-bet';
            hbet.textContent = '$' + hand.bet + (hand.doubled ? ' ×2' : '');
            box.appendChild(hbet);
          }

          handsWrap.appendChild(box);
        });

        seat.appendChild(handsWrap);
      } else {
        const w = document.createElement('div');
        w.className = 'seat-waiting';
        w.textContent = state.phase === 'IDLE'
          ? (p.bet > 0 ? `$${p.bet} ✓` : '—')
          : 'out';
        seat.appendChild(w);
      }

      // ── Info: balance + total bet ──
      const info = document.createElement('div');
      info.className = 'seat-info';

      const balEl = document.createElement('span');
      balEl.className = 'seat-balance';
      balEl.textContent = '$' + p.balance;
      info.appendChild(balEl);

      const totalBet = p.hands.length
        ? p.hands.reduce((s, h) => s + h.bet, 0)
        : p.bet;
      if (totalBet > 0) {
        const betEl = document.createElement('span');
        betEl.className = 'seat-bet';
        betEl.textContent = '$' + totalBet;
        info.appendChild(betEl);
      }

      seat.appendChild(info);
      container.appendChild(seat);
    });
  }

  // ─── action toasts ────────────────────────────────────────────
  function _detectPlayerAction(prevP, nextP) {
    if (!prevP || !nextP) return null;
    // Split: any increase in hand count
    if (nextP.hands.length > prevP.hands.length) return 'SPLIT';
    if (!prevP.hands.length || !nextP.hands.length) return null;
    const ph = prevP.hands[prevP.activeHandIdx];
    const nh = nextP.hands[prevP.activeHandIdx];
    if (!ph || !nh) return null;
    if (!ph.surrendered && nh.surrendered) return 'SURRENDER';
    if (!ph.doubled && nh.doubled) {
      const { total, isBust } = Strategy.getHandTotal(nh.cards);
      if (isBust)      return 'BUST';
      if (total === 21) return '21';
      return 'DOUBLE';
    }
    if (nh.cards.length > ph.cards.length) {
      const { total, isBust } = Strategy.getHandTotal(nh.cards);
      if (isBust)      return 'BUST';
      if (total === 21) return '21';
      return 'HIT';
    }
    if (!ph.done && nh.done && !nh.surrendered && !nh.doubled) return 'STAND';
    return null;
  }

  function _showNetToast(pseudo, hand, hi, winIdx = 0) {
    const container = document.getElementById('table-seats');
    const seatEl = container?.querySelector(`[data-pseudo="${CSS.escape(pseudo)}"]`);
    if (!seatEl) return;
    const boxes = seatEl.querySelectorAll('.seat-hand-box');
    const target = boxes[hi] || seatEl;
    const rect = target.getBoundingClientRect();
    const n      = hand.net;
    const isBJ   = _isBlackjack(hand.cards) && !hand.fromSplit && n > 0;
    const isDouble = hand.doubled && n > 0;
    const type   = isBJ ? 'bj' : n > 0 ? (isDouble ? 'double-win' : 'win') : n < 0 ? 'loss' : 'push';
    const cx = rect.left + rect.width / 2;
    const cy = rect.top - 8;
    const toast = document.createElement('div');
    toast.className = 'net-toast net-toast-' + type;
    toast.textContent = (n > 0 ? '+' : '') + '$' + n;
    toast.style.left = cx + 'px';
    toast.style.top  = cy + 'px';
    document.body.appendChild(toast);
    const dur = isBJ ? 3000 : 2200;
    setTimeout(() => toast.remove(), dur + 100);
    const isAllInWin = _allInPlayers.has(pseudo) && n > 0;
    // Fireworks
    if (isAllInWin)    _spawnMassiveFireworks();
    else if (isDouble) _spawnFireworks(cx, cy);
    // All-in win toast (big centered)
    if (isAllInWin) _showAllInWinToast(pseudo, n);
    // Sound — only for my own result
    if (pseudo === myPseudo) {
      if (isAllInWin)    Sounds.blackjack(winIdx); // biggest sound
      else if (isBJ)     Sounds.blackjack(winIdx);
      else if (isDouble) Sounds.doubleWin(winIdx);
      else if (n > 0)    Sounds.win(winIdx);
      else if (n < 0)    Sounds.loss();
      else               Sounds.push();
    }
  }

  // ── Shared firework helpers ────────────────────────────────────
  const _FW_COLORS = ['#34D399','#60A5FA','#C084FC','#FBBF24','#F87171','#fff','#F472B6','#38BDF8','#FB923C','#A78BFA'];

  function _fwBurst(x, y, n, minDist, maxDist, dur, delay = 0, streaks = false) {
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = minDist + Math.random() * (maxDist - minDist);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const size = streaks ? (2 + Math.random() * 2) : (3 + Math.random() * 5);
      const w    = streaks ? size * (3 + Math.random() * 4) : size;
      const rot  = streaks ? (angle * 180 / Math.PI) : 0;
      const col  = _FW_COLORS[Math.floor(Math.random() * _FW_COLORS.length)];
      const p = document.createElement('div');
      p.className = 'firework-particle';
      p.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${size}px;background:${col};`
        + `border-radius:${streaks ? '2px' : '50%'};`
        + `transform:translate(-50%,-50%) rotate(${rot}deg);`
        + `--dx:${dx}px;--dy:${dy}px;--dur:${dur}ms;`
        + `animation-delay:${delay + Math.random() * 60}ms;`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), delay + dur + 200);
    }
  }

  function _fwRing(x, y, delay, radius, dur) {
    const el = document.createElement('div');
    el.className = 'firework-ring';
    el.style.cssText = `left:${x}px;top:${y}px;--r:${radius}px;--dur:${dur}ms;animation-delay:${delay}ms;`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), delay + dur + 100);
  }

  function _spawnFireworks(cx, cy) {
    _fwBurst(cx, cy, 22, 25, 75,  700, 0);
    _fwBurst(cx, cy,  8, 18, 45,  500, 0,   true);
    _fwRing (cx, cy, 0,  50, 500);
    _fwBurst(cx, cy, 14, 55, 110, 800, 160);
    _fwRing (cx, cy, 160, 85, 600);
    const W = window.innerWidth, H = window.innerHeight;
    [[0.18,0.20],[0.82,0.18],[0.10,0.65],[0.90,0.63],[0.50,0.10],[0.30,0.80],[0.72,0.78]]
      .forEach(([fx, fy], i) => {
        const px = fx * W + (Math.random() - 0.5) * 90;
        const py = fy * H + (Math.random() - 0.5) * 60;
        const d  = 200 + i * 120 + Math.random() * 80;
        _fwBurst(px, py, 12 + Math.floor(Math.random() * 8), 18, 62, 700, d);
        _fwBurst(px, py, 4,  12, 38, 550, d, true);
        if (i % 2 === 0) _fwRing(px, py, d, 38, 420);
      });
  }

  function _spawnMassiveFireworks() {
    const W = window.innerWidth, H = window.innerHeight;
    // 20 burst points across the whole screen, 3 waves
    for (let wave = 0; wave < 3; wave++) {
      const count = wave === 0 ? 8 : wave === 1 ? 7 : 5;
      for (let i = 0; i < count; i++) {
        const x = (0.06 + Math.random() * 0.88) * W;
        const y = (0.05 + Math.random() * 0.85) * H;
        const d = wave * 500 + i * 140 + Math.random() * 100;
        _fwBurst(x, y, 22 + Math.floor(Math.random() * 10), 25, 100, 900, d);
        _fwBurst(x, y, 7,  15, 55, 650, d, true);
        _fwRing (x, y, d, 55 + Math.random() * 30, 550);
      }
    }
  }

  function _showAllInAnnounce(pseudo) {
    const isMe = pseudo === myPseudo;
    const toast = document.createElement('div');
    toast.className = 'allin-announce';
    toast.textContent = (isMe ? '★ ' : pseudo + ' — ') + 'ALL IN!';
    toast.style.cssText = `left:50%;top:38%;`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function _showAllInWinToast(pseudo, net) {
    const isMe = pseudo === myPseudo;
    const toast = document.createElement('div');
    toast.className = 'allin-win-toast';
    toast.innerHTML = (isMe ? '★ ' : pseudo + '<br>') + 'ALL IN WIN!<br><span class="allin-win-amount">+$' + net + '</span>';
    toast.style.cssText = `left:50%;top:42%;`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function _showActionToast(pseudo, action) {
    const container = document.getElementById('table-seats');
    const seatEl = container?.querySelector(`[data-pseudo="${CSS.escape(pseudo)}"]`);
    if (!seatEl) return;
    const target = seatEl.querySelector('.seat-hand-box.active-hand')
                || seatEl.querySelector('.seat-hand-box')
                || seatEl;
    const rect = target.getBoundingClientRect();
    const toast = document.createElement('div');
    toast.className = 'action-toast action-toast-' + action.toLowerCase();
    toast.textContent = action;
    toast.style.left = (rect.left + rect.width / 2) + 'px';
    toast.style.top  = (rect.top - 18) + 'px';
    document.body.appendChild(toast);
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
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
    const isIns      = phase === 'INSURANCE' && me && me.hands.length > 0 && !me.insuranceDecided;
    // Auto-decline insurance if toggle is on
    if (isIns && neverInsurance) { send({ type:'insurance', take: false }); }

    document.querySelectorAll('.chip').forEach(btn => {
      if (btn.id === 'btn-auto-bet' || btn.id === 'btn-never-insurance') return;
      btn.disabled = !isIdle || !me;
    });

    const btnIns   = document.getElementById('btn-insurance');
    const btnNoIns = document.getElementById('btn-no-insurance');
    if (btnIns)   { btnIns.hidden   = !isIns; btnIns.disabled   = !isIns; }
    if (btnNoIns) { btnNoIns.hidden = !isIns; btnNoIns.disabled = !isIns; }

    // During other player's turn → enable buttons for pre-select, only if I still have hands to play
    if (isOtherTurn && me?.hands.length && me.hands.some(h => !h.done)) {
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

  // ─── resolve countdown bar (dealer area) ─────────────────────
  function updateResolveTimer(state) {
    const wrap = document.getElementById('resolve-timer-wrap');
    const bar  = document.getElementById('resolve-timer-bar');
    if (!wrap || !bar) return;

    cancelAnimationFrame(_resolveRafId);

    if (state.phase !== 'RESOLVING' || !state.resolveDeadline) {
      wrap.hidden = true;
      return;
    }

    wrap.hidden = false;
    const total    = 4000; // must match RESOLVE_MS on server
    const deadline = state.resolveDeadline;

    function tick() {
      const remaining = Math.max(0, deadline - Date.now());
      bar.style.width = ((remaining / total) * 100) + '%';
      if (remaining > 0) _resolveRafId = requestAnimationFrame(tick);
      else bar.style.width = '0%';
    }

    tick();
  }

  // ─── player turn border countdown ────────────────────────────
  function updatePlayerTimer(state) {
    cancelAnimationFrame(_playerTimerRafId);

    if (state.phase !== 'PLAYER_TURN' || !state.playerDeadline) {
      // Reset any leftover CSS vars
      document.querySelectorAll('.seat.active-seat').forEach(el => {
        el.style.setProperty('--player-timer-pct', '1');
      });
      return;
    }

    const total    = 10000; // must match PLAYER_TURN_MS on server
    const deadline = state.playerDeadline;

    function tick() {
      const el = document.querySelector('.seat.active-seat');
      if (el) {
        const remaining = Math.max(0, deadline - Date.now());
        const pct       = remaining / total;
        el.style.setProperty('--player-timer-pct', pct.toFixed(4));
        const color = pct < 0.25 ? 'var(--red)'
                    : pct < 0.5  ? 'var(--amber)'
                    :               'var(--accent)';
        el.style.setProperty('--player-timer-color', color);
      }
      _playerTimerRafId = requestAnimationFrame(tick);
    }

    tick();
  }

  // ─── insurance countdown bar (reuses bet-timer-wrap) ─────────
  function updateInsuranceTimer(state) {
    const wrap  = document.getElementById('bet-timer-wrap');
    const bar   = document.getElementById('bet-timer-bar');
    const label = document.getElementById('bet-timer-label');
    if (!wrap || !bar || !label) return;

    cancelAnimationFrame(_insuranceTimerRafId);

    if (state.phase !== 'INSURANCE' || !state.insuranceDeadline) return;

    wrap.hidden = false;
    const total    = 8000; // must match INSURANCE_MS on server
    const deadline = state.insuranceDeadline;

    function tick() {
      const remaining = Math.max(0, deadline - Date.now());
      const pct       = remaining / total;
      bar.style.width = (pct * 100) + '%';
      label.textContent = Math.ceil(remaining / 1000) + 's';

      const urgency = pct < 0.25 ? 'critical' : pct < 0.5 ? 'urgent' : '';
      bar.className   = 'bet-timer-bar ' + urgency;
      label.className = 'bet-timer-label ' + urgency;

      if (remaining > 0) _insuranceTimerRafId = requestAnimationFrame(tick);
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
    if (!prevMe || !prevMe.hands.length) return;

    const net = (_prevIdleBalance !== null) ? me.balance - _prevIdleBalance : 0;

    const dealerCards = prevState.dealerCards || [];
    const { total: dt, isBust: dBust } = _htotal(dealerCards);
    const dealerBJ = _isBlackjack(dealerCards);

    const hands = prevMe.hands.map(hand => {
      const { total: pt, isBust: pBust } = _htotal(hand.cards);
      const pBJ = _isBlackjack(hand.cards) && !hand.fromSplit;

      let result;
      if      (hand.surrendered)  result = 'surr';
      else if (pBust)             result = 'bust';
      else if (pBJ && !dealerBJ) result = 'bj';
      else if (pBJ && dealerBJ)  result = 'push';
      else if (dealerBJ)         result = 'loss';
      else if (dBust)            result = 'win';
      else if (pt > dt)          result = 'win';
      else if (pt === dt)        result = 'push';
      else                       result = 'loss';

      return { cards: hand.cards, total: pt, isBust: pBust, result,
               timeline: _buildHandTimeline(hand), bet: hand.bet, fromSplit: hand.fromSplit };
    });

    handHistory.unshift({
      net, dealerCards, dealerTotal: dt, dealerBust: dBust, dealerBJ,
      hands, insurance: _tookInsurance,
    });
    _renderHistory();
  }

  // Reconstruct action timeline from final hand state
  function _buildHandTimeline(hand) {
    const steps = [];
    const cards  = hand.cards;
    // Always start with the 2 initial cards (deal or post-split)
    steps.push({ type: hand.fromSplit ? 'split' : 'deal', cards: cards.slice(0, 2) });
    if (hand.surrendered) { steps.push({ type: 'surrender' }); return steps; }
    if (hand.isAceSplit)   return steps;
    const extra = cards.slice(2);
    if (hand.doubled) {
      steps.push({ type: 'double', card: extra[0] });
    } else {
      const { isBust } = _htotal(cards);
      extra.forEach(c => steps.push({ type: 'hit', card: c }));
      if (!isBust) steps.push({ type: 'stand' });
    }
    return steps;
  }

  function _htotal(cards) {
    let total = 0, aces = 0;
    (cards || []).forEach(c => {
      if (c.faceDown) return;
      const v = _cardValue(c); total += v;
      if (c.rank === 'A') aces++;
    });
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total, isBust: total > 21 };
  }

  // Build HTML tooltip content for a history entry
  function _buildTooltipHTML(entry) {
    const htCard = c => {
      const red = c.suit === '♥' || c.suit === '♦';
      return `<span class="ht-card${red ? ' red' : ''}">${c.rank}${c.suit}</span>`;
    };
    const htAct = (type, label) =>
      `<span class="ht-act ht-act-${type}">${label}</span>`;

    // ── Dealer row ──────────────────────────────────────────────
    const dCards = entry.dealerCards.filter(c => !c.faceDown).map(htCard).join('');
    const dScore = entry.dealerBJ ? 'BJ!' : entry.dealerBust ? 'BUST' : String(entry.dealerTotal);
    const dScoreCls = (entry.dealerBust || entry.dealerBJ) ? (entry.dealerBJ ? 'bj' : 'bust') : '';
    let html = `<div class="ht-dealer-row">
      <span class="ht-lbl">D</span>
      <span class="ht-cards">${dCards}</span>
      <span class="ht-score${dScoreCls ? ' ' + dScoreCls : ''}">${dScore}</span>
    </div><div class="ht-divider"></div>`;

    // ── Hand rows ────────────────────────────────────────────────
    const RLBL = { win:'WIN', loss:'LOSS', push:'PUSH', bust:'BUST', bj:'BJ!', surr:'SURR' };
    const RCLS = { win:'win', loss:'loss', push:'push', bust:'bust', bj:'bj', surr:'surr' };

    entry.hands.forEach((hand, hi) => {
      const labelHtml = entry.hands.length > 1
        ? `<div class="ht-hand-label">HAND ${hi + 1}  ·  $${hand.bet}</div>` : '';

      // Build timeline: action pill + card(s) per step, separated by ›
      const tlParts = hand.timeline.map((step, si) => {
        const arrow = si > 0 ? '<span class="ht-arr">›</span>' : '';
        switch (step.type) {
          case 'deal':
          case 'split': {
            const actLbl = step.type === 'split' ? 'SPLIT' : 'DEAL';
            const initCards = (step.cards || []).map(htCard).join('');
            return arrow + htAct(step.type, actLbl) + initCards;
          }
          case 'hit':
            return arrow + htAct('hit', 'HIT') + (step.card ? htCard(step.card) : '');
          case 'double':
            return arrow + htAct('double', '×2') + (step.card ? htCard(step.card) : '');
          case 'stand':
            return arrow + htAct('stand', 'STAND');
          case 'surrender':
            return arrow + htAct('surrender', 'SURR');
          default:
            return arrow + htAct(step.type, step.type.toUpperCase());
        }
      });

      const hScore = hand.isBust ? 'BUST'
                   : (_isBlackjack(hand.cards) && !hand.fromSplit) ? 'BJ!'
                   : String(hand.total);
      const resLbl = RLBL[hand.result] || hand.result.toUpperCase();
      const resCls = RCLS[hand.result] || hand.result;

      html += `<div class="ht-hand">
        ${labelHtml}
        <div class="ht-tl-row">${tlParts.join('')}</div>
        <div class="ht-outcome">
          <span class="ht-total">${hScore}</span>
          <span class="ht-res ht-res-${resCls}">${resLbl}</span>
        </div>
      </div>`;
    });

    if (entry.insurance !== null) {
      html += `<div class="ht-divider"></div>
        <div class="ht-ins">Insurance : ${entry.insurance ? 'taken' : 'refused'}</div>`;
    }

    return html;
  }

  function _renderHistory() {
    const el = document.getElementById('history-list');
    if (!el) return;
    el.innerHTML = '';
    if (!handHistory.length) {
      el.innerHTML = '<div class="history-empty">No hands yet</div>';
      return;
    }

    handHistory.forEach(entry => {
      const netCls = entry.net > 0 ? 'pos' : entry.net < 0 ? 'neg' : 'zero';
      const sign   = entry.net > 0 ? '+' : '';
      const div    = document.createElement('div');
      const sideCls = entry.net > 0 ? 'h-good' : entry.net < 0 ? 'h-bad' : 'h-push';
      div.className = 'history-entry ' + sideCls;
      div.dataset.htooltip = '1'; // flag; actual HTML built on demand
      div._tooltipEntry = entry;  // store reference

      // ── Line 1 : net + result(s) ──
      const RLBL = { win:'WIN', loss:'LOSS', push:'PUSH', bust:'BUST', bj:'BJ!', surr:'SURR' };
      const RCLS = { win:'win', loss:'loss', push:'push', bust:'bust', bj:'bj', surr:'surr' };
      const resultStr = entry.hands.map(h => {
        const lbl = RLBL[h.result] || h.result.toUpperCase();
        return `<span class="h-result h-result-${RCLS[h.result]}">${lbl}</span>`;
      }).join('<span class="h-result-sep">/</span>');

      const top = document.createElement('div');
      top.className = 'h-line1';
      top.innerHTML = `<span class="h-net h-net-${netCls}">${sign}$${Math.abs(entry.net)}</span>${resultStr}`;
      div.appendChild(top);

      // ── Line 2 : player totals vs dealer ──
      const PSHORT = { surr:'SURR', bust:'BUST', bj:'BJ' };
      const pParts = entry.hands.map(h => {
        const bj = _isBlackjack(h.cards) && !h.fromSplit;
        if (h.result === 'surr') return 'SURR';
        if (bj)      return 'BJ';
        if (h.isBust) return 'BUST';
        return String(h.total);
      });
      const dLabel = entry.dealerBJ ? 'BJ' : entry.dealerBust ? 'BUST' : String(entry.dealerTotal);

      const sub = document.createElement('div');
      sub.className = 'h-line2';
      sub.textContent = pParts.join(' · ') + '  vs  D:' + dLabel;
      div.appendChild(sub);

      el.appendChild(div);
    });
  }

  // ─── floating history tooltip (position:fixed to escape overflow) ──
  function _initHistoryTooltip() {
    const tip = document.createElement('div');
    tip.id = 'h-float-tip';
    tip.hidden = true;
    document.body.appendChild(tip);

    const list = document.getElementById('history-list');
    if (!list) return;

    list.addEventListener('mouseover', e => {
      const entry = e.target.closest('[data-htooltip]');
      if (!entry || !entry._tooltipEntry) { tip.hidden = true; return; }
      tip.innerHTML = _buildTooltipHTML(entry._tooltipEntry);
      tip.hidden = false;
      const r = entry.getBoundingClientRect();
      // Position to the right, clamped to viewport
      const tipH = tip.offsetHeight;
      const top  = Math.min(r.top, window.innerHeight - tipH - 8);
      tip.style.top  = Math.max(8, top) + 'px';
      tip.style.left = (r.right + 10) + 'px';
    });

    list.addEventListener('mouseleave', () => { tip.hidden = true; });
    document.addEventListener('scroll', () => { tip.hidden = true; }, true);
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
    AchievementsClient.init(window._ALL_ACHIEVEMENTS || [], skin => send({ type: 'setSkin', skin }));

    // Join screen
    const joinForm = document.getElementById('join-form');
    if (joinForm) {
      joinForm.addEventListener('submit', e => {
        e.preventDefault();
        Sounds.unlock();
        const input  = document.getElementById('join-pseudo');
        const pseudo = (input?.value || '').trim();
        if (!pseudo) return;
        myPseudo = pseudo;
        send({ type: 'join', pseudo });
      });
    }

    // Betting chips
    document.querySelectorAll('.chip[data-amount]').forEach(btn => {
      btn.addEventListener('click', () => { Sounds.chip(); send({ type:'bet', amount: parseInt(btn.dataset.amount,10) }); });
    });
    document.getElementById('btn-clear-bet')?.addEventListener('click', () => send({ type:'clearBet' }));
    document.getElementById('btn-allin')?.addEventListener('click', () => {
      const me = lastState?.players?.find(p => p.pseudo === myPseudo);
      if (!me || me.balance <= 0) return;
      Sounds.chip();
      send({ type:'clearBet' });
      send({ type:'bet', amount: me.balance });
    });

    // Actions
    const actionBtns = [
      ['btn-hit',       'hit'],
      ['btn-stand',     'stand'],
      ['btn-double',    'double'],
      ['btn-split',     'split'],
      ['btn-surrender', 'surrender'],
    ];
    actionBtns.forEach(([id, action]) => {
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
        send({ type:'action', action });
      });
    });

    // Cancel pre-select
    document.getElementById('preselect-cancel')?.addEventListener('click', () => _setPreSelect(null));

    // Insurance
    document.getElementById('btn-insurance')?.addEventListener('click', () => {
      _tookInsurance = true;
      send({ type:'insurance', take: true });
    });
    document.getElementById('btn-no-insurance')?.addEventListener('click', () => {
      _tookInsurance = false;
      send({ type:'insurance', take: false });
    });

    // Never insurance toggle
    const neverInsBtn = document.getElementById('btn-never-insurance');
    if (neverInsBtn) {
      neverInsBtn.addEventListener('click', () => {
        neverInsurance = !neverInsurance;
        neverInsBtn.classList.toggle('active', neverInsurance);
      });
    }

    // Shuffle
    document.getElementById('btn-shuffle')?.addEventListener('click', () => {
      Sounds.shuffle();
      send({ type:'shuffle' });
    });

    // Auto-bet toggle
    const autoBetBtn = document.getElementById('btn-auto-bet');
    if (autoBetBtn) {
      autoBetBtn.addEventListener('click', () => {
        autoBet = !autoBet;
        autoBetBtn.classList.toggle('active', autoBet);
        send({ type: 'setAutoBet', enabled: autoBet });
        // Only fire a local bet immediately if there's no bet yet (non-all-auto case)
        if (autoBet && lastState?.phase === 'IDLE') {
          const me = lastState.players?.find(p => p.pseudo === myPseudo);
          if (me && me.bet === 0) send({ type:'bet', amount: _lastBetAmount });
        }
      });
    }

    // Achievements button
    document.getElementById('btn-achievements')?.addEventListener('click', () => {
      AchievementsClient.openPanel();
    });

    // Skins button
    document.getElementById('btn-skins')?.addEventListener('click', () => {
      AchievementsClient.openSkinPanel();
    });

    // Refill button
    document.getElementById('btn-refill')?.addEventListener('click', () => {
      send({ type: 'refill' });
    });

    // Strategy toggle
    const stratBtn = document.getElementById('strategy-toggle');
    const panel    = document.getElementById('strategy-panel');
    if (stratBtn && panel) {
      stratBtn.addEventListener('click', () => panel.classList.toggle('collapsed'));
    }

    // History tooltip
    _initHistoryTooltip();

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
