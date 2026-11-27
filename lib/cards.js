
/*  */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Card id 0..51 = suitIndex * 13 + (rank - 1); rank 1 = Ace ... 13 = King.
  const SUITS = [
    { key: 'H', sym: '♥', name: 'Hearts', red: true },
    { key: 'D', sym: '♦', name: 'Diamonds', red: true },
    { key: 'C', sym: '♣', name: 'Clubs', red: false },
    { key: 'S', sym: '♠', name: 'Spades', red: false },
  ];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const RANK_NAMES = ['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];

  const rankOf = (id) => (id % 13) + 1;
  const suitOf = (id) => Math.floor(id / 13);
  const valueOf = (id) => Math.min(rankOf(id), 10); // A=1, 2-10 face, J/Q/K=10
  const cardLabel = (id) => RANKS[rankOf(id) - 1] + SUITS[suitOf(id)].sym;
  const cardName = (id) => RANK_NAMES[rankOf(id) - 1] + ' of ' + SUITS[suitOf(id)].name;
  const handTotal = (cards) => cards.reduce((s, c) => s + valueOf(c), 0);
  const isCard = (c) => Number.isInteger(c) && c >= 0 && c <= 51;

  /* Valid discards: a single card, a pair / three / four of a kind, or a
     sequence of 3 or more consecutive ranks in ONE suit (Ace is low only:
     A-2-3 is valid, Q-K-A is not). Selection order does not matter. */
  function validateCombo(cards) {
    if (!Array.isArray(cards) || cards.length < 1 || cards.length > 13 || !cards.every(isCard)) {
      return { ok: false, error: 'Choose 1 to 13 cards to discard.' };
    }
    if (new Set(cards).size !== cards.length) return { ok: false, error: 'A card was selected twice.' };
    const n = cards.length;

    // Single card
    if (n === 1) return { ok: true, type: 'single', label: 'Single ' + cardLabel(cards[0]) };

    // Same rank: pair, three of a kind, four of a kind
    const rank = rankOf(cards[0]);
    if (cards.every((c) => rankOf(c) === rank)) {
      const word = RANKS[rank - 1];
      const type = n === 2 ? 'pair' : n === 3 ? 'three' : 'four';
      const label = n === 2 ? 'Pair of ' + word + 's' : n === 3 ? 'Three ' + word + 's' : 'Four ' + word + 's';
      return { ok: true, type, label };
    }

    // Sequence: 3+ cards, same suit, every rank exactly one above the previous
    if (n >= 3 && cards.every((c) => suitOf(c) === suitOf(cards[0]))) {
      const ranks = cards.map(rankOf).sort((a, b) => a - b);
      let isSequence = true;
      for (let i = 1; i < ranks.length; i++) { // NB: must be `i < ranks.length`
        if (ranks[i] !== ranks[i - 1] + 1) { isSequence = false; break; }
      }
      if (isSequence) {
        const sorted = cards.slice().sort((a, b) => rankOf(a) - rankOf(b));
        return { ok: true, type: 'sequence', label: 'Sequence ' + sorted.map(cardLabel).join(' ') };
      }
    }

    return {
      ok: false,
      error: 'Not a valid discard. Use a single, a pair/three/four of a kind, or 3+ consecutive cards of one suit.',
    };
  }
  return { SUITS, RANKS, rankOf, suitOf, valueOf, cardLabel, cardName, handTotal, validateCombo };
});
