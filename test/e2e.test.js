'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const C = require('../lib/cards');
const { createApp } = require('../server');

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
}
function subscribe(port, code, token) {
  const c = { state: null, got: 0, req: null, waiters: [] };
  return new Promise((resolve, reject) => {
    c.req = http.get({ port, path: `/api/events?code=${code}&token=${token}` }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('SSE status ' + res.statusCode));
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = chunk.match(/^data: (.*)$/m);
          if (m && /^event: state/m.test(chunk)) { c.state = JSON.parse(m[1]); c.got++; c.waiters.splice(0).forEach((w) => w()); }
        }
      });
      resolve(c);
    });
    c.req.on('error', reject);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 15));
async function waitAll(players, before) {
  const t0 = Date.now();
  while (players.some((p, i) => p.sse.got <= before[i])) {
    if (Date.now() - t0 > 3000) throw new Error('timed out waiting for state push');
    await new Promise((r) => setImmediate(r));
  }
}
const marks = (players) => players.map((p) => p.sse.got);

async function room(port, n, handSize) {
  const host = (await post(port, '/api/create', { name: 'P0' })).json;
  const code = host.code;
  const players = [{ name: 'P0', ...host }];
  for (let i = 1; i < n; i++) { const j = await post(port, '/api/join', { code, name: 'P' + i }); assert.equal(j.status, 200); players.push({ name: 'P' + i, ...j.json }); }
  for (const p of players) p.sse = await subscribe(port, code, p.token);
  await settle();
  if (handSize) assert.equal((await post(port, '/api/action', { code, token: host.token, type: 'settings', handSize })).status, 200);
  assert.equal((await post(port, '/api/action', { code, token: host.token, type: 'start' })).status, 200);
  await settle();
  return { code, players };
}

function allCombos(hand) {
  const out = hand.map((c) => [c]);
  for (let i = 0; i < hand.length; i++) for (let j = i + 1; j < hand.length; j++) {
    if (C.validateCombo([hand[i], hand[j]]).ok) out.push([hand[i], hand[j]]);
    for (let k = j + 1; k < hand.length; k++) {
      if (C.validateCombo([hand[i], hand[j], hand[k]]).ok) out.push([hand[i], hand[j], hand[k]]);
      for (let m = k + 1; m < hand.length; m++) if (C.validateCombo([hand[i], hand[j], hand[k], hand[m]]).ok) out.push([hand[i], hand[j], hand[k], hand[m]]);
    }
  }
  return out;
}
function pickMove(g) {
  const combos = allCombos(g.you.hand);
  // mostly greedy, sometimes random, so hands shrink and rounds end like in real play
  const discard = Math.random() < 0.25 ? combos[Math.floor(Math.random() * combos.length)] : combos.sort((a, b) => C.handTotal(b) - C.handTotal(a))[0];
  if (g.center !== null) return { discard, source: C.valueOf(g.center) <= 4 ? 'center' : 'deck' };
  const best = g.pile.cards.slice().sort((a, b) => C.valueOf(a) - C.valueOf(b))[0];
  return C.valueOf(best) <= 3 || g.deckCount === 0 ? { discard, source: 'pile', card: best } : { discard, source: 'deck' };
}

