'use strict';
const crypto = require('crypto');
const C = require('./cards');

const SHOW_LIMIT = 6; 
const ELIMINATION = 100; 
const SHOW_PENALTY = 20; 
const MIN_DECK_AFTER_DEAL = 5;
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
  constructor(players, opts = {}) {
    this.rng = opts.rng || defaultRng;
    this.gameMode = opts.gameMode || '100'; // '100' ya 'rounds'
    this.handSize = opts.handSize == null ? MIN_HAND : opts.handSize;
    
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
    this.phase = 'idle';
    this.round = null;
    this.result = null;
    this.winnerId = null;
    this.ranking = null;
    this.log = [];
    this._startRound();
  }

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

    for (const c of discard) hand.splice(hand.indexOf(c), 1);
    let what;
    if (source === 'center') {
      hand.push(r.center);
      what = 'took the centre card ' + C.cardLabel(r.center);
      r.center = null;
    } else if (source === 'pile') {
      hand.push(move.card);
      r.deck.push(...r.pile.cards.filter((c) => c !== move.card));
      what = 'took ' + C.cardLabel(move.card) + ' from ' + this.player(r.pile.by).name + "'s discard";
    } else {
      if (r.center !== null) {
        r.deck.push(r.center);
        shuffle(r.deck, this.rng);
        r.center = null;
        what = 'drew from the deck (centre card returned, deck reshuffled)';
      } else {
        what = 'drew from the deck';
      }
      hand.push(r.deck.shift());
      if (r.pile) r.deck.push(...r.pile.cards);
    }
    r.pile = { cards: discard.slice(), by: pid, label: combo.label };
    r.turnId = this._nextTurnId(pid);
    this._say(name + ' discarded ' + combo.label + ' and ' + what + '.');
  }

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
    const others = rows.filter((x) => x.id !== pid);
    const lowestOther = others.length ? Math.min(...others.map((x) => x.handPoints)) : Infinity;
    const lowest = Math.min(decl.handPoints, lowestOther);

    /* SHOW rules:
       - The caller only WINS if their hand is STRICTLY lower than everybody else's.
         Matching another player's total is NOT a win: a tie counts against the caller.
       - If the caller does not win, they pay SHOW_PENALTY (20) for EACH opponent whose
         hand is lower than or equal to theirs, on top of their own hand points.
       - Then the lowest opponent(s) win the round (0 points; a tie between opponents
         is shared). Everyone else adds their own hand points. */
    const callerWins = decl.handPoints < lowestOther;
    const callerTied = !callerWins && decl.handPoints === lowestOther; // matched the lowest opponent
    const beatenBy = others.filter((x) => x.handPoints <= decl.handPoints).length;
    const winnerIds = callerWins ? [pid] : others.filter((x) => x.handPoints === lowestOther).map((x) => x.id);

    for (const x of rows) {
      x.declarer = x.id === pid;
      x.winner = winnerIds.includes(x.id);
      x.penalty = x.declarer && !callerWins ? beatenBy * SHOW_PENALTY : 0;
      x.roundPoints = x.winner ? 0 : x.handPoints + x.penalty;

      const p = this.player(x.id);
      p.total += x.roundPoints;
      if (x.winner) p.roundsWon += 1;

      p.last = { hand: x.handPoints, penalty: x.penalty, round: x.roundPoints };
      x.total = p.total;
      x.eliminated = false;

      // Elimination only applies in '100' mode
      if (this.gameMode === '100' && p.total >= ELIMINATION) {
        p.status = 'eliminated';
        p.eliminatedRound = r.no;
        p.elimSeq = ++this.elimCounter;
        x.eliminated = true;
      }
    }

    const winners = winnerIds;
    this._say(decl.name + ' called SHOW with ' + decl.handPoints + '.' +
      (callerWins ? ' Lowest hand — wins the round.'
        : callerTied ? ' Another player has ' + decl.handPoints + ' too — a tie counts against the caller: +' + (beatenBy * SHOW_PENALTY) + ' penalty.'
        : ' Someone has a lower hand: +' + (beatenBy * SHOW_PENALTY) + ' penalty.'));

    this.result = { round: r.no, declarerId: pid, rows, winners, lowest, callerTied, gameOver: false, winnerId: null };
    this.phase = 'roundEnd';
    
    const active = this._activePlayers();
    if (active.length <= 1) {
      this.result.gameOver = true;
      const winner = active[0] || rows.filter((x) => x.eliminated).sort((a, b) => a.total - b.total)[0];
      this.result.winnerId = winner.id;
    }
  }

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

  view(pid) {
    const r = this.round;
    const inRound = this.phase === 'playing' && r.hands[pid];
    const hand = inRound ? r.hands[pid].slice().sort((a, b) => C.suitOf(a) - C.suitOf(b) || C.rankOf(a) - C.rankOf(b)) : [];
    const playing = this.phase === 'playing';
    return {
      phase: this.phase,
      round: this.roundNo,
      handSize: this.handSize,
      gameMode: this.gameMode, // Mode pass karna zaroori hai
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

  _allCards() {
    const r = this.round;
    const all = [].concat(r.deck, r.center === null ? [] : [r.center], r.pile ? r.pile.cards : []);
    for (const id of Object.keys(r.hands)) all.push(...r.hands[id]);
    return all;
  }
}

module.exports = { Game, GameError, SHOW_LIMIT, ELIMINATION, SHOW_PENALTY };