'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { WebSocketServer } = require('ws');
const engine = require('./server/game-engine');
const db     = require('./server/db');
const { ACHIEVEMENT_MAP } = require('./server/achievements-def');

const PORT = process.env.PORT || 3000;

// ─── HTTP server (static files) ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  // Security: stay within project dir
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
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
