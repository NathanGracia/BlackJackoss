/* ════════════════════════════════════════════════════════════════════
   BlackJackoss — Achievements Client
   ════════════════════════════════════════════════════════════════════ */

window.AchievementsClient = (() => {
  'use strict';

  const TOTAL = 19;
  let _unlocked = [];   // full achievement objects
  let _activeSkin    = '';
  let _panelOpen     = false;
  let _skinPanelOpen = false;
  let _sendSkin      = null;  // injected by game.js

  const SKIN_NAMES = {
    'theme-fire':         'Feu',
    'theme-volcano':      'Volcan',
    'theme-kaleidoscope': 'Kaléidoscope',
    'theme-underdog':     'Underdog',
    'theme-zen':          'Zen',
    'theme-veteran':      'Vétéran',
    'theme-pain':         'Douleur',
    'theme-legend':       'Légende',
    'theme-streak':       'Streak',
    'theme-vip':          'VIP',
    'theme-gold':         'Or',
    'theme-ashes':        'Cendres',
    'theme-divine':       'Divin',
  };

  // ── Toast queue (avoid overlapping) ────────────────────────────────
  const _queue  = [];
  let   _showing = false;

  function _showNext() {
    if (_showing || !_queue.length) return;
    _showing = true;
    const ach = _queue.shift();
    _renderToast(ach);
  }

  function _renderToast(ach) {
    const rewardType = ach.reward.type;
    const rewardText = rewardType === 'balance'
      ? '+$' + ach.reward.value
      : 'SKIN';

    const toast = document.createElement('div');
    toast.className = 'achievement-toast';
    toast.innerHTML = `
      <div class="ach-toast-icon">${ach.icon}</div>
      <div class="ach-toast-body">
        <div class="ach-toast-label">Succès débloqué</div>
        <div class="ach-toast-name">${ach.name}</div>
        <div class="ach-toast-desc">${ach.desc}</div>
      </div>
      <div class="ach-toast-reward reward-${rewardType}">${rewardText}</div>
      <div class="ach-toast-progress">
        <div class="ach-toast-progress-bar" style="animation-duration:5s"></div>
      </div>
    `;
    document.body.appendChild(toast);

    const remove = () => {
      toast.classList.add('hiding');
      setTimeout(() => { toast.remove(); _showing = false; _showNext(); }, 380);
    };
    toast.addEventListener('click', remove);
    setTimeout(remove, 5000);
  }

  function notify(ach) {
    _queue.push(ach);
    _showNext();
  }

  // ── Skin application ────────────────────────────────────────────────
  function _applySkin(skinValue) {
    _activeSkin = skinValue;
    if (_sendSkin) _sendSkin(skinValue);  // game.js handles localStorage
    _refreshSkinButtons();
  }

  function _refreshSkinButtons() {
    document.querySelectorAll('.skin-card-btn').forEach(btn => {
      const isActive = btn.dataset.skin === _activeSkin;
      btn.classList.toggle('active-skin', isActive);
      btn.textContent = isActive ? 'Actif' : 'Appliquer';
    });
  }

  // ── Fake hand preview ────────────────────────────────────────────────
  function _buildPreview(skinClass) {
    const PREVIEW_HAND = [
      { rank: 'A', suit: '♠', red: false },
      { rank: 'K', suit: '♥', red: true  },
    ];
    const cards = PREVIEW_HAND.map(c =>
      `<div class="skin-preview-card${c.red ? ' red' : ''}">
        <span class="skin-card-rank">${c.rank}</span>
        <span class="skin-card-suit">${c.suit}</span>
      </div>`
    ).join('');

    return `
      <div class="seat skin-preview-seat ${skinClass}">
        <div class="skin-preview-name">Joueur</div>
        <div class="skin-preview-cards">${cards}</div>
        <div class="skin-preview-total">BJ!</div>
      </div>
    `;
  }

  // ── Skins panel ──────────────────────────────────────────────────────
  function _buildSkinPanel() {
    let panel = document.getElementById('skins-panel');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'skins-panel';

    const unlockedSkins = _unlocked
      .filter(a => a.reward.type === 'skin')
      .map(a => a.reward.value);

    const hasAnySkin = unlockedSkins.length > 0;

    panel.innerHTML = `
      <div class="skin-panel-box">
        <div class="skin-panel-header">
          <div class="skin-panel-title">🎨 Skins</div>
          <div class="skin-panel-count">${unlockedSkins.length} / ${Object.keys(SKIN_NAMES).length} débloqués</div>
          <button class="skin-panel-close" id="skin-panel-close">✕</button>
        </div>
        <div class="skin-panel-grid" id="skin-panel-grid"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const grid = panel.querySelector('#skin-panel-grid');

    if (!hasAnySkin) {
      grid.innerHTML = `
        <div class="skin-panel-empty">
          <div class="skin-panel-empty-icon">🔒</div>
          <div>Aucun skin débloqué.</div>
          <div class="skin-panel-empty-sub">Complétez des succès pour obtenir des skins.</div>
        </div>
      `;
    } else {
      unlockedSkins.forEach(skinClass => {
        const name    = SKIN_NAMES[skinClass] || skinClass;
        const isActive = skinClass === _activeSkin;

        const card = document.createElement('div');
        card.className = 'skin-card' + (isActive ? ' skin-card-active' : '');
        card.innerHTML = `
          ${_buildPreview(skinClass)}
          <div class="skin-card-footer">
            <span class="skin-card-name">${name}</span>
            <button class="skin-card-btn${isActive ? ' active-skin' : ''}" data-skin="${skinClass}">
              ${isActive ? 'Actif' : 'Appliquer'}
            </button>
          </div>
        `;
        grid.appendChild(card);
      });
    }

    // ── Current skin: "Aucun" reset option ──
    if (hasAnySkin) {
      const resetRow = document.createElement('div');
      resetRow.className = 'skin-reset-row';
      resetRow.innerHTML = `
        <button class="skin-reset-btn" id="skin-reset-btn">
          Retirer le skin
        </button>
      `;
      panel.querySelector('.skin-panel-box').appendChild(resetRow);
      panel.querySelector('#skin-reset-btn').addEventListener('click', () => {
        _applySkin('');
        _buildSkinPanel();
      });
    }

    // Events
    panel.querySelector('#skin-panel-close').addEventListener('click', closeSkinPanel);
    panel.addEventListener('click', e => { if (e.target === panel) closeSkinPanel(); });
    panel.querySelectorAll('.skin-card-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _applySkin(_activeSkin === btn.dataset.skin ? '' : btn.dataset.skin);
        _buildSkinPanel();
      });
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => { panel.classList.add('open'); });
    });
  }

  function openSkinPanel() {
    _skinPanelOpen = true;
    _buildSkinPanel();
  }

  function closeSkinPanel() {
    _skinPanelOpen = false;
    const panel = document.getElementById('skins-panel');
    if (!panel) return;
    panel.classList.remove('open');
    setTimeout(() => panel.remove(), 300);
  }

  // ── Achievements gallery panel ────────────────────────────────────────
  function _buildPanel() {
    let panel = document.getElementById('achievements-panel');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'achievements-panel';

    const unlockedIds = new Set(_unlocked.map(a => a.id));
    const count = unlockedIds.size;
    const allDefs = window._ALL_ACHIEVEMENTS || [];

    panel.innerHTML = `
      <div class="ach-panel-box">
        <div class="ach-panel-header">
          <div class="ach-panel-title">🏆 Succès</div>
          <div class="ach-panel-count"><span>${count}</span>/${TOTAL} débloqués</div>
          <button class="ach-panel-close" id="ach-panel-close">✕</button>
        </div>
        <div class="ach-panel-grid" id="ach-panel-grid"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const grid = panel.querySelector('#ach-panel-grid');
    allDefs.forEach(ach => {
      const isUnlocked = unlockedIds.has(ach.id);
      const rewardText = ach.reward.type === 'balance' ? '+$' + ach.reward.value : 'SKIN';

      const card = document.createElement('div');
      card.className = 'ach-card ' + (isUnlocked ? 'unlocked' : 'locked');
      card.innerHTML = `
        <div class="ach-card-glow"></div>
        <div class="ach-card-top">
          <div class="ach-card-icon">${ach.icon}</div>
          <div class="ach-card-name">${ach.name}</div>
        </div>
        <div class="ach-card-desc">${ach.desc}</div>
        <div class="ach-card-footer">
          <div class="ach-card-reward reward-${ach.reward.type}">${rewardText}</div>
          ${!isUnlocked ? '<span class="ach-card-lock">🔒</span>' : ''}
        </div>
      `;
      grid.appendChild(card);
    });

    panel.querySelector('#ach-panel-close').addEventListener('click', closePanel);
    panel.addEventListener('click', e => { if (e.target === panel) closePanel(); });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => { panel.classList.add('open'); });
    });
  }

  function openPanel()  {
    _panelOpen = true;
    _buildPanel();
  }

  function closePanel() {
    _panelOpen = false;
    const panel = document.getElementById('achievements-panel');
    if (!panel) return;
    panel.classList.remove('open');
    setTimeout(() => panel.remove(), 300);
  }

  // ── Update button counter ────────────────────────────────────────────
  function _updateHeaderBtn() {
    const countEl = document.querySelector('.ach-btn-count');
    if (countEl) countEl.textContent = _unlocked.length;
  }

  // ── Public API ───────────────────────────────────────────────────────
  function init(allAchievements, sendSkinFn) {
    window._ALL_ACHIEVEMENTS = allAchievements;
    if (sendSkinFn) _sendSkin = sendSkinFn;
    _updateHeaderBtn();
  }

  function setSkin(skinValue) {
    _activeSkin = skinValue;
    _refreshSkinButtons();
  }

  function setUnlocked(list) {
    _unlocked = list;
    _updateHeaderBtn();
    if (_panelOpen)     _buildPanel();
    if (_skinPanelOpen) _buildSkinPanel();
  }

  function onUnlocked(ach) {
    if (!_unlocked.find(a => a.id === ach.id)) {
      _unlocked.push(ach);
    }
    notify(ach);
    _updateHeaderBtn();
    if (_panelOpen)     _buildPanel();
    if (_skinPanelOpen) _buildSkinPanel();
  }

  return { init, setUnlocked, setSkin, onUnlocked, openPanel, closePanel, openSkinPanel, closeSkinPanel };
})();
