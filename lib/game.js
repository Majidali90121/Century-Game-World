'use strict'; 
const crypto = require('crypto');
const C = require('./cards');

const SHOW_LIMIT = 6; // hand total must be <= 6 to call SHOW
const ELIMINATION = 100; // cumulative score >= 100 -> eliminated
const SHOW_PENALTY = 20; // per player strictly lower than the declarer
const MIN_DECK_AFTER_DEAL = 5; // keep a few cards in the draw deck
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MIN_HAND = 5;

class GameError extends Error {}

const defaultRng = (n) => crypto.randomInt(n);
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Game {
  /** players: [{id, name}] in seat order. opts: {handSize, rng} */
  constructor(players, opts = {}) {
    this.rng = opts.rng || defaultRng;
    this.handSize = opts.handSize == null ? MIN_HAND : opts.handSize;
    this.gameMode=opts.gameMode || '100'
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new GameError('CENTURY needs 2 to 8 players.');
    }
    if (!Number.isInteger(this.handSize) || this.handSize < MIN_HAND) {
      throw new GameError('Starting hand size must be at least ' + MIN_HAND + '.');
    }
    const max = Game.maxHandSize(players.length);
    if (this.handSize > max) {
      throw new GameError('With ' + players.length + ' players the starting hand can be at most ' + max + ' cards.');
    }
    this.players = players.map((p, i) => ({
      id: p.id, name: p.name, seat: i, status: 'active', total: 0, roundsWon: 0,
      last: null, eliminatedRound: null, elimSeq: null,
    }));
    this.roundNo = 0;
    this.firstSeat = -1;
    this.elimCounter = 0;
    this.phase = 'idle'; // playing | roundEnd | gameEnd
    this.round = null;
    this.result = null;
    this.winnerId = null;
    this.ranking = null;
    this.log = [];
    this._startRound();
  }

  /** Largest starting hand so that deal + centre card still leave a draw deck. */
  static maxHandSize(playerCount) {
    return Math.min(10, Math.floor((52 - 1 - MIN_DECK_AFTER_DEAL) / Math.max(1, playerCount)));
  }

  player(id) { return this.players.find((p) => p.id === id); }
  _activePlayers() { return this.players.filter((p) => p.status === 'active'); }
  _say(text) { this.log.push(text); if (this.log.length > 60) this.log.shift(); }

  _startRound() {
    const active = this._activePlayers();
    const first = active.find((p) => p.seat > this.firstSeat) || active[0];
    this.firstSeat = first.seat;
    const start = active.indexOf(first);
    const order = active.slice(start).concat(active.slice(0, start)).map((p) => p.id);

    const deck = shuffle(Array.from({ length: 52 }, (_, i) => i), this.rng);
    // Centre card: face up, value 6 or higher (chosen before dealing so one always exists).
    const ci = deck.findIndex((c) => C.valueOf(c) >= 6);
    const center = deck.splice(ci, 1)[0];
    const hands = {};
    for (const id of order) hands[id] = deck.splice(0, this.handSize);

    this.roundNo += 1;
    this.round = { no: this.roundNo, order, hands, deck, center, pile: null, turnId: order[0] };
    this.phase = 'playing';
    this.result = null;
    this._say('Round ' + this.roundNo + ' begins. ' + this.player(order[0]).name + ' goes first.');
  }

  _nextTurnId(fromId) {
    const order = this.round.order;
    let i = order.indexOf(fromId);
    for (let k = 0; k < order.length; k++) {
      i = (i + 1) % order.length;
      const p = this.player(order[i]);
      if (p.status === 'active' && this.round.hands[order[i]]) return order[i];
    }
    return null;
  }

  _requireTurn(pid) {
    if (this.phase !== 'playing') throw new GameError('The round is not in progress.');
    if (this.round.turnId !== pid) throw new GameError('It is not your turn.');
  }

  /** One full turn: discard exactly one combination, then pick exactly one card.
      move = { discard: [cardIds], source: 'deck' | 'pile' | 'center', card?: id } */
  play(pid, move) {
    this._requireTurn(pid);
    const r = this.round;
    const hand = r.hands[pid];
    const name = this.player(pid).name;
    const discard = move && move.discard;
    const combo = C.validateCombo(discard);
    if (!combo.ok) throw new GameError(combo.error);
    for (const c of discard) if (!hand.includes(c)) throw new GameError('You do not hold ' + C.cardLabel(c) + '.');

    const source = move.source;
    if (r.center !== null) {
      if (source !== 'center' && source !== 'deck') throw new GameError('Take the centre card or draw from the deck.');
    } else {
      if (source !== 'pile' && source !== 'deck') throw new GameError("Take one card from the previous player's discard, or draw from the deck.");
      if (!r.pile) throw new GameError('There is no discard to take from.');
    }
    if (source === 'pile' && !r.pile.cards.includes(move.card)) {
      throw new GameError('That card is not in the previous discard.');
    }
    if (source === 'deck' && r.center === null && r.deck.length === 0) {
      throw new GameError('The draw deck is empty. Take a card from the previous discard.');
    }

    // ---- validated: apply ----
    for (const c of discard) hand.splice(hand.indexOf(c), 1);
    let what;
    if (source === 'center') {
      hand.push(r.center);
      what = 'took the centre card ' + C.cardLabel(r.center);
      r.center = null;
    } else if (source === 'pile') {
      hand.push(move.card);
      // Unpicked cards go to the bottom of the draw deck and are gone for later players.
      r.deck.push(...r.pile.cards.filter((c) => c !== move.card));
      what = 'took ' + C.cardLabel(move.card) + ' from ' + this.player(r.pile.by).name + "'s discard";
    } else {
      if (r.center !== null) {
        r.deck.push(r.center); // centre card goes back and the deck is reshuffled
        shuffle(r.deck, this.rng);
        r.center = null;
        what = 'drew from the deck (centre card returned, deck reshuffled)';
      } else {
        what = 'drew from the deck';
      }
      hand.push(r.deck.shift());
      if (r.pile) r.deck.push(...r.pile.cards); // previous discard no longer available
    }
    r.pile = { cards: discard.slice(), by: pid, label: combo.label };
    r.turnId = this._nextTurnId(pid);
    this._say(name + ' discarded ' + combo.label + ' and ' + what + '.');
  }

  /** SHOW is only possible at the start of your own turn with a hand of 6 or less.
      Because your hand only changes during your own turn, a hand that is <= 6 at the
      start of your turn was necessarily reached on an earlier turn. */
  canShow(pid) {
    return this.phase === 'playing' && this.round.turnId === pid && C.handTotal(this.round.hands[pid]) <= SHOW_LIMIT;
  }

  show(pid) {
    this._requireTurn(pid);
    if (!this.canShow(pid)) throw new GameError('You need a hand total of ' + SHOW_LIMIT + ' or less to call SHOW.');
    const r = this.round;
    const rows = r.order
      .filter((id) => this.player(id).status === 'active' && r.hands[id])
      .map((id) => ({ id, name: this.player(id).name, hand: r.hands[id].slice(), handPoints: C.handTotal(r.hands[id]) }));
    const decl = rows.find((x) => x.id === pid);
    const lower = rows.filter((x) => x.handPoints < decl.handPoints).length;
    const lowest = Math.min(...rows.map((x) => x.handPoints));
    // TIE RULE (pending owner confirmation): every player on the lowest total shares the round win.
    // This affects only the "rounds won" tally; scoring is unchanged either way.
    for (const x of rows) {
      x.declarer = x.id === pid;
      x.penalty = x.declarer ? lower * SHOW_PENALTY : 0;
      x.roundPoints = x.handPoints + x.penalty;
      x.winner = x.handPoints === lowest;
      const p = this.player(x.id);
      
      if (x.winner){
        x.roundPoints = 0
         p.roundsWon += 1;
      }else{
        p.total += x.roundPoints
      }
      p.last = { hand: x.handPoints, penalty: x.penalty, round: x.roundPoints };
      x.total = p.total;
      x.eliminated = false;
      if (p.total >= ELIMINATION && this.gameMode === '100') {
        p.status = 'eliminated';
        p.eliminatedRound = r.no;
        p.elimSeq = ++this.elimCounter;
        x.eliminated = true;
      }
    }
    const winners = rows.filter((x) => x.winner).map((x) => x.id);
    this._say(decl.name + ' called SHOW with ' + decl.handPoints + '.' +
      (lower ? ' ' + lower + ' player(s) had less: +' + lower * SHOW_PENALTY + ' penalty.' : ''));

    this.result = { round: r.no, declarerId: pid, rows, winners, lowest, gameOver: false, winnerId: null };
    this.phase = 'roundEnd';
    const active = this._activePlayers();
    if (active.length <= 1) {
      this.result.gameOver = true;
      // If everyone left is eliminated in the same round, the lowest cumulative score wins.
      const winner = active[0] || rows.filter((x) => x.eliminated).sort((a, b) => a.total - b.total)[0];
      this.result.winnerId = winner.id;
    }
  }

  /** Continue from the round-end screen: next round, or the final screen. */
  nextRound() {
    if (this.phase !== 'roundEnd') throw new GameError('There is no round to continue from.');
    if (this.result.gameOver) this._finish(this.result.winnerId);
    else this._startRound();
  }

  _finish(winnerId) {
    this.phase = 'gameEnd';
    this.winnerId = winnerId;
    const rest = this.players.filter((p) => p.id !== winnerId);
    const rankKey = (p) => (p.status === 'left' ? [2, 0, p.total] : [1, -(p.eliminatedRound || 0), p.total]);
    rest.sort((a, b) => {
      const ka = rankKey(a), kb = rankKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
    this.ranking = [this.player(winnerId)].concat(rest).map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, total: p.total, roundsWon: p.roundsWon, status: p.status,
    }));
    this._say(this.player(winnerId).name + ' is the CENTURY winner!');
  }

  /** A player leaves or is removed (after disconnecting). Their cards go to the bottom of the deck. */
  removePlayer(id) {
    const p = this.player(id);
    if (!p || p.status === 'left') return;
    const wasTurn = this.phase === 'playing' && this.round.turnId === id;
    const wasActive = p.status === 'active';
    p.status = 'left';
    this._say(p.name + ' left the game.');
    if (this.phase === 'playing' && this.round.hands[id]) {
      this.round.deck.push(...this.round.hands[id]);
      delete this.round.hands[id];
    }
    if (this.phase === 'gameEnd') return;
    const active = this._activePlayers();
    if (wasActive && active.length <= 1) {
      if (active.length === 1) this._finish(active[0].id);
      else this._finish(id);
      return;
    }
    if (wasTurn) this.round.turnId = this._nextTurnId(id);
  }

  /** What one player may see: their own hand, never anyone else's (until SHOW). */
  view(pid) {
    const r = this.round;
    const inRound = this.phase === 'playing' && r.hands[pid];
    const hand = inRound ? r.hands[pid].slice().sort((a, b) => C.suitOf(a) - C.suitOf(b) || C.rankOf(a) - C.rankOf(b)) : [];
    const playing = this.phase === 'playing';
    return {
      phase: this.phase,
      round: this.roundNo,
      handSize: this.handSize,
      turnId: playing ? r.turnId : null,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, status: p.status, total: p.total, roundsWon: p.roundsWon, last: p.last,
        cards: playing && r.hands[p.id] ? r.hands[p.id].length : 0,
      })),
      you: { id: pid, hand, handTotal: C.handTotal(hand), canShow: this.canShow(pid), inRound: !!inRound },
      deckCount: playing ? r.deck.length : 0,
      center: playing ? r.center : null,
      pile: playing && r.pile ? { cards: r.pile.cards.slice(), by: r.pile.by, label: r.pile.label } : null,
      log: this.log.slice(-8),
      result: this.phase === 'roundEnd' || this.phase === 'gameEnd' ? this.result : null,
      winnerId: this.winnerId,
      ranking: this.ranking,
    };
  }

  /** Test helper: every card in play, to prove none is lost or duplicated. */
  _allCards() {
    const r = this.round;
    const all = [].concat(r.deck, r.center === null ? [] : [r.center], r.pile ? r.pile.cards : []);
    for (const id of Object.keys(r.hands)) all.push(...r.hands[id]);
    return all;
  }
}

module.exports = { Game, GameError, SHOW_LIMIT, ELIMINATION, SHOW_PENALTY };
