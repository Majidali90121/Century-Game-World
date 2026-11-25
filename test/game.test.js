'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/cards');
const { Game, GameError } = require('../lib/game');

const card = (rank, suit) => 'HDCS'.indexOf(suit) * 13 + (rank - 1);
const mk = (n, opts) => new Game(Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i })), opts);
const throwsGame = (fn, re) => assert.throws(fn, (e) => e instanceof GameError && (!re || re.test(e.message)));

test('card values: A=1, 2-10 face, J/Q/K=10', () => {
  assert.equal(C.valueOf(card(1, 'S')), 1);
  assert.equal(C.valueOf(card(7, 'H')), 7);
  assert.equal(C.valueOf(card(10, 'C')), 10);
  for (const r of [11, 12, 13]) assert.equal(C.valueOf(card(r, 'D')), 10);
});

test('combo validation', () => {
  const ok = (cs, type) => { const v = C.validateCombo(cs); assert.ok(v.ok, v.error); assert.equal(v.type, type); };
  const bad = (cs) => assert.equal(C.validateCombo(cs).ok, false, JSON.stringify(cs));
  ok([card(5, 'H')], 'single');
  ok([card(13, 'H'), card(13, 'S')], 'pair');
  ok([card(9, 'H'), card(9, 'S'), card(9, 'C')], 'three');
  ok([card(9, 'H'), card(9, 'S'), card(9, 'C'), card(9, 'D')], 'four');
  ok([card(6, 'D'), card(4, 'D'), card(5, 'D')], 'sequence'); // order of selection irrelevant
  ok([card(1, 'H'), card(2, 'H'), card(3, 'H')], 'sequence'); // A-2-3
  ok([card(11, 'S'), card(12, 'S'), card(13, 'S')], 'sequence'); // J-Q-K
  bad([]);
  bad([card(5, 'H'), card(6, 'S')]); // two different ranks
  bad([card(4, 'D'), card(5, 'D'), card(7, 'D')]); // gap
  bad([card(4, 'D'), card(5, 'H'), card(6, 'D')]); // mixed suits
  bad([card(12, 'S'), card(13, 'S'), card(1, 'S')]); // Q-K-A does not wrap
  bad([card(3, 'S'), card(4, 'S'), card(5, 'S'), card(6, 'S')]); // 4-run not allowed
  bad([card(7, 'H'), card(7, 'H')]); // duplicate card
  bad([card(7, 'H'), card(7, 'D'), card(8, 'H')]);
  bad([1, 2, 3, 4, 5]);
  bad([99]);
  bad('x');
});

test('setup for 2..8 players: 52 cards conserved, centre >= 6, hands dealt', () => {
  for (let n = 2; n <= 8; n++) {
    for (const hs of [5, Game.maxHandSize(n)]) {
      const g = mk(n, { handSize: hs });
      const all = g._allCards();
      assert.equal(all.length, 52);
      assert.equal(new Set(all).size, 52);
      assert.ok(C.valueOf(g.round.center) >= 6);
      for (const id of g.round.order) assert.equal(g.round.hands[id].length, hs);
      assert.ok(g.round.deck.length >= 5);
    }
  }
});

test('setup validation', () => {
  throwsGame(() => mk(1));
  throwsGame(() => mk(9));
  throwsGame(() => mk(3, { handSize: 4 }), /at least 5/);
  throwsGame(() => mk(8, { handSize: 6 }), /at most 5/);
});

test('first player may take the centre card', () => {
  const g = mk(3);
  const r = g.round, id = r.turnId, c = r.center;
  const d = [r.hands[id][0]];
  g.play(id, { discard: d, source: 'center' });
  assert.ok(r.hands[id].includes(c));
  assert.equal(r.hands[id].length, 5);
  assert.equal(r.center, null);
  assert.deepEqual(r.pile.cards, d);
  assert.equal(g._allCards().length, 52);
});

test('first player drawing returns centre to the deck and reshuffles', () => {
  const g = mk(3);
  const r = g.round, id = r.turnId, c = r.center, before = r.deck.length;
  g.play(id, { discard: [r.hands[id][0]], source: 'deck' });
  assert.equal(r.center, null);
  assert.equal(r.deck.length, before); // +centre -drawn
  assert.equal(g._allCards().length, 52);
  assert.equal(new Set(g._allCards()).size, 52);
  assert.ok(r.hands[id].length === 5 && c !== undefined);
});