async function playGame(port, n, handSize) {
  const { code, players } = await room(port, n, handSize);
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  let moves = 0;
  for (let guard = 0; guard < 20000; guard++) {
    const g0 = players[0].sse.state.game;
    // privacy: nobody receives another player's hand
    for (const p of players) {
      const g = p.sse.state.game;
      assert.equal(g.you.id, p.id);
      for (const q of g.players) assert.equal(q.hand, undefined);
      if (g.phase === 'playing') {
        assert.equal(g.you.hand.length, g.players.find((x) => x.id === p.id).cards);
        assert.ok(!('hands' in g) && !('deck' in g));
      }
    }
    if (g0.phase === 'gameEnd') break;
    if (g0.phase === 'roundEnd') {
      const before = marks(players);
      const r = await post(port, '/api/action', { code, token: players[0].token, type: 'next' });
      assert.equal(r.status, 200);
      await waitAll(players, before);
      continue;
    }
    const cur = byId[g0.turnId];
    const g = cur.sse.state.game;
    // an out-of-turn player is rejected
    if (moves % 25 === 0) {
      const other = players.find((p) => p.id !== g0.turnId);
      const bad = await post(port, '/api/action', { code, token: other.token, type: 'play', discard: [other.sse.state.game.you.hand[0]], source: 'deck' });
      assert.equal(bad.status, 400);
    }
    let r;
    const before = marks(players);
    if (g.you.canShow && moves % 3 !== 0) r = await post(port, '/api/action', { code, token: cur.token, type: 'show' });
    else r = await post(port, '/api/action', { code, token: cur.token, type: 'play', ...pickMove(g) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    moves++;
    await waitAll(players, before);
  }
  const fin = players[0].sse.state.game;
  assert.equal(fin.phase, 'gameEnd');
  assert.equal(fin.ranking.length, n);
  for (const p of players) p.sse.req.destroy();
  return moves;
}

test('full networked games: 2, 4 and 8 players', { timeout: 120000 }, async () => {
  const app = createApp();
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  try {
    for (const [n, hs] of [[2, 5], [4, 6], [8, 5]]) {
      const moves = await playGame(port, n, hs);
      assert.ok(moves > 5);
    }
  } finally { app.close(); }
});

test('room rules: join validation, capacity, reconnect, host powers, removal', { timeout: 20000 }, async () => {
  const app = createApp();
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  try {
    assert.equal((await post(port, '/api/create', { name: '   ' })).status, 400);
    const h = (await post(port, '/api/create', { name: 'Host' })).json;
    assert.match(h.code, /^[A-Z2-9]{5}$/);
    assert.equal((await post(port, '/api/join', { code: 'ZZZZZ', name: 'x' })).status, 404);
    assert.equal((await post(port, '/api/join', { code: h.code, name: 'host' })).status, 400); // duplicate (case-insens.)
    const joined = [];
    for (let i = 1; i < 8; i++) joined.push((await post(port, '/api/join', { code: h.code.toLowerCase(), name: 'G' + i })).json);
    assert.equal((await post(port, '/api/join', { code: h.code, name: 'Ninth' })).status, 400); // full
    // reconnect with token returns same seat
    const again = await post(port, '/api/join', { code: h.code, name: 'whatever', token: joined[0].token });
    assert.equal(again.json.id, joined[0].id);
    assert.equal((await post(port, '/api/join', { code: h.code, name: 'x', token: 'bad', rejoin: true })).status, 404);
    // non-host can't start; bad hand size for 8 players rejected
    assert.equal((await post(port, '/api/action', { code: h.code, token: joined[0].token, type: 'start' })).status, 400);
    assert.equal((await post(port, '/api/action', { code: h.code, token: h.token, type: 'settings', handSize: 6 })).status, 200);
    const bad = await post(port, '/api/action', { code: h.code, token: h.token, type: 'start' });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /at most 5/);
    await post(port, '/api/action', { code: h.code, token: h.token, type: 'settings', handSize: 5 });
    // kick in lobby then start
    for (let i = 0; i < 6; i++) assert.equal((await post(port, '/api/action', { code: h.code, token: h.token, type: 'remove', target: joined[i].id })).status, 200);
    assert.equal((await post(port, '/api/action', { code: h.code, token: h.token, type: 'start' })).status, 200);
    assert.equal((await post(port, '/api/join', { code: h.code, name: 'Late' })).status, 400); // started
    // game tokens: unknown token rejected
    assert.equal((await post(port, '/api/action', { code: h.code, token: 'nope', type: 'show' })).status, 404);
    // offline players can be removed by host mid-game and the game ends (1 left)
    const rm = await post(port, '/api/action', { code: h.code, token: h.token, type: 'remove', target: joined[6].id });
    assert.equal(rm.status, 200);
    const sub = await subscribe(port, h.code, h.token);
    await settle();
    assert.equal(sub.state.game.phase, 'gameEnd');
    assert.equal(sub.state.game.ranking[0].name, 'Host');
    sub.req.destroy();
  } finally { app.close(); }
});

test('static files and health', async () => {
  const app = createApp();
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  try {
    const get = (p) => new Promise((res) => http.get({ port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ s: r.statusCode, b })); }));
    assert.equal((await get('/')).s, 200);
    assert.match((await get('/cards.js')).b, /validateCombo/);
    assert.equal((await get('/app.js')).s, 200);
    assert.equal((await get('/style.css')).s, 200);
    assert.equal((await get('/healthz')).s, 200);
    assert.equal((await get('/../server.js')).s, 404);
    assert.equal((await get('/lib/game.js')).s, 404);
  } finally { app.close(); }
});
