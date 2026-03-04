'use strict';

/**
 * Seed an admin account with all achievements unlocked.
 * Usage: node scripts/seed-admin.js [pseudo]
 * Default pseudo: admin
 */

const db           = require('../server/db');
const { ACHIEVEMENTS } = require('../server/achievements-def');

const pseudo = process.argv[2] || 'admin';

// Ensure player exists
db.ensurePlayer(pseudo);

// Unlock every achievement + credit balance rewards
let credited = 0;
for (const ach of ACHIEVEMENTS) {
  const isNew = db.unlockAchievement(pseudo, ach.id);
  if (isNew && ach.reward.type === 'balance') {
    const current = db.getBalance(pseudo);
    db.setBalance(pseudo, current + ach.reward.value);
    credited += ach.reward.value;
  }
}

const finalBalance = db.getBalance(pseudo);
console.log(`✓ "${pseudo}" : ${ACHIEVEMENTS.length} succès débloqués, +$${credited} crédités, balance finale $${finalBalance}`);