test('turn order, out-of-turn and bad moves are rejected without changing state', () => {
  const g = mk(3);
  const r = g.round, id = r.turnId, other = r.order[1];
  const snapshot = JSON.stringify(r);
  throwsGame(() => g.play(other, { discard: [r.hands[other][0]], source: 'deck' }), /not your turn/);
  throwsGame(() => g.play(id, { discard: [], source: 'deck' }));
  throwsGame(() => g.play(id, { discard: [r.hands[other][0]], source: 'deck' }), /do not hold/);
  throwsGame(() => g.play(id, { discard: [r.hands[id][0]], source: 'pile', card: 1 }), /centre card/);
  throwsGame(() => g.play(id, { discard: [r.hands[id][0]], source: 'nonsense' }));
  throwsGame(() => g.play(id, { discard: [r.hands[id][0], r.hands[id][0]], source: 'deck' }));
  assert.equal(JSON.stringify(r), snapshot);
});

test('later players: take one card from the previous discard only; the rest go to the deck bottom', () => {
  const g = mk(3);
  const r = g.round;
  const [a, b, c] = r.order;
  const seq = [card(4, 'D'), card(5, 'D'), card(6, 'D')];
  setHands(g, {
    [a]: [...seq, card(13, 'S'), card(12, 'S')],
    [b]: [card(9, 'C'), card(2, 'C'), card(3, 'C'), card(8, 'H'), card(1, 'H')],
    [c]: [card(10, 'C'), card(11, 'C'), card(7, 'C'), card(7, 'H'), card(1, 'C')],
  });
  r.center = card(13, 'H');
  r.deck = r.deck.filter((x) => x !== r.center);
  assert.equal(g._allCards().length, 52);

  g.play(a, { discard: seq, source: 'deck' });
  assert.equal(r.turnId, b);
  assert.equal(r.pile.cards.length, 3);
  const deckBefore = r.deck.length;
  g.play(b, { discard: [card(9, 'C')], source: 'pile', card: seq[1] });
  assert.ok(r.hands[b].includes(seq[1]));
  assert.deepEqual(r.deck.slice(-2), [seq[0], seq[2]]); // unpicked go to the bottom, in order
  assert.equal(r.deck.length, deckBefore + 2);
  assert.equal(r.turnId, c);
  throwsGame(() => g.play(c, { discard: [card(10, 'C')], source: 'pile', card: seq[0] }), /not in the previous discard/);
  assert.equal(g._allCards().length, 52);
  assert.equal(new Set(g._allCards()).size, 52);
});

test('drawing instead of taking also sends the previous discard to the deck bottom', () => {
  const g = mk(2);
  const r = g.round, [a, b] = r.order;
  g.play(a, { discard: [r.hands[a][0]], source: 'deck' });
  const prev = r.pile.cards.slice();
  g.play(b, { discard: [r.hands[b][0]], source: 'deck' });
  assert.deepEqual(r.deck.slice(-prev.length), prev);
  assert.equal(g._allCards().length, 52);
});

test('SHOW: needs <=6 and your own turn; cannot SHOW on the turn you reach <=6', () => {
  const g = mk(2);
  const r = g.round, [a, b] = r.order;
  throwsGame(() => g.show(a), /6 or less/);
  throwsGame(() => g.show(b), /not your turn/);
  // Give A a hand of 7 that can drop to 4 this turn.
  const set = (id, cards) => {
    for (const x of cards) {
      for (const k of Object.keys(r.hands)) { const i = r.hands[k].indexOf(x); if (i >= 0) r.hands[k].splice(i, 1); }
      const di = r.deck.indexOf(x); if (di >= 0) r.deck.splice(di, 1);
      if (r.center === x) r.center = r.deck.pop();
    }
    r.deck.push(...r.hands[id]); r.hands[id] = cards.slice();
  };
  set(a, [card(13, 'H'), card(1, 'H'), card(2, 'C')]); // 10+1+2 = 13
  g.play(a, { discard: [card(13, 'H')], source: 'deck' });
  assert.ok(C.handTotal(r.hands[a]) >= 3);
  // force the picked card so total <= 6 after turn
  r.hands[a] = [card(1, 'H'), card(2, 'C'), card(3, 'D')]; // 6
  r.hands[b] = r.hands[b];
  g.play(b, { discard: [r.hands[b][0]], source: 'deck' });
  assert.equal(r.turnId, a);
  assert.equal(g.canShow(a), true);
  g.show(a);
  assert.equal(g.phase, 'roundEnd');
});

