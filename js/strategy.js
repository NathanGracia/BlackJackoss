/* ═══════════════════════════════════════════════════════════════
   BlackJackoss — Strategy Module (IIFE)
   6 Decks · S17 · DAS · Surrender
   ═══════════════════════════════════════════════════════════════ */

const Strategy = (() => {
  'use strict';

  // ── Dealer upcard columns: indices 0–9 = dealer 2,3,4,5,6,7,8,9,T,A
  const UPCARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; // 11 = Ace
  const UPCARD_LABELS = ['2','3','4','5','6','7','8','9','T','A'];

  // ─────────────────────────────────────────────────────────────
  //  RAW STRATEGY TABLES
  //  Each row: [action vs dealer 2, 3, 4, 5, 6, 7, 8, 9, T, A]
  //  H=Hit, S=Stand, D=Double, P=Split, R=Surrender
  // ─────────────────────────────────────────────────────────────

  /* Hard totals — keys 5–21 (5–8 share same row) */
  const HARD_TABLE = {
    //         2    3    4    5    6    7    8    9    T    A
    5:  ['H','H','H','H','H','H','H','H','H','H'],
    6:  ['H','H','H','H','H','H','H','H','H','H'],
    7:  ['H','H','H','H','H','H','H','H','H','H'],
    8:  ['H','H','H','H','H','H','H','H','H','H'],
    9:  ['H','D','D','D','D','H','H','H','H','H'],
    10: ['D','D','D','D','D','D','D','D','H','H'],
    11: ['D','D','D','D','D','D','D','D','D','D'],
    12: ['H','H','S','S','S','H','H','H','H','H'],
    13: ['S','S','S','S','S','H','H','H','H','H'],
    14: ['S','S','S','S','S','H','H','H','H','H'],
    15: ['S','S','S','S','S','H','H','H','R','H'],
    16: ['S','S','S','S','S','H','H','R','R','R'],
    17: ['S','S','S','S','S','S','S','S','S','S'],
  };
  // 18+ always stand
  for (let i = 18; i <= 21; i++) {
    HARD_TABLE[i] = ['S','S','S','S','S','S','S','S','S','S'];
  }

  // Display rows for hard table (grouped labels)
  const HARD_ROWS = [
    { key: '5-8',  display: '5–8',  values: HARD_TABLE[5] },
    { key: '9',    display: '9',    values: HARD_TABLE[9] },
    { key: '10',   display: '10',   values: HARD_TABLE[10] },
    { key: '11',   display: '11',   values: HARD_TABLE[11] },
    { key: '12',   display: '12',   values: HARD_TABLE[12] },
    { key: '13',   display: '13',   values: HARD_TABLE[13] },
    { key: '14',   display: '14',   values: HARD_TABLE[14] },
    { key: '15',   display: '15',   values: HARD_TABLE[15] },
    { key: '16',   display: '16',   values: HARD_TABLE[16] },
    { key: '17+',  display: '17+',  values: HARD_TABLE[17] },
  ];

  /* Soft totals — key = non-ace card value (2–9, where 9 means A,9+ → A8+) */
  const SOFT_TABLE = {
    //           2    3    4    5    6    7    8    9    T    A
    'A2':  ['H','H','H','D','D','H','H','H','H','H'],
    'A3':  ['H','H','H','D','D','H','H','H','H','H'],
    'A4':  ['H','H','D','D','D','H','H','H','H','H'],
    'A5':  ['H','H','D','D','D','H','H','H','H','H'],
    'A6':  ['H','D','D','D','D','H','H','H','H','H'],
    'A7':  ['S','D','D','D','D','S','S','H','H','H'],
    'A8':  ['S','S','S','S','S','S','S','S','S','S'],
    'A9':  ['S','S','S','S','S','S','S','S','S','S'],
  };

  const SOFT_ROWS = [
    { key: 'A2', display: 'A,2', values: SOFT_TABLE['A2'] },
    { key: 'A3', display: 'A,3', values: SOFT_TABLE['A3'] },
    { key: 'A4', display: 'A,4', values: SOFT_TABLE['A4'] },
    { key: 'A5', display: 'A,5', values: SOFT_TABLE['A5'] },
    { key: 'A6', display: 'A,6', values: SOFT_TABLE['A6'] },
    { key: 'A7', display: 'A,7', values: SOFT_TABLE['A7'] },
    { key: 'A8+',display: 'A,8+',values: SOFT_TABLE['A8'] },
  ];

  /* Pairs — key = pair value (2–11, 11=Ace) */
  const PAIRS_TABLE = {
    //            2    3    4    5    6    7    8    9    T    A
    '22':   ['P','P','P','P','P','P','H','H','H','H'],
    '33':   ['P','P','P','P','P','P','H','H','H','H'],
    '44':   ['H','H','H','P','P','H','H','H','H','H'],
    '55':   ['D','D','D','D','D','D','D','D','H','H'],
    '66':   ['P','P','P','P','P','H','H','H','H','H'],
    '77':   ['P','P','P','P','P','P','H','H','H','H'],
    '88':   ['P','P','P','P','P','P','P','P','P','P'],
    '99':   ['P','P','P','P','P','S','P','P','S','S'],
    'TT':   ['S','S','S','S','S','S','S','S','S','S'],
    'AA':   ['P','P','P','P','P','P','P','P','P','P'],
  };

  const PAIRS_ROWS = [
    { key: '22',  display: '2,2',  values: PAIRS_TABLE['22'] },
    { key: '33',  display: '3,3',  values: PAIRS_TABLE['33'] },
    { key: '44',  display: '4,4',  values: PAIRS_TABLE['44'] },
    { key: '55',  display: '5,5',  values: PAIRS_TABLE['55'] },
    { key: '66',  display: '6,6',  values: PAIRS_TABLE['66'] },
    { key: '77',  display: '7,7',  values: PAIRS_TABLE['77'] },
    { key: '88',  display: '8,8',  values: PAIRS_TABLE['88'] },
    { key: '99',  display: '9,9',  values: PAIRS_TABLE['99'] },
    { key: 'TT',  display: 'T,T',  values: PAIRS_TABLE['TT'] },
    { key: 'AA',  display: 'A,A',  values: PAIRS_TABLE['AA'] },
  ];

  // ─────────────────────────────────────────────────────────────
  //  HAND ANALYSIS HELPERS
  // ─────────────────────────────────────────────────────────────

  /**
   * Returns the blackjack value of a card (1–10, Ace=11 initially handled separately).
   * card = { rank: '2'..'9','T','J','Q','K','A', suit: ... }
   */
  function cardValue(card) {
    const r = card.rank;
    if (r === 'A') return 11;
    if (['T','J','Q','K'].includes(r)) return 10;
    return parseInt(r, 10);
  }

  /**
   * Compute optimal total for a hand (array of cards).
   * Returns { total, isSoft, isBust }
   */
  function getHandTotal(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards) {
      if (c.faceDown) continue; // skip hidden cards
      const v = cardValue(c);
      total += v;
      if (c.rank === 'A') aces++;
    }
    // Reduce aces from 11→1 as needed
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }
    return { total, isSoft: aces > 0, isBust: total > 21 };
  }

  /**
   * Get the total including face-down cards (for dealer reveal).
   */
  function getFullHandTotal(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards) {
      const v = cardValue(c);
      total += v;
      if (c.rank === 'A') aces++;
    }
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }
    return { total, isSoft: aces > 0, isBust: total > 21 };
  }

  /**
   * getSoftInfo — for a 2-card soft hand, returns the non-ace card value.
   * For multi-card hands, returns the value excluding the highest ace counted as 11.
   * Returns { isSoft, otherCardValue } where otherCardValue is the "other" card total.
   */
  function getSoftInfo(cards) {
    const { total, isSoft } = getHandTotal(cards);
    if (!isSoft) return { isSoft: false, otherCardValue: null };
    // total = 11 + X  =>  X = total - 11
    return { isSoft: true, otherCardValue: total - 11 };
  }

  // ─────────────────────────────────────────────────────────────
  //  STRATEGY LOOKUP
  // ─────────────────────────────────────────────────────────────

  /**
   * Dealer upcard → column index (0–9)
   */
  function dealerColIndex(dealerUpcard) {
    // dealerUpcard = card value 2–11 (11=Ace, 10=T/J/Q/K)
    if (dealerUpcard === 11) return 9;  // Ace
    if (dealerUpcard === 10) return 8;  // Ten
    return dealerUpcard - 2;           // 2→0, 3→1, …, 9→7
  }

  /**
   * Main strategy lookup.
   * @param {Array}  hand           — array of card objects
   * @param {number} dealerUpcard   — dealer visible card value (2–11)
   * @param {Object} opts           — { canDouble, canSplit, canSurrender, isFirstAction }
   * @returns {{ action, tableType, rowKey }}
   *   action: 'H','S','D','P','R'
   *   tableType: 'hard'|'soft'|'pairs'
   *   rowKey: string matching a row key in the table
   */
  function getAction(hand, dealerUpcard, opts = {}) {
    const {
      canDouble    = true,
      canSplit     = true,
      canSurrender = true,
      isFirstAction= true,
    } = opts;

    const col = dealerColIndex(dealerUpcard);
    const visibleCards = hand.filter(c => !c.faceDown);

    // ── 1. Check for pairs (only on first two cards)
    if (canSplit && visibleCards.length === 2) {
      const v1 = cardValue(visibleCards[0]);
      const v2 = cardValue(visibleCards[1]);
      if (v1 === v2) {
        const pairKey = _pairKey(visibleCards[0]);
        if (PAIRS_TABLE[pairKey]) {
          let action = PAIRS_TABLE[pairKey][col];
          action = degradeAction(action, { canDouble, canSplit, canSurrender });
          return { action, tableType: 'pairs', rowKey: pairKey };
        }
      }
    }

    // ── 2. Check for soft hand
    const { isSoft, otherCardValue } = getSoftInfo(visibleCards);
    if (isSoft) {
      const softKey = _softKey(otherCardValue);
      const row = SOFT_TABLE[softKey];
      if (row) {
        let action = row[col];
        action = degradeAction(action, { canDouble, canSplit, canSurrender });
        return { action, tableType: 'soft', rowKey: softKey };
      }
    }

    // ── 3. Hard total
    const { total } = getHandTotal(visibleCards);
    const hardKey = _hardKey(total);
    const row = HARD_TABLE[Math.min(total, 17)];
    let action = row ? row[col] : 'S';
    // Surrender only on first action
    if (action === 'R' && !isFirstAction) action = 'H';
    action = degradeAction(action, { canDouble, canSplit, canSurrender });
    return { action, tableType: 'hard', rowKey: hardKey };
  }

  /**
   * Degrade an action when it's not available.
   * D→H (or S for soft stands), R→H, P→H/S
   */
  function degradeAction(action, { canDouble, canSplit, canSurrender }) {
    if (action === 'P' && !canSplit) action = 'H';
    if (action === 'D' && !canDouble) action = 'H';
    if (action === 'R' && !canSurrender) action = 'H';
    return action;
  }

  // ─────────────────────────────────────────────────────────────
  //  KEY HELPERS
  // ─────────────────────────────────────────────────────────────

  function _pairKey(card) {
    const v = cardValue(card);
    if (v === 11) return 'AA';
    if (v === 10) return 'TT';
    return String(v) + String(v);
  }

  function _softKey(otherValue) {
    // otherValue = total - 11 (the non-ace part)
    if (otherValue <= 2) return 'A2';
    if (otherValue === 3) return 'A3';
    if (otherValue === 4) return 'A4';
    if (otherValue === 5) return 'A5';
    if (otherValue === 6) return 'A6';
    if (otherValue === 7) return 'A7';
    return 'A8'; // A8, A9 both "A8+"
  }

  function _hardKey(total) {
    if (total <= 8) return '5-8';
    if (total >= 17) return '17+';
    return String(total);
  }

  /**
   * Get the rowKey for the current strategy row
   * (convenience used by game.js to pass to highlightRow)
   */
  function getRowKey(hand, dealerUpcard, opts) {
    return getAction(hand, dealerUpcard, opts).rowKey;
  }

  // ─────────────────────────────────────────────────────────────
  //  CHART RENDERING
  // ─────────────────────────────────────────────────────────────

  function _buildTable(rows, id) {
    const table = document.createElement('table');
    table.className = 'strategy-table';
    table.dataset.tableId = id;

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const thEmpty = document.createElement('th');
    thEmpty.className = 'row-header';
    thEmpty.textContent = '';
    headerRow.appendChild(thEmpty);
    UPCARD_LABELS.forEach(label => {
      const th = document.createElement('th');
      th.textContent = label;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    const tbody = document.createElement('tbody');
    rows.forEach(row => {
      const tr = document.createElement('tr');
      tr.dataset.rowKey = row.key;

      const tdKey = document.createElement('td');
      tdKey.className = 'row-key';
      tdKey.textContent = row.display;
      tr.appendChild(tdKey);

      row.values.forEach(action => {
        const td = document.createElement('td');
        td.textContent = action;
        td.className = 'cell-' + action;
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    return table;
  }

  function renderCharts() {
    const hardEl = document.getElementById('chart-hard');
    const softEl = document.getElementById('chart-soft');
    const pairsEl = document.getElementById('chart-pairs');

    if (hardEl)  { hardEl.innerHTML = '';  hardEl.appendChild(_buildTable(HARD_ROWS,  'hard')); }
    if (softEl)  { softEl.innerHTML = '';  softEl.appendChild(_buildTable(SOFT_ROWS,  'soft')); }
    if (pairsEl) { pairsEl.innerHTML = ''; pairsEl.appendChild(_buildTable(PAIRS_ROWS,'pairs')); }
  }

  /**
   * Highlight a specific row in the strategy charts.
   * @param {string} tableType  — 'hard'|'soft'|'pairs'
   * @param {string} rowKey     — row key string
   */
  function highlightRow(tableType, rowKey) {
    // Clear all highlights first
    document.querySelectorAll('.strategy-table tr.highlight-row').forEach(el => {
      el.classList.remove('highlight-row');
    });

    if (!tableType || !rowKey) return;

    const table = document.querySelector(`.strategy-table[data-table-id="${tableType}"]`);
    if (!table) return;

    const row = table.querySelector(`tr[data-row-key="${rowKey}"]`);
    if (row) {
      row.classList.add('highlight-row');
      // Scroll into view within the strategy panel
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * Clear all strategy highlights.
   */
  function clearHighlights() {
    document.querySelectorAll('.strategy-table tr.highlight-row').forEach(el => {
      el.classList.remove('highlight-row');
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  PUBLIC API
  // ─────────────────────────────────────────────────────────────
  return {
    getAction,
    getHandTotal,
    getFullHandTotal,
    getSoftInfo,
    renderCharts,
    highlightRow,
    clearHighlights,
    cardValue,
    degradeAction,
  };

})();
