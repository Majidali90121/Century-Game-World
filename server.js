'use strict';
/* CENTURY web server: zero npm dependencies.
   - Static files for the browser client
   - JSON API for actions (POST)
   - Server-Sent Events for live, per-player state pushes (a player only ever
     receives their own hand)
   Rooms live in memory (see README for what that means on free hosting). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Game, GameError } = require('./lib/game');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const MAX_PLAYERS = 8;
const MAX_ROOMS = 1000;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000; // delete rooms nobody touched for 6 hours
const HEARTBEAT_MS = 15000;

function createApp() {
  const rooms = new Map();

  const rid = (bytes) => crypto.randomBytes(bytes).toString('hex');
  const connectedIds = (room) => new Set([...room.clients.keys()].filter((id) => room.clients.get(id).size > 0));

  function makeCode() {
    for (let tries = 0; tries < 50; tries++) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    throw new Error('no room codes available');
  }

  function cleanName(raw) {
    const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!s) throw new GameError('Please enter a display name.');
    return s;
  }

  function addPlayer(room, name) {
    const dup = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new GameError('That name is already taken in this room.');
    const p = { id: rid(4), token: rid(16), name };
    room.players.push(p);
    return p;
  }

  function roomView(room, me) {
    const online = connectedIds(room);
    const game = room.game ? room.game.view(me.id) : null;
    if (game) for (const p of game.players) p.connected = online.has(p.id);
    return {
      code: room.code,
      hostId: room.hostId,
      you: me.id,
      handSize: room.handSize,
      maxHandSize: Game.maxHandSize(Math.max(2, room.players.length)),
      members: room.players.map((p) => ({ id: p.id, name: p.name, connected: online.has(p.id) })),
      game,
    };
  }

  function broadcast(room) {
    room.touched = Date.now();
    for (const p of room.players) {
      const set = room.clients.get(p.id);
      if (!set || !set.size) continue;
      const payload = 'event: state\ndata: ' + JSON.stringify(roomView(room, p)) + '\n\n';
      for (const res of set) res.write(payload);
    }
  }

  function dropPlayer(room, id) {
    const set = room.clients.get(id);
    if (set) for (const res of set) { try { res.end(); } catch (e) { /* ignore */ } }
    room.clients.delete(id);
    room.players = room.players.filter((p) => p.id !== id);
    if (room.game) room.game.removePlayer(id);
    if (room.hostId === id) {
      const online = connectedIds(room);
      const next = room.players.find((p) => online.has(p.id)) || room.players[0];
      room.hostId = next ? next.id : null;
    }
    if (!room.players.length) rooms.delete(room.code);
  }

  // ---- actions ----
  function doAction(room, me, body) {
    const isHost = room.hostId === me.id;
    switch (body.type) {
      case 'settings': {
        if (!isHost) throw new GameError('Only the host can change settings.');
        if (room.game) throw new GameError('The game has already started.');
        const n = Number(body.handSize);
        if (!Number.isInteger(n) || n < 5 || n > 10) throw new GameError('Starting hand must be between 5 and 10.');
        room.handSize = n;
        return;
      }
      case 'start': {
        if (!isHost) throw new GameError('Only the host can start the game.');
        if (room.game) throw new GameError('The game has already started.');
        if (room.players.length < 2) throw new GameError('You need at least 2 players.');
        room.game = new Game(room.players.map((p) => ({ id: p.id, name: p.name })), { handSize: room.handSize });
        return;
      }
      case 'play': {
        if (!room.game) throw new GameError('The game has not started.');
        room.game.play(me.id, {
          discard: Array.isArray(body.discard) ? body.discard.map(Number) : null,
          source: body.source,
          card: body.card == null ? undefined : Number(body.card),
        });
        return;
      }
      case 'show':
        if (!room.game) throw new GameError('The game has not started.');
        room.game.show(me.id);
        return;
      case 'next': {
        if (!room.game) throw new GameError('The game has not started.');
        const st = room.game.player(me.id);
        if (!st || st.status === 'left') throw new GameError('You are not in this game.');
        room.game.nextRound();
        return;
      }
      case 'remove': {
        const target = room.players.find((p) => p.id === body.target);
        if (!target) throw new GameError('Player not found.');
        if (!isHost) throw new GameError('Only the host can remove players.');
        if (target.id === me.id) throw new GameError('Use Leave to leave the room.');
        if (room.game && connectedIds(room).has(target.id)) {
          throw new GameError('You can only remove a player who is disconnected.');
        }
        dropPlayer(room, target.id);
        return;
      }
      case 'leave':
        dropPlayer(room, me.id);
        return;
      case 'reset': {
        if (!isHost) throw new GameError('Only the host can start a new game.');
        if (!room.game || room.game.phase !== 'gameEnd') throw new GameError('The game is not finished yet.');
        room.game = null;
        return;
      }
      default:
        throw new GameError('Unknown action.');
    }
  }

  // ---- http plumbing ----
  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 8192) { reject(new GameError('Request too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (e) { reject(new GameError('Invalid request.')); }
      });
      req.on('error', reject);
    });
  }

  const findRoom = (code) => rooms.get(String(code || '').toUpperCase().trim());
  const findMe = (room, token) => room && room.players.find((p) => typeof token === 'string' && p.token === token);

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res, url);
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const body = await readJson(req);

    if (url.pathname === '/api/create') {
      if (rooms.size >= MAX_ROOMS) throw new GameError('The server is full right now. Try again later.');
      const room = { code: makeCode(), hostId: null, players: [], clients: new Map(), game: null, handSize: 5, touched: Date.now() };
      const me = addPlayer(room, cleanName(body.name));
      room.hostId = me.id;
      rooms.set(room.code, room);
      return send(res, 200, { code: room.code, token: me.token, id: me.id });
    }

    if (url.pathname === '/api/join') {
      const room = findRoom(body.code);
      if (!room) return send(res, 404, { error: 'Room not found. Check the code.' });
      const existing = findMe(room, body.token);
      if (existing) return send(res, 200, { code: room.code, token: existing.token, id: existing.id });
      if (body.rejoin) return send(res, 404, { error: 'Your seat in this room is gone.' });
      if (room.game) throw new GameError('That game has already started.');
      if (room.players.length >= MAX_PLAYERS) throw new GameError('This room is full (8 players).');
      const me = addPlayer(room, cleanName(body.name));
      broadcast(room);
      return send(res, 200, { code: room.code, token: me.token, id: me.id });
    }

    if (url.pathname === '/api/action') {
      const room = findRoom(body.code);
      const me = findMe(room, body.token);
      if (!room || !me) return send(res, 404, { error: 'You are not in this room.' });
      doAction(room, me, body);
      broadcast(room);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  function handleEvents(req, res, url) {
    const room = findRoom(url.searchParams.get('code'));
    const me = findMe(room, url.searchParams.get('token'));
    if (!room || !me) return send(res, 404, { error: 'You are not in this room.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    let set = room.clients.get(me.id);
    if (!set) { set = new Set(); room.clients.set(me.id, set); }
    if (set.size >= 5) { const old = set.values().next().value; set.delete(old); try { old.end(); } catch (e) { /* ignore */ } }
    set.add(res);
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      const s = room.clients.get(me.id);
      if (s) { s.delete(res); }
      if (rooms.get(room.code) === room && room.players.some((p) => p.id === me.id)) broadcast(room);
    });
    broadcast(room); // sends current state to everyone (presence changed) incl. this client
  }

  function handleStatic(req, res, url) {
    if (url.pathname === '/cards.js') {
      return fs.readFile(path.join(__dirname, 'lib', 'cards.js'), (err, data) => {
        if (err) return send(res, 500, { error: 'Missing file.' });
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    }
    const entry = STATIC[url.pathname];
    if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size });
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => {
        if (e instanceof GameError) return send(res, 400, { error: e.message });
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: 'Server error.' });
      });
      return;
    }
    handleStatic(req, res, url);
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.touched > ROOM_IDLE_MS && connectedIds(room).size === 0) rooms.delete(code);
    }
  }, 10 * 60 * 1000);
  sweeper.unref();

  return { server, rooms, close: () => { clearInterval(sweeper); server.closeAllConnections && server.closeAllConnections(); server.close(); } };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.server.listen(port, '0.0.0.0', () => console.log('CENTURY running on port:' + port));
}

module.exports = { createApp };