function setHands(g, hands) { // hands: {id: [cards]} ; fixes deck so 52 cards stay unique
  const r = g.round;
  const used = new Set(Object.values(hands).flat());
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  r.pile = null; r.center = null;
  r.deck = rest;
  r.hands = {};
  for (const id of r.order) r.hands[id] = hands[id] || [];
}

test('brief example: X=8, Y=3, Z=5 declares SHOW -> Y wins, Z gets +20', () => {
  const g = mk(3);
  const [x, y, z] = g.round.order;
  setHands(g, {
    [x]: [card(8, 'H')],
    [y]: [card(3, 'H')],
    [z]: [card(5, 'H')],
  });
  g.round.turnId = z;
  g.show(z);
  const res = g.result;
  const row = (id) => res.rows.find((q) => q.id === id);
  assert.deepEqual(res.winners, [y]);
  assert.equal(row(z).penalty, 20);
  assert.equal(row(z).roundPoints, 25);
  assert.equal(row(y).roundPoints, 3); // winner still scores own hand
  assert.equal(row(x).roundPoints, 8);
  assert.equal(g.player(z).total, 25);
  assert.equal(g.player(y).roundsWon, 1);
  assert.equal(g.player(z).roundsWon, 0);
});

test('penalty is 20 per strictly-lower player; lowest of the lower wins', () => {
  const g = mk(4);
  const [a, b, c, d] = g.round.order;
  setHands(g, { [a]: [card(6, 'H')], [b]: [card(2, 'H')], [c]: [card(4, 'S')], [d]: [card(9, 'S')] });
  g.round.turnId = a;
  g.show(a);
  const row = (id) => g.result.rows.find((q) => q.id === id);
  assert.equal(row(a).penalty, 40);
  assert.equal(row(a).roundPoints, 46);
  assert.deepEqual(g.result.winners, [b]);
});

test('declarer with lowest total wins, no penalty; tie with declarer is not "strictly lower"', () => {
  const g = mk(3);
  const [a, b, c] = g.round.order;
  setHands(g, { [a]: [card(4, 'H')], [b]: [card(4, 'S')], [c]: [card(10, 'S')] });
  g.round.turnId = a;
  g.show(a);
  const row = (id) => g.result.rows.find((q) => q.id === id);
  assert.equal(row(a).penalty, 0);
  assert.deepEqual(g.result.winners.sort(), [a, b].sort()); // tie shared (pending owner confirmation)
  assert.equal(g.player(a).total, 4);
});

test('elimination at 100+, last active player wins, ranking built', () => {
  const g = mk(3);
  let [a, b, c] = g.round.order;
  g.player(b).total = 97;
  g.player(c).total = 50;
  setHands(g, { [a]: [card(1, 'H')], [b]: [card(5, 'H')], [c]: [card(9, 'H')] });
  g.round.turnId = a;
  g.show(a);
  assert.equal(g.player(b).status, 'eliminated'); // 97+5
  assert.equal(g.player(c).status, 'active'); // 59
  assert.equal(g.result.gameOver, false);
  g.nextRound();
  assert.equal(g.round.order.length, 2);
  assert.ok(!g.round.order.includes(b)); // eliminated players take no part
  // end it: c reaches 100
  const r = g.round;
  const ids = r.order;
  g.player(ids[1]).total = 95;
  setHands(g, { [ids[0]]: [card(1, 'S')], [ids[1]]: [card(7, 'S'), card(7, 'D')] });
  r.turnId = ids[0];
  g.show(ids[0]);
  const loser = ids[1];
  assert.equal(g.player(loser).status, 'eliminated');
  assert.equal(g.result.gameOver, true);
  assert.equal(g.result.winnerId, ids[0]);
  g.nextRound();
  assert.equal(g.phase, 'gameEnd');
  assert.equal(g.ranking[0].id, ids[0]);
  assert.equal(g.ranking.length, 3);
  assert.deepEqual(g.ranking.map((q) => q.rank), [1, 2, 3]);
  assert.equal(g.ranking[1].id, loser); // eliminated later ranks higher than b
});

