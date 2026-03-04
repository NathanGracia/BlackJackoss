'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE  = path.join(DATA_DIR, 'blackjackoss.db');
const DEFAULT_BALANCE = 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    pseudo      TEXT PRIMARY KEY,
    balance     INTEGER NOT NULL DEFAULT ${DEFAULT_BALANCE},
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS player_stats (
    pseudo               TEXT PRIMARY KEY REFERENCES players(pseudo),
    hands_played         INTEGER DEFAULT 0,
    hands_won            INTEGER DEFAULT 0,
    hands_lost           INTEGER DEFAULT 0,
    blackjacks           INTEGER DEFAULT 0,
    surrenders           INTEGER DEFAULT 0,
    all_ins              INTEGER DEFAULT 0,
    all_in_wins          INTEGER DEFAULT 0,
    consecutive_all_ins  INTEGER DEFAULT 0,
    doubles_won          INTEGER DEFAULT 0,
    win_streak           INTEGER DEFAULT 0,
    max_win_streak       INTEGER DEFAULT 0,
    splits4_done         INTEGER DEFAULT 0,
    splits4_won          INTEGER DEFAULT 0,
    small_hand_wins      INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS achievements (
    pseudo          TEXT NOT NULL REFERENCES players(pseudo),
    achievement_id  TEXT NOT NULL,
    unlocked_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (pseudo, achievement_id)
  );
`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const _getPlayer   = db.prepare('SELECT * FROM players WHERE pseudo = ?');
const _upsertPlayer = db.prepare(`
  INSERT INTO players (pseudo, balance) VALUES (?, ?)
  ON CONFLICT(pseudo) DO NOTHING
`);
const _setBalance  = db.prepare('UPDATE players SET balance = ? WHERE pseudo = ?');

const _getStats    = db.prepare('SELECT * FROM player_stats WHERE pseudo = ?');
const _upsertStats = db.prepare(`
  INSERT INTO player_stats (pseudo) VALUES (?)
  ON CONFLICT(pseudo) DO NOTHING
`);
const _updateStats = db.prepare(`
  UPDATE player_stats SET
    hands_played        = hands_played        + @hands_played,
    hands_won           = hands_won           + @hands_won,
    hands_lost          = hands_lost          + @hands_lost,
    blackjacks          = blackjacks          + @blackjacks,
    surrenders          = surrenders          + @surrenders,
    all_ins             = all_ins             + @all_ins,
    all_in_wins         = all_in_wins         + @all_in_wins,
    consecutive_all_ins = @consecutive_all_ins,
    doubles_won         = doubles_won         + @doubles_won,
    win_streak          = @win_streak,
    max_win_streak      = MAX(max_win_streak, @win_streak),
    splits4_done        = splits4_done        + @splits4_done,
    splits4_won         = splits4_won         + @splits4_won,
    small_hand_wins     = small_hand_wins     + @small_hand_wins
  WHERE pseudo = @pseudo
`);

const _getAchievements = db.prepare('SELECT achievement_id, unlocked_at FROM achievements WHERE pseudo = ? ORDER BY unlocked_at ASC');
const _insertAchievement = db.prepare(`
  INSERT OR IGNORE INTO achievements (pseudo, achievement_id) VALUES (?, ?)
`);

// ─── Migrate existing balances.json if present ────────────────────────────────
(function _migrate() {
  const oldFile = path.join(__dirname, '..', 'data', 'balances.json');
  if (!fs.existsSync(oldFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    const migrate = db.transaction(entries => {
      for (const [pseudo, balance] of entries) {
        _upsertPlayer.run(pseudo, balance);
        // If player already existed, update balance only if DB has default
        const row = _getPlayer.get(pseudo);
        if (row && row.balance === DEFAULT_BALANCE) _setBalance.run(balance, pseudo);
      }
    });
    migrate(Object.entries(data));
    fs.renameSync(oldFile, oldFile + '.migrated');
    console.info('[DB] Migrated balances.json → SQLite');
  } catch (e) {
    console.warn('[DB] Migration skipped:', e.message);
  }
})();

// ─── Public API ───────────────────────────────────────────────────────────────
function ensurePlayer(pseudo) {
  _upsertPlayer.run(pseudo, DEFAULT_BALANCE);
  _upsertStats.run(pseudo);
}

function getBalance(pseudo) {
  ensurePlayer(pseudo);
  return _getPlayer.get(pseudo)?.balance ?? DEFAULT_BALANCE;
}

function setBalance(pseudo, amount) {
  ensurePlayer(pseudo);
  _setBalance.run(amount, pseudo);
}

function getStats(pseudo) {
  ensurePlayer(pseudo);
  return _getStats.get(pseudo);
}

/** delta: partial object with only the fields that changed (additive except streaks) */
function updateStats(pseudo, delta) {
  ensurePlayer(pseudo);
  const defaults = {
    hands_played: 0, hands_won: 0, hands_lost: 0, blackjacks: 0,
    surrenders: 0, all_ins: 0, all_in_wins: 0, consecutive_all_ins: 0,
    doubles_won: 0, win_streak: 0, splits4_done: 0, splits4_won: 0,
    small_hand_wins: 0,
  };
  const merged = { ...defaults, ...delta, pseudo };
  _updateStats.run(merged);
}

/** Returns the achievement def if newly unlocked, null if already had it */
function unlockAchievement(pseudo, achievementId) {
  ensurePlayer(pseudo);
  const info = _insertAchievement.run(pseudo, achievementId);
  return info.changes > 0; // true = newly unlocked
}

function getAchievements(pseudo) {
  ensurePlayer(pseudo);
  return _getAchievements.all(pseudo).map(r => r.achievement_id);
}

module.exports = { ensurePlayer, getBalance, setBalance, getStats, updateStats, unlockAchievement, getAchievements };
