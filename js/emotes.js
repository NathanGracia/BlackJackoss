/* ════════════════════════════════════════════════════════════════════
   BlackJackoss — Emotes Client
   Wheel (8 slots) · LoL-style hold G · Customization · Unlocks
   ════════════════════════════════════════════════════════════════════ */

window.EmotesClient = (() => {
  'use strict';

  // ── Emote definitions ────────────────────────────────────────────
  const EMOTES = [
    { id: 'thumbs_up',   emoji: '👍', label: 'Bien joué'      },
    { id: 'thumbs_down', emoji: '👎', label: 'Dommage'        },
    { id: 'lol',         emoji: '😂', label: 'LOL'            },
    { id: 'fire',        emoji: '🔥', label: 'En feu!'        },
    { id: 'dead',        emoji: '💀', label: 'RIP'            },
    { id: 'gg',          emoji: '🎉', label: 'GG!'            },
    { id: 'think',       emoji: '🤔', label: 'Hmm...'         },
    { id: 'cool',        emoji: '😎', label: 'Cool'           },
    // Unlockable via achievements:
    { id: 'blackjack',  emoji: '⚡',  label: 'Blackjack!',    unlockedBy: 'first_blackjack'  },
    { id: 'allin',      emoji: '💰',  label: 'All In!',       unlockedBy: 'allin_win'        },
    { id: 'legendary',  emoji: '🌟',  label: 'Légende',       unlockedBy: 'hands_1000'       },
    { id: 'king',       emoji: '👑',  label: 'Roi du Split',  unlockedBy: 'split_4_win'      },
    { id: 'divine',     emoji: '✨',  label: 'Divin',         unlockedBy: 'blackjack_10'     },
    { id: 'volcano',    emoji: '🌋',  label: 'Triple Fougue', unlockedBy: 'allin_streak_3'   },
  ];

  const EMOTE_MAP   = Object.fromEntries(EMOTES.map(e => [e.id, e]));
  const FREE_IDS    = EMOTES.filter(e => !e.unlockedBy).map(e => e.id);
  const WHEEL_SIZE  = 8;
  const WHEEL_PX    = 220;   // wheel container size
  const RADIUS      = 85;    // slot orbit radius
  const DEAD_ZONE   = 30;    // px from center — no slot selected
  const COOLDOWN_MS = 0;

  let _myPseudo      = null;
  let _send          = null;
  let _unlockedIds   = new Set(FREE_IDS);
  let _wheel         = FREE_IDS.slice(0, WHEEL_SIZE);
  let _cooldownUntil = 0;
  let _wheelOpen     = false;
  let _holdMode      = false;   // true = opened by G key
  let _hoveredSlot   = null;    // 0-7 or null (dead zone)
  let _selectedSlot  = null;    // customize panel
  let _mouseX        = 0;
  let _mouseY        = 0;
  let _lastWheelX    = 0;   // cursor position when wheel was opened (anchor for own emote)
  let _lastWheelY    = 0;

  // Track cursor at all times
  document.addEventListener('mousemove', e => {
    _mouseX = e.clientX;
    _mouseY = e.clientY;
    if (_wheelOpen && _holdMode) _updateHoveredSlot();
  });

  const _lsWheel    = () => `bj-emote-wheel-${_myPseudo || 'guest'}`;
  const _lsUnlocked = () => `bj-emote-unlocked-${_myPseudo || 'guest'}`;

  // ── Persistence ──────────────────────────────────────────────────
  function _save() {
    try {
      localStorage.setItem(_lsWheel(),    JSON.stringify(_wheel));
      localStorage.setItem(_lsUnlocked(), JSON.stringify([..._unlockedIds]));
    } catch(_) {}
  }

  function _load() {
    try {
      const w = JSON.parse(localStorage.getItem(_lsWheel()));
      if (Array.isArray(w) && w.length === WHEEL_SIZE) _wheel = w;
    } catch(_) {}
    try {
      const u = JSON.parse(localStorage.getItem(_lsUnlocked()));
      if (Array.isArray(u)) u.forEach(id => _unlockedIds.add(id));
    } catch(_) {}
  }

  // ── Achievement unlock ────────────────────────────────────────────
  function onAchievementUnlocked(achievementId) {
    const emote = EMOTES.find(e => e.unlockedBy === achievementId);
    if (!emote || _unlockedIds.has(emote.id)) return;
    _unlockedIds.add(emote.id);
    _save();
    _showUnlockToast(emote);
  }

  function _showUnlockToast(emote) {
    const t = document.createElement('div');
    t.className = 'emote-unlock-toast';
    t.innerHTML = `
      <span class="emote-unlock-emoji">${_emoteContent(emote)}</span>
      <div class="emote-unlock-body">
        <span class="emote-unlock-label">Emote débloquée</span>
        <span class="emote-unlock-name">${emote.label}</span>
      </div>
    `;
    document.body.appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 350);
    }, 3500);
  }

  // ── Send ──────────────────────────────────────────────────────────
  function _sendEmote(emoteId) {
    if (!_send || !emoteId) return;
    const now = Date.now();
    if (now < _cooldownUntil) return;
    _cooldownUntil = now + COOLDOWN_MS;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    _send({
      type: 'emote',
      emoteId,
      x: _lastWheelX / vw,
      y: _lastWheelY / vh,
    });
    closeWheel();
    const btn = document.getElementById('btn-emotes');
    if (btn) {
      btn.classList.add('on-cooldown');
      setTimeout(() => btn.classList.remove('on-cooldown'), COOLDOWN_MS);
    }
  }

  // ── Hovered slot detection (hold mode) ───────────────────────────
  function _angleToSlot(dx, dy) {
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0)             a += Math.PI * 2;
    if (a >= Math.PI * 2)  a -= Math.PI * 2;
    return Math.round(a / (Math.PI * 2) * WHEEL_SIZE) % WHEEL_SIZE;
  }

  function _updateHoveredSlot() {
    const wheel = document.querySelector('#emote-wheel-overlay .emote-wheel');
    if (!wheel) return;
    const wr   = wheel.getBoundingClientRect();
    const cx   = wr.left + wr.width  / 2;
    const cy   = wr.top  + wr.height / 2;
    const dx   = _mouseX - cx;
    const dy   = _mouseY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const prev = _hoveredSlot;

    _hoveredSlot = dist < DEAD_ZONE ? null : _angleToSlot(dx, dy);

    if (_hoveredSlot === prev) return;

    wheel.querySelectorAll('.emote-slot').forEach((btn, i) => {
      btn.classList.toggle('wheel-hovered', i === _hoveredSlot);
    });
  }

  // ── Emote wheel ───────────────────────────────────────────────────
  // cx, cy = desired center of the wheel on screen
  // holdMode = true when triggered by G key hold
  function openWheel(cx, cy, holdMode = false) {
    if (_wheelOpen) {
      if (!holdMode) closeWheel();
      return;
    }
    _wheelOpen   = true;
    _holdMode    = holdMode;
    _hoveredSlot = null;
    _lastWheelX  = cx;
    _lastWheelY  = cy;

    // Clamp so wheel stays inside viewport
    const posX = Math.max(8, Math.min(cx - WHEEL_PX / 2, window.innerWidth  - WHEEL_PX - 8));
    const posY = Math.max(8, Math.min(cy - WHEEL_PX / 2, window.innerHeight - WHEEL_PX - 8));

    const overlay = document.createElement('div');
    overlay.id = 'emote-wheel-overlay';

    const wheel = document.createElement('div');
    wheel.className = 'emote-wheel';
    wheel.style.left = `${posX}px`;
    wheel.style.top  = `${posY}px`;

    _wheel.forEach((emoteId, i) => {
      const angle = (i / WHEEL_SIZE) * Math.PI * 2 - Math.PI / 2;
      const x     = Math.round(Math.cos(angle) * RADIUS);
      const y     = Math.round(Math.sin(angle) * RADIUS);

      const btn = document.createElement('button');
      btn.className = 'emote-slot';
      btn.style.left = `${WHEEL_PX / 2 + x - 24}px`;
      btn.style.top  = `${WHEEL_PX / 2 + y - 24}px`;

      const emote  = emoteId ? EMOTE_MAP[emoteId] : null;
      const locked = emote && !_unlockedIds.has(emoteId);

      if (emote && !locked) {
        btn.innerHTML = _emoteContent(emote);
        btn.title = emote.label;
        // Click always works regardless of mode
        btn.addEventListener('click', e => { e.stopPropagation(); _sendEmote(emoteId); });
      } else if (locked) {
        btn.textContent = '🔒';
        btn.title = `${emote.label} — verrouillé`;
        btn.classList.add('slot-locked');
      } else {
        btn.textContent = '·';
        btn.title = 'Slot vide — personnaliser';
        btn.classList.add('slot-empty');
        btn.addEventListener('click', e => { e.stopPropagation(); closeWheel(); openCustomize(i); });
      }

      wheel.appendChild(btn);
    });

    // Center ⚙ button
    const center = document.createElement('button');
    center.className = 'emote-center-btn';
    center.textContent = '⚙';
    center.title = 'Personnaliser la roue';
    center.addEventListener('click', e => { e.stopPropagation(); closeWheel(); openCustomize(); });
    wheel.appendChild(center);

    overlay.appendChild(wheel);
    document.body.appendChild(overlay);

    if (!holdMode) {
      overlay.addEventListener('click', e => { if (e.target === overlay) closeWheel(); });
    }
    document.addEventListener('keydown', _onWheelEsc);

    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('open')));
  }

  function closeWheel() {
    if (!_wheelOpen) return;
    _wheelOpen   = false;
    _holdMode    = false;
    _hoveredSlot = null;
    document.removeEventListener('keydown', _onWheelEsc);
    const ov = document.getElementById('emote-wheel-overlay');
    if (!ov) return;
    ov.classList.remove('open');
    setTimeout(() => ov.remove(), 200);
  }

  function _onWheelEsc(e) {
    if (e.key === 'Escape') closeWheel();
  }

  // ── Display incoming emote ────────────────────────────────────────
  function showIncomingEmote(pseudo, emoteId, xFrac, yFrac) {
    const emote = EMOTE_MAP[emoteId];
    if (!emote) return;

    let anchorX, anchorY;
    if (xFrac != null && yFrac != null) {
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      anchorX = xFrac * vw;
      anchorY = yFrac * vh;
    } else {
      // Fallback: above the sender's seat
      const seatEl = document.querySelector(`#table-seats [data-pseudo="${CSS.escape(pseudo)}"]`);
      if (seatEl) {
        const r = seatEl.getBoundingClientRect();
        anchorX = r.left + r.width / 2;
        anchorY = r.top;
      } else {
        anchorX = window.innerWidth  / 2;
        anchorY = window.innerHeight / 2;
      }
    }

    const el = document.createElement('div');
    el.className = 'emote-popup';
    el.style.left = `${anchorX}px`;
    el.style.top  = `${anchorY}px`;
    el.innerHTML = `
      <div class="emote-popup-emoji">${_emoteContent(emote)}</div>
      <div class="emote-popup-name">${_esc(pseudo)}</div>
    `;
    document.body.appendChild(el);

    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => { el.classList.add('rise'); setTimeout(() => el.remove(), 600); }, 1800);
  }

  // Returns HTML string: <img> if emote has png:true, otherwise the emoji character
  // Returns HTML: <img> if emote has a file defined, otherwise the emoji character
  // emote.file = explicit filename (e.g. 'eric.jpg'), or emote.png = true for '{id}.png'
  function _emoteContent(emote) {
    if (!emote) return '';
    const file = emote.file || (emote.png ? `${emote.id}.png` : null);
    if (file) return `<img src="/emotes/${file}" class="emote-img" alt="${emote.label}" draggable="false">`;
    return emote.emoji;
  }

  function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Customize panel ───────────────────────────────────────────────
  function openCustomize(preselectedSlot = null) {
    _selectedSlot = preselectedSlot;

    let panel = document.getElementById('emote-customize-panel');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'emote-customize-panel';
    panel.innerHTML = `
      <div class="emote-custom-box">
        <div class="emote-custom-header">
          <span class="emote-custom-title">Personnaliser la roue</span>
          <button class="emote-custom-close" id="emote-custom-close">✕</button>
        </div>
        <div class="emote-custom-hint">
          <span id="emote-custom-hint-text">Sélectionnez un slot, puis une émote pour l'assigner</span>
        </div>
        <div class="emote-custom-slots" id="emote-custom-slots"></div>
        <div class="emote-custom-section-title">Émotes disponibles</div>
        <div class="emote-custom-grid" id="emote-custom-grid"></div>
      </div>
    `;
    document.body.appendChild(panel);

    _renderCustomSlots(panel);
    _renderCustomGrid(panel);

    panel.querySelector('#emote-custom-close').addEventListener('click', closeCustomize);
    panel.addEventListener('click', e => { if (e.target === panel) closeCustomize(); });
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open')));
  }

  function _renderCustomSlots(panel) {
    const container = panel.querySelector('#emote-custom-slots');
    container.innerHTML = '';

    const PREV_R  = 62;   // orbit radius in the preview
    const PREV_SZ = 160;  // container size

    const wrap = document.createElement('div');
    wrap.className = 'emote-preview-wheel';

    // Center dead-zone marker
    const center = document.createElement('div');
    center.className = 'emote-preview-center';
    center.textContent = '⚙';
    wrap.appendChild(center);

    _wheel.forEach((emoteId, i) => {
      const angle  = (i / WHEEL_SIZE) * Math.PI * 2 - Math.PI / 2;
      const x      = Math.round(Math.cos(angle) * PREV_R);
      const y      = Math.round(Math.sin(angle) * PREV_R);
      const emote  = emoteId ? EMOTE_MAP[emoteId] : null;
      const locked = emote && !_unlockedIds.has(emoteId);

      const btn = document.createElement('button');
      btn.className = 'emote-preview-slot' + (i === _selectedSlot ? ' selected' : '');
      btn.style.left = `${PREV_SZ / 2 + x - 18}px`;
      btn.style.top  = `${PREV_SZ / 2 + y - 18}px`;
      btn.title = `Slot ${i + 1}`;
      btn.innerHTML = (emote && !locked) ? _emoteContent(emote) : (locked ? '🔒' : '·');
      if (locked) btn.classList.add('slot-locked');
      if (!emote) btn.classList.add('slot-empty');

      btn.addEventListener('click', () => {
        _selectedSlot = (_selectedSlot === i) ? null : i;
        _updateHint(panel);
        _renderCustomSlots(panel);
        _renderCustomGrid(panel);
      });
      wrap.appendChild(btn);
    });

    container.appendChild(wrap);
  }

  function _renderCustomGrid(panel) {
    const grid = panel.querySelector('#emote-custom-grid');
    grid.innerHTML = '';
    EMOTES.forEach(emote => {
      const unlocked = _unlockedIds.has(emote.id);
      const inWheel  = _wheel.includes(emote.id);
      const card = document.createElement('button');
      card.className = ['emote-ecard', !unlocked ? 'locked' : '', inWheel ? 'in-wheel' : '']
        .filter(Boolean).join(' ');
      card.disabled = !unlocked;
      card.innerHTML = `
        <span class="ecard-emoji">${_emoteContent(emote)}</span>
        <span class="ecard-label">${emote.label}</span>
        ${!unlocked ? `<span class="ecard-lock">🔒</span>` : ''}
        ${inWheel && unlocked ? `<span class="ecard-check">✓</span>` : ''}
      `;
      if (unlocked) {
        card.addEventListener('click', () => {
          if (_selectedSlot === null) { _flashHint(panel); return; }
          _wheel[_selectedSlot] = emote.id;
          _save();
          _selectedSlot = null;
          _updateHint(panel);
          _renderCustomSlots(panel);
          _renderCustomGrid(panel);
        });
      }
      grid.appendChild(card);
    });
  }

  function _updateHint(panel) {
    const el = panel.querySelector('#emote-custom-hint-text');
    if (!el) return;
    el.textContent = _selectedSlot !== null
      ? `Slot ${_selectedSlot + 1} sélectionné — cliquez une émote`
      : "Sélectionnez un slot, puis une émote pour l'assigner";
  }

  function _flashHint(panel) {
    const hint = panel.querySelector('.emote-custom-hint');
    if (!hint) return;
    hint.classList.add('flash');
    setTimeout(() => hint.classList.remove('flash'), 600);
  }

  function closeCustomize() {
    const panel = document.getElementById('emote-customize-panel');
    if (!panel) return;
    panel.classList.remove('open');
    setTimeout(() => panel.remove(), 250);
  }

  // ── Load custom emotes from server ───────────────────────────────
  function _loadCustomEmotes() {
    fetch('/api/emotes')
      .then(r => r.json())
      .then(customs => {
        customs.forEach(e => {
          if (!e.id || EMOTE_MAP[e.id]) return; // skip duplicates
          EMOTES.push(e);
          EMOTE_MAP[e.id] = e;
          if (e.free) _unlockedIds.add(e.id);
        });
      })
      .catch(() => {});
  }

  // ── Init ──────────────────────────────────────────────────────────
  function init(pseudo, sendFn) {
    _myPseudo = pseudo;
    _send     = sendFn;
    _load();
    _loadCustomEmotes();

    // Hold G → wheel at cursor; release G → send hovered slot
    document.addEventListener('keydown', e => {
      if (e.repeat || e.key !== 'g' && e.key !== 'G') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      openWheel(_mouseX, _mouseY, true);
    });

    document.addEventListener('keyup', e => {
      if (e.key !== 'g' && e.key !== 'G') return;
      if (!_wheelOpen || !_holdMode) return;
      if (_hoveredSlot !== null) {
        const emoteId = _wheel[_hoveredSlot];
        if (emoteId && _unlockedIds.has(emoteId)) {
          _sendEmote(emoteId);
          return;
        }
      }
      closeWheel();
    });
  }

  return { init, openWheel, closeWheel, showIncomingEmote, onAchievementUnlocked };
})();