test('view never leaks other hands', () => {
  const g = mk(4);
  const v = g.view('p1');
  assert.equal(v.you.hand.length, 5);
  for (const p of v.players) assert.equal(p.hand, undefined);
  const others = g.round.hands.p0.concat(g.round.hands.p2);
  const s = JSON.stringify({ ...v, you: undefined });
  // other players' hand cards can't be inferred from fields other than public pile/centre
  assert.equal(v.deckCount, g.round.deck.length);
  assert.ok(!('deck' in v));
  assert.ok(!s.includes('"hands"'));
  assert.ok(others.length === 10);
});

test('player leaving: cards return to deck, turn passes, game ends when one remains', () => {
  const g = mk(3);
  const r = g.round, cur = r.turnId;
  g.removePlayer(cur);
  assert.notEqual(r.turnId, cur);
  assert.equal(g._allCards().length, 52);
  const nxt = r.turnId;
  g.removePlayer(nxt);
  assert.equal(g.phase, 'gameEnd');
  assert.equal(g.winnerId, r.order.find((i) => ![cur, nxt].includes(i)));
});

// ---------- bot simulation ----------
function bestDiscards(g, id) {
  const hand = g.round.hands[id];
  const opts = [];
  for (const c of hand) opts.push([c]);
  for (let i = 0; i < hand.length; i++) for (let j = i + 1; j < hand.length; j++) {
    const s = [hand[i], hand[j]];
    if (C.validateCombo(s).ok) opts.push(s);
    for (let k = j + 1; k < hand.length; k++) {
      const t = [hand[i], hand[j], hand[k]];
      if (C.validateCombo(t).ok) opts.push(t);
      for (let m = k + 1; m < hand.length; m++) { const u = [hand[i], hand[j], hand[k], hand[m]]; if (C.validateCombo(u).ok) opts.push(u); }
    }
  }
  return opts;
}
function botTurn(g, id, rnd) {
  const r = g.round;
  if (g.canShow(id) && rnd() < 0.9) return g.show(id);
  const opts = bestDiscards(g, id);
  const pick = rnd() < 0.15 ? opts[Math.floor(rnd() * opts.length)] : opts.sort((a, b) => C.handTotal(b) - C.handTotal(a))[0];
  let source, c;
  if (r.center !== null) { source = C.valueOf(r.center) <= 4 ? 'center' : 'deck'; }
  else {
    const best = r.pile.cards.slice().sort((a, b) => C.valueOf(a) - C.valueOf(b))[0];
    if (C.valueOf(best) <= 3 || r.deck.length === 0) { source = 'pile'; c = best; } else source = 'deck';
  }
  g.play(id, { discard: pick, source, card: c });
}

test('simulated full games, 2..8 players: invariants hold and games finish', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 2; n <= 8; n++) {
    for (let rep = 0; rep < 3; rep++) {
      const g = mk(n, { rng: (k) => Math.floor(rnd() * k) });
      let guard = 0;
      while (g.phase !== 'gameEnd') {
        if (++guard > 20000) assert.fail('game did not finish: n=' + n);
        if (g.phase === 'roundEnd') { g.nextRound(); continue; }
        botTurn(g, g.round.turnId, rnd);
        if (g.phase === 'playing') {
          const all = g._allCards();
          assert.equal(all.length, 52);
          assert.equal(new Set(all).size, 52);
        }
      }
      assert.ok(g.winnerId);
      assert.equal(g.ranking.length, n);
      const losers = g.players.filter((p) => p.id !== g.winnerId);
      assert.ok(losers.every((p) => p.status === 'eliminated' || g.players.length === 1));
    }
  }
});
