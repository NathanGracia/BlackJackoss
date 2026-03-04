'use strict';

// ─── Achievement definitions ──────────────────────────────────────────────────
const ACHIEVEMENTS = [
  // ── Yours ──────────────────────────────────────────────────────────────────
  {
    id:     'first_allin',
    name:   'Tout ou Rien',
    desc:   'Faire un All In pour la première fois',
    reward: { type: 'skin', value: 'theme-fire' },
    icon:   '🔥',
  },
  {
    id:     'allin_win',
    name:   'All In Hero',
    desc:   'Remporter un All In',
    reward: { type: 'balance', value: 500 },
    icon:   '💰',
  },
  {
    id:     'allin_streak_3',
    name:   'Triple Fougue',
    desc:   'Faire All In 3 fois de suite',
    reward: { type: 'skin', value: 'theme-volcano' },
    icon:   '🌋',
  },
  {
    id:     'first_blackjack',
    name:   'Natural',
    desc:   'Obtenir un Blackjack naturel',
    reward: { type: 'balance', value: 300 },
    icon:   '⚡',
  },
  {
    id:     'split_4',
    name:   'Quatuor',
    desc:   'Splitter jusqu\'à 4 mains en un tour',
    reward: { type: 'skin', value: 'theme-kaleidoscope' },
    icon:   '🃏',
  },
  {
    id:     'split_4_win',
    name:   'Maître du Split',
    desc:   'Gagner avec les 4 mains splittées',
    reward: { type: 'balance', value: 1000 },
    icon:   '👑',
  },
  {
    id:     'small_hand_win',
    name:   'David vs Goliath',
    desc:   'Gagner avec une main de 12 ou moins (dealer bust)',
    reward: { type: 'skin', value: 'theme-underdog' },
    icon:   '🐛',
  },
  {
    id:     'first_surrender',
    name:   'Retraite Tactique',
    desc:   'Surrenderer une main pour la première fois',
    reward: { type: 'skin', value: 'theme-zen' },
    icon:   '🏳️',
  },
  {
    id:     'hands_100',
    name:   'Habitué',
    desc:   'Jouer 100 mains',
    reward: { type: 'balance', value: 200 },
    icon:   '🎯',
  },
  {
    id:     'hands_500',
    name:   'Vétéran',
    desc:   'Jouer 500 mains',
    reward: { type: 'skin', value: 'theme-veteran' },
    icon:   '🎖️',
  },
  {
    id:     'losses_500',
    name:   'Masochiste',
    desc:   'Perdre 500 mains',
    reward: { type: 'skin', value: 'theme-pain' },
    icon:   '💀',
  },
  {
    id:     'hands_1000',
    name:   'Légende',
    desc:   'Jouer 1 000 mains',
    reward: { type: 'skin', value: 'theme-legend' },
    icon:   '🌟',
  },
  // ── Extra ───────────────────────────────────────────────────────────────────
  {
    id:     'win_streak_5',
    name:   'En Feu',
    desc:   '5 victoires consécutives',
    reward: { type: 'balance', value: 250 },
    icon:   '🔥',
  },
  {
    id:     'win_streak_10',
    name:   'Inarrêtable',
    desc:   '10 victoires consécutives',
    reward: { type: 'skin', value: 'theme-streak' },
    icon:   '⚡',
  },
  {
    id:     'balance_5000',
    name:   'High Roller',
    desc:   'Atteindre $5 000 de balance',
    reward: { type: 'skin', value: 'theme-vip' },
    icon:   '💎',
  },
  {
    id:     'balance_10000',
    name:   'Millionnaire',
    desc:   'Atteindre $10 000 de balance',
    reward: { type: 'skin', value: 'theme-gold' },
    icon:   '🏆',
  },
  {
    id:     'broke',
    name:   'Rock Bottom',
    desc:   'Tomber à $0 de balance',
    reward: { type: 'skin', value: 'theme-ashes' },
    icon:   '💸',
  },
  {
    id:     'doubles_won_10',
    name:   'Parieur Audacieux',
    desc:   'Gagner 10 doubles down',
    reward: { type: 'balance', value: 500 },
    icon:   '✌️',
  },
  {
    id:     'blackjack_10',
    name:   'Favori des Dieux',
    desc:   'Obtenir 10 Blackjacks',
    reward: { type: 'skin', value: 'theme-divine' },
    icon:   '✨',
  },
];

const ACHIEVEMENT_MAP = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

/**
 * Check which achievements are newly unlocked given updated stats.
 * Returns array of achievement objects that were just unlocked.
 * Caller must call db.unlockAchievement() for each and credit balance rewards.
 */
function checkAchievements(stats, context = {}) {
  const candidates = [];
  const s = stats;

  if (s.all_ins >= 1)               candidates.push('first_allin');
  if (s.all_in_wins >= 1)           candidates.push('allin_win');
  if (s.consecutive_all_ins >= 3)   candidates.push('allin_streak_3');
  if (s.blackjacks >= 1)            candidates.push('first_blackjack');
  if (s.blackjacks >= 10)           candidates.push('blackjack_10');
  if (s.splits4_done >= 1)          candidates.push('split_4');
  if (s.splits4_won >= 1)           candidates.push('split_4_win');
  if (s.small_hand_wins >= 1)       candidates.push('small_hand_win');
  if (s.surrenders >= 1)            candidates.push('first_surrender');
  if (s.hands_played >= 100)        candidates.push('hands_100');
  if (s.hands_played >= 500)        candidates.push('hands_500');
  if (s.hands_played >= 1000)       candidates.push('hands_1000');
  if (s.hands_lost >= 500)          candidates.push('losses_500');
  if (s.win_streak >= 5)            candidates.push('win_streak_5');
  if (s.max_win_streak >= 10)       candidates.push('win_streak_10');
  if (s.doubles_won >= 10)          candidates.push('doubles_won_10');
  if (context.balance >= 5000)      candidates.push('balance_5000');
  if (context.balance >= 10000)     candidates.push('balance_10000');
  if (context.balance === 0)        candidates.push('broke');

  return candidates.map(id => ACHIEVEMENT_MAP[id]).filter(Boolean);
}

module.exports = { ACHIEVEMENTS, ACHIEVEMENT_MAP, checkAchievements };
