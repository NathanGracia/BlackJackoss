'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { WebSocketServer } = require('ws');
const engine = require('./server/game-engine');
const db     = require('./server/db');
const { ACHIEVEMENT_MAP } = require('./server/achievements-def');

const PORT = process.env.PORT || 3000;

// ─── Admin password (reuses token.txt / DETERMINOSS_TOKEN) ────────────────────
let ADMIN_PASSWORD = '';
try {
  ADMIN_PASSWORD = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim();
} catch (_) {
  ADMIN_PASSWORD = process.env.DETERMINOSS_TOKEN || '';
}
if (ADMIN_PASSWORD) {
  console.info('[Config] Admin password loaded from token');
} else {
  console.warn('[Config] No token set — admin endpoints are open');
}

function checkAdminAuth(req) {
  if (!ADMIN_PASSWORD) return true;
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${ADMIN_PASSWORD}`;
}

// ─── Custom emotes helpers ─────────────────────────────────────────────────────
const EMOTES_FILE = path.join(__dirname, 'data', 'emotes-custom.json');
const EMOTES_DIR  = path.join(__dirname, 'emotes');
if (!fs.existsSync(EMOTES_DIR)) fs.mkdirSync(EMOTES_DIR);

function readCustomEmotes() {
  try { return JSON.parse(fs.readFileSync(EMOTES_FILE, 'utf8')); } catch(_) { return []; }
}
function writeCustomEmotes(arr) {
  fs.writeFileSync(EMOTES_FILE, JSON.stringify(arr, null, 2));
}

// ─── HTTP server (static files + admin API) ───────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // ── GET /api/emotes ─────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/emotes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readCustomEmotes()));
    return;
  }

  // ── POST /api/admin/emotes ──────────────────────────────────────
  if (req.method === 'POST' && url === '/api/admin/emotes') {
    if (!checkAdminAuth(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }); res.end('Unauthorized'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, label, emoji, free, unlockedBy, fileData, fileExt } = JSON.parse(body);
        const safeId = String(id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
        if (!safeId || !label) { res.writeHead(400); res.end('id and label required'); return; }
        const emotes = readCustomEmotes();
        if (emotes.find(e => e.id === safeId)) { res.writeHead(409); res.end('ID already exists'); return; }
        const emote = { id: safeId, label: String(label).slice(0, 40), emoji: String(emoji || '🖼️') };
        if (free || !unlockedBy) emote.free = true;
        if (unlockedBy) emote.unlockedBy = String(unlockedBy);
        if (fileData && fileExt) {
          const allowed = ['png','jpg','jpeg','webp','gif'];
          const ext = String(fileExt).toLowerCase().replace(/[^a-z]/g,'');
          if (!allowed.includes(ext)) { res.writeHead(400); res.end('Invalid file type'); return; }
          const file = `${safeId}.${ext}`;
          fs.writeFileSync(path.join(EMOTES_DIR, file), Buffer.from(fileData, 'base64'));
          emote.file = file;
        }
        emotes.push(emote);
        writeCustomEmotes(emotes);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(emote));
      } catch(e) { res.writeHead(500); res.end('Server error'); }
    });
    return;
  }

  // ── DELETE /api/admin/emotes/:id ────────────────────────────────
  if (req.method === 'DELETE' && url.startsWith('/api/admin/emotes/')) {
    if (!checkAdminAuth(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }); res.end('Unauthorized'); return; }
    const id = url.slice('/api/admin/emotes/'.length);
    const emotes = readCustomEmotes();
    const idx = emotes.findIndex(e => e.id === id);
    if (idx < 0) { res.writeHead(404); res.end('Not found'); return; }
    const [removed] = emotes.splice(idx, 1);
    if (removed.file) {
      try { fs.unlinkSync(path.join(EMOTES_DIR, removed.file)); } catch(_) {}
    }
    writeCustomEmotes(emotes);
    res.writeHead(200); res.end('OK');
    return;
  }

  // ── Static files ────────────────────────────────────────────────
  let filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  // Clean URLs: if no extension, try appending .html
  if (!path.extname(filePath)) filePath += '.html';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// pseudo → ws
const clients = new Map();

engine.setBroadcastFn(stateSnapshot => {
  const msg = JSON.stringify({ type: 'state', state: stateSnapshot });
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
});

engine.setAchievementFn((pseudo, msg) => {
  const ws = clients.get(pseudo);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
});

// Load Determinoss token: token.txt → env var
try {
  const tok = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim();
  if (tok) { engine.setToken(tok); console.info('[Config] Token loaded from token.txt'); }
} catch (_) {
  const tok = process.env.DETERMINOSS_TOKEN || '';
  if (tok) { engine.setToken(tok); console.info('[Config] Token loaded from env'); }
}

wss.on('connection', ws => {
  let myPseudo = null;

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch(_) { return; }

    // ── join ────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const pseudo = String(msg.pseudo || '').trim().slice(0, 20);
      if (!pseudo) { ws.send(JSON.stringify({ type:'error', message:'Invalid pseudo' })); return; }
      myPseudo = pseudo;
      clients.set(pseudo, ws);
      const p = engine.playerJoin(pseudo);
      ws.send(JSON.stringify({ type:'welcome', pseudo, balance: p.balance }));
      // Send unlocked achievements
      const unlocked = db.getAchievements(pseudo).map(id => ACHIEVEMENT_MAP[id]).filter(Boolean);
      ws.send(JSON.stringify({ type:'achievements', list: unlocked }));
      // Send current state to new client
      ws.send(JSON.stringify({ type:'state', state: engine.buildPublicState() }));
      return;
    }

    if (!myPseudo) { ws.send(JSON.stringify({ type:'error', message:'Join first' })); return; }

    // ── bet ─────────────────────────────────────────────────────
    if (msg.type === 'bet') {
      const r = engine.playerBet(myPseudo, Number(msg.amount) || 0);
      if (r.error) ws.send(JSON.stringify({ type:'error', message: r.error }));
      return;
    }

    // ── clearBet ────────────────────────────────────────────────
    if (msg.type === 'clearBet') {
      const r = engine.playerClearBet(myPseudo);
      if (r.error) ws.send(JSON.stringify({ type:'error', message: r.error }));
      return;
    }

    // ── action ──────────────────────────────────────────────────
    if (msg.type === 'action') {
      const actions = { hit: engine.actionHit, stand: engine.actionStand,
                        double: engine.actionDouble, split: engine.actionSplit,
                        surrender: engine.actionSurrender };
      const fn = actions[msg.action];
      if (!fn) { ws.send(JSON.stringify({ type:'error', message:'Unknown action' })); return; }
      const r = fn(myPseudo);
      if (r && r.error) ws.send(JSON.stringify({ type:'error', message: r.error }));
      return;
    }

    // ── insurance ───────────────────────────────────────────────
    if (msg.type === 'insurance') {
      const r = await engine.playerInsurance(myPseudo, !!msg.take);
      if (r && r.error) ws.send(JSON.stringify({ type:'error', message: r.error }));
      return;
    }

    // ── setAutoBet ──────────────────────────────────────────────
    if (msg.type === 'setAutoBet') {
      engine.playerSetAutoBet(myPseudo, !!msg.enabled);
      return;
    }

    // ── refill ──────────────────────────────────────────────────
    if (msg.type === 'refill') {
      const r = engine.playerRefill(myPseudo);
      if (r && r.error) ws.send(JSON.stringify({ type: 'error', message: r.error }));
      return;
    }

    // ── setSkin ─────────────────────────────────────────────────
    if (msg.type === 'setSkin') {
      engine.playerSetSkin(myPseudo, String(msg.skin || ''));
      return;
    }

    // ── shuffle ─────────────────────────────────────────────────
    if (msg.type === 'shuffle') {
      const r = await engine.forceShuffle(myPseudo);
      if (r && r.error) ws.send(JSON.stringify({ type:'error', message: r.error }));
      return;
    }

    // ── chat ─────────────────────────────────────────────────────
    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 80);
      if (!text) return;
      const out = JSON.stringify({ type: 'chat', pseudo: myPseudo, text });
      wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) client.send(out);
      });
      return;
    }

    // ── emote ────────────────────────────────────────────────────
    if (msg.type === 'emote') {
      const emoteId = String(msg.emoteId || '').trim().slice(0, 30);
      if (!emoteId) return;
      const x = typeof msg.x === 'number' ? Math.max(0, Math.min(1, msg.x)) : null;
      const y = typeof msg.y === 'number' ? Math.max(0, Math.min(1, msg.y)) : null;
      const out = JSON.stringify({ type: 'emote', pseudo: myPseudo, emoteId, x, y });
      wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) client.send(out);
      });
      return;
    }
  });

  ws.on('close', () => {
    if (myPseudo) {
      clients.delete(myPseudo);
      engine.playerDisconnect(myPseudo);
    }
  });
});

httpServer.listen(PORT, () => {
  console.info(`BlackJackoss server running → http://localhost:${PORT}`);
});
