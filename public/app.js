'use strict';
/* CENTURY browser client. It only renders what the server sends and submits
   intentions; the server validates everything. */
(function () {
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const LS = { session: 'century.session', name: 'century.name' };

  const S = {
    session: null, // {code, token, id}
    room: null, // latest server view
    es: null,
    conn: 'idle', // idle | ok | reconnecting
    sel: new Set(), // cards chosen to discard
    pick: null, // {source:'deck'|'pile'|'center', card?}
    sig: '',
    scores: false,
    busy: false,
    wasMyTurn: false,
    prefillCode: '',
  };

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  let toastTimer;
  function toast(msg, info) {
    $toast.textContent = msg;
    $toast.className = 'show' + (info ? ' info' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.className = ''; }, 3200);
  }
  async function api(path, body) {
    let r;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { status: 0 }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { status: r.status });
    return j;
  }
  const action = (type, extra) => api('/api/action', Object.assign({ code: S.session.code, token: S.session.token, type }, extra || {}));
  const inviteLink = (code) => location.origin + '/?room=' + code;

  function cardHtml(id, o) {
    o = o || {};
    const s = Cards.SUITS[Cards.suitOf(id)];
    const tag = o.static ? 'div' : 'button';
    const attrs = o.static ? '' : ' type="button"' + (o.disabled ? ' disabled' : '') + ' aria-pressed="' + (o.sel ? 'true' : 'false') + '"';
    return '<' + tag + ' class="card ' + (s.red ? 'red' : '') + (o.sel ? ' sel' : '') + (o.pickable ? ' pickable' : '') + (o.static ? ' static' : '') + (o.isNew ? ' new' : '') + '"' +
      ' data-card="' + id + '"' + (o.act ? ' data-act="' + o.act + '"' : '') + attrs + ' aria-label="' + esc(Cards.cardName(id)) + '">' +
      '<span class="cr">' + Cards.RANKS[Cards.rankOf(id) - 1] + '<i>' + s.sym + '</i></span><span class="cs">' + s.sym + '</span></' + tag + '>';
  }
  const miniCards = (cards) => '<div class="mini">' + cards.map((c) => cardHtml(c, { static: true })).join('') + '</div>';

  // ---------- connection ----------
  function saveSession(s) { S.session = s; lsSet(LS.session, s ? JSON.stringify(s) : null); }
  function goHome(msg) {
    if (S.es) { S.es.close(); S.es = null; }
    saveSession(null); S.room = null; S.conn = 'idle'; resetSel(); S.scores = false; S.prefillCode = '';
    history.replaceState(null, '', '/');
    if (msg) toast(msg);
    render();
  }
  function connect() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/events?code=' + encodeURIComponent(S.session.code) + '&token=' + encodeURIComponent(S.session.token));
    S.es = es;
    es.addEventListener('state', (e) => { S.room = JSON.parse(e.data); S.conn = 'ok'; onState(); render(); });
    es.onerror = () => {
      S.conn = 'reconnecting'; render();
      if (es.readyState === EventSource.CLOSED) setTimeout(recheck, 1500); // server refused: room gone or we were removed
    };
  }
  async function recheck() {
    if (!S.session) return;
    try { await api('/api/join', { code: S.session.code, token: S.session.token, rejoin: true }); connect(); }
    catch (e) {
      if (e.status === 404 || e.status === 400) goHome('That room is no longer available.');
      else setTimeout(recheck, 3000);
    }
  }

  // ---------- selection state ----------
  function resetSel() { S.sel = new Set(); S.pick = null; }
  function onState() {
    const g = S.room && S.room.game;
    const mine = !!(g && g.phase === 'playing' && g.turnId === g.you.id);
    const sig = g ? g.round + ':' + g.turnId + ':' + g.you.hand.join(',') + ':' + (g.pile ? g.pile.cards.join(',') : '') : '';
    if (sig !== S.sig) { resetSel(); S.sig = sig; }
    if (mine && !S.wasMyTurn) {
      if (navigator.vibrate) { try { navigator.vibrate(150); } catch (e) { /* ignore */ } }
      toast('Your turn!', true);
    }
    S.wasMyTurn = mine;
    document.title = mine ? '● Your turn – CENTURY' : 'CENTURY – Card Game';
  }

  // ---------- views ----------
  function viewHome() {
    const code = S.prefillCode;
    return '<div class="wrap">' +
      '<div class="hero"><h1 class="logo">CENTURY</h1>' +
      '<p class="tag">Discard smart combinations, get your hand to 6 points or less, and call <b>SHOW</b> at the right moment. Reach 100 points and you’re out. Last one standing wins.</p></div>' +
      '<div class="panel home-card stack">' +
      '<div><label class="lbl" for="name">Your name</label><input id="name" class="field" maxlength="16" autocomplete="nickname" placeholder="e.g. Sam" value="' + esc(lsGet(LS.name) || '') + '"></div>' +
      (code ? '' : '<button class="btn primary block" data-act="create">Create private room</button><div class="or">or join a friend</div>') +
      '<div><label class="lbl" for="code">Room code</label><input id="code" class="field code-input" maxlength="5" autocapitalize="characters" autocomplete="off" placeholder="ABCDE" value="' + esc(code) + '"></div>' +
      '<button class="btn ' + (code ? 'primary' : '') + ' block" data-act="join">Join room</button>' +
      (code ? '<div class="or">or</div><button class="btn block" data-act="create">Create my own room</button>' : '') +
      '</div>' +
      '<details class="rules"><summary>How to play</summary><ul>' +
      '<li><b>Goal:</b> get your hand total to <b>6 or less</b>, then call SHOW on your next turn. A=1, 2–10 face value, J/Q/K=10.</li>' +
      '<li><b>Each turn:</b> discard one combination — a single, a pair / three / four of a kind, or three consecutive cards of the same suit — then pick exactly one card.</li>' +
      '<li><b>Picking:</b> take one card from the previous player’s discard, or draw from the deck. (The first player may take the centre card instead.)</li>' +
      '<li><b>SHOW:</b> everyone reveals. Lowest total wins the round, but if someone has strictly less than the caller, the caller gets +20 for each such player.</li>' +
      '<li><b>Scoring:</b> every player scores their remaining hand. Reach 100 and you’re eliminated.</li></ul></details>' +
      '</div>';
  }

  function viewLobby(room) {
    const host = room.hostId === room.you;
    const n = room.members.length;
    const hands = [];
    for (let h = 5; h <= room.maxHandSize; h++) hands.push('<option value="' + h + '"' + (h === room.handSize ? ' selected' : '') + '>' + h + ' cards</option>');
    return '<div class="wrap">' +
      '<div class="top"><span class="title">CENTURY</span><button class="btn small" data-act="leave">Leave</button></div>' +
      '<div class="panel center"><div class="muted">Room code</div><div class="room-code">' + esc(room.code) + '</div>' +
      '<div class="row" style="justify-content:center"><button class="btn primary" data-act="copy">Copy invite link</button>' +
      (navigator.share ? '<button class="btn" data-act="share">Share…</button>' : '') + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Friends open the link (or enter the code) and type a name. 2–8 players.</p></div>' +
      '<div class="panel" style="margin-top:14px"><h3 class="row" style="justify-content:space-between">Players <span class="muted" style="font-size:14px;font-weight:400">' + n + ' / 8</span></h3>' +
      '<ul class="plist">' + room.members.map((m) => '<li><span class="dot ' + (m.connected ? '' : 'off') + '"></span><span class="grow">' + esc(m.name) + '</span>' +
        (m.id === room.hostId ? '<span class="badge">Host</span>' : '') + (m.id === room.you ? '<span class="badge you">You</span>' : '') +
        (host && m.id !== room.you ? '<button class="btn small" data-act="remove" data-id="' + m.id + '">Remove</button>' : '') + '</li>').join('') + '</ul></div>' +
      '<div class="panel stack" style="margin-top:14px">' +
      (host
        ? '<div><label class="lbl" for="hs">Starting hand size</label><select id="hs" class="field">' + hands.join('') + '</select>' +
          '<div class="muted" style="font-size:13px;margin-top:6px">Maximum for ' + Math.max(2, n) + ' players: ' + room.maxHandSize + ' cards.</div></div>' +
          '<button class="btn primary block" data-act="start"' + (n < 2 ? ' disabled' : '') + '>' + (n < 2 ? 'Waiting for another player…' : 'Start game') + '</button>'
        : '<p class="center muted" style="margin:0">Waiting for the host to start the game…<br>Starting hand: ' + room.handSize + ' cards.</p>') +
      '</div></div>';
  }

  const nameOf = (g, id) => { const p = g.players.find((x) => x.id === id); return p ? p.name : '?'; };

  function playersStrip(g) {
    return '<div class="players">' + g.players.map((p) => {
      const out = p.status !== 'active';
      return '<div class="pchip' + (g.turnId === p.id ? ' turn' : '') + (out ? ' out' : '') + '">' +
        '<div class="n"><span class="dot ' + (p.connected || p.status !== 'active' ? '' : 'off') + '"></span>' + esc(p.name) + (p.id === g.you.id ? ' <span class="badge you">You</span>' : '') + '</div>' +
        '<div class="s">' + (out ? '<span>' + (p.status === 'left' ? 'Left' : 'Eliminated') + '</span>' : '<span>\u{1F0A0} <b>' + p.cards + '</b></span>') + '<span>Total <b>' + p.total + '</b></span></div></div>';
    }).join('') + '</div>';
  }

  function viewGame(room) {
    const g = room.game;
    if (g.phase === 'roundEnd') return viewRoundEnd(room);
    if (g.phase === 'gameEnd') return viewGameEnd(room);
    const me = g.you;
    const mine = g.turnId === me.id && me.inRound;
    const first = g.center !== null;
    const combo = S.sel.size ? Cards.validateCombo([...S.sel]) : null;
    const ready = mine && combo && combo.ok && S.pick;
    const turnName = nameOf(g, g.turnId);

    let status, hint = '';
    if (!me.inRound) status = 'You are watching this round.';
    else if (mine) {
      status = me.canShow ? 'Your turn — call SHOW, or play a move.' : 'Your turn';
      hint = !S.sel.size ? '1. Tap the card(s) you want to discard.' : !(combo && combo.ok) ? '' : !S.pick ? '2. Now tap the deck or a card to pick up.' : '3. Press “Play move”.';
    } else {
      status = 'Waiting for ' + turnName + '…';
      if (me.handTotal <= 6) hint = 'You’re at ' + me.handTotal + ' — you can call SHOW when your turn comes.';
    }

    const deckSel = S.pick && S.pick.source === 'deck';
    let pileZone;
    if (first) {
      const sel = S.pick && S.pick.source === 'center';
      pileZone = '<div class="zone"><h3>Centre card</h3><div class="cards">' + cardHtml(g.center, { act: 'pick-center', sel, pickable: mine, disabled: !mine, static: !mine }) + '</div></div>';
    } else if (g.pile) {
      pileZone = '<div class="zone"><h3>' + esc(nameOf(g, g.pile.by)) + '’s discard</h3><div class="cards">' +
        g.pile.cards.map((c) => cardHtml(c, { act: 'pick-pile', sel: S.pick && S.pick.source === 'pile' && S.pick.card === c, pickable: mine, disabled: !mine, static: !mine })).join('') +
        '</div><div class="muted" style="font-size:13px;margin-top:6px">' + esc(g.pile.label) + '</div></div>';
    } else pileZone = '';

    return '<div class="wrap">' +
      '<div class="top"><span class="title">CENTURY</span><span class="meta">Round ' + g.round + ' · Room ' + esc(room.code) + '</span>' +
      '<span class="row"><button class="btn small" data-act="scores">Scores</button><button class="btn small" data-act="leave">Leave</button></span></div>' +
      playersStrip(g) + hostRemove(room) +
      '<div class="table"><div class="zones">' +
      '<div class="zone"><h3>Draw deck</h3><button class="deck' + (deckSel ? ' sel' : '') + '" data-act="pick-deck" aria-label="Draw from the deck" aria-pressed="' + !!deckSel + '"' + (mine && g.deckCount + (first ? 1 : 0) > 0 ? '' : ' disabled') + '><span>' + g.deckCount + '</span></button></div>' +
      pileZone + '</div>' +
      '<div class="status ' + (mine ? 'mine' : '') + '">' + esc(status) + '</div><div class="hint">' + esc(hint) + '</div>' +
      (me.inRound ? '<div class="hand-area"><div class="handbar"><span class="muted">Your hand</span><span class="total ' + (me.handTotal <= 6 ? 'low' : '') + '">Total <b>' + me.handTotal + '</b></span></div>' +
        '<div class="hand">' + me.hand.map((c) => cardHtml(c, { act: 'toggle', sel: S.sel.has(c), disabled: !mine, static: !mine })).join('') + '</div>' +
        '<div class="combo ' + (combo ? (combo.ok ? 'ok' : 'bad') : '') + '">' + (mine && combo ? esc(combo.ok ? 'Discarding: ' + combo.label : combo.error) : '&nbsp;') + '</div>' +
        (mine ? '<div class="actions"><button class="btn primary" data-act="play"' + (ready ? '' : ' disabled') + '>Play move</button>' +
          (me.canShow ? '<button class="btn danger" data-act="show">SHOW (' + me.handTotal + ')</button>' : '') + '</div>' : '') +
        '</div>' : '') +
      '</div>' +
      '<div class="log">' + g.log.slice(-5).map((l) => '<div>' + esc(l) + '</div>').join('') + '</div>' +
      '</div>';
  }

  function hostRemove(room) {
    if (room.hostId !== room.you) return '';
    const g = room.game;
    const off = g.players.filter((p) => p.status !== 'left' && p.id !== room.you && p.connected === false);
    if (!off.length) return '';
    return '<div class="panel row" style="margin:4px 0 8px;padding:10px 12px"><span class="muted grow" style="font-size:14px">Disconnected: ' + off.map((p) => esc(p.name)).join(', ') +
      '. If they can’t come back, you can remove them so play continues.</span>' +
      off.map((p) => '<button class="btn small" data-act="remove" data-id="' + p.id + '">Remove ' + esc(p.name) + '</button>').join('') + '</div>';
  }

  function scoreTable(g) {
    return '<div class="scroll"><table class="tbl"><thead><tr><th>Player</th><th>Status</th><th title="Hand points, last round">Hand</th><th title="SHOW penalty, last round">Penalty</th><th>Round</th><th>Total</th><th>Wins</th></tr></thead><tbody>' +
      g.players.map((p) => '<tr class="' + (p.status !== 'active' ? 'out' : '') + '"><td>' + esc(p.name) + '</td><td>' +
        (p.status === 'active' ? 'Active' : p.status === 'left' ? 'Left' : 'Eliminated') + '</td>' +
        '<td>' + (p.last ? p.last.hand : '–') + '</td><td>' + (p.last ? (p.last.penalty ? '+' + p.last.penalty : '0') : '–') + '</td><td>' + (p.last ? p.last.round : '–') + '</td>' +
        '<td><b>' + p.total + '</b></td><td>' + p.roundsWon + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="muted" style="font-size:13px;margin-top:8px">Hand / Penalty / Round show the most recent finished round. Total is cumulative; 100 or more is elimination.</div>';
  }

  function viewRoundEnd(room) {
    const g = room.game, res = g.result;
    const decl = nameOf(g, res.declarerId);
    const winners = res.winners.map((id) => nameOf(g, id));
    const me = g.players.find((p) => p.id === g.you.id);
    return '<div class="wrap"><div class="top"><span class="title">CENTURY</span><span class="meta">Room ' + esc(room.code) + '</span></div>' +
      '<div class="panel banner"><div class="muted">Round ' + res.round + ' — ' + esc(decl) + ' called SHOW</div>' +
      '<h2>' + esc(winners.join(' & ')) + ' ' + (winners.length > 1 ? 'share the round' : 'wins the round') + '</h2>' +
      '<div class="muted">Lowest hand: ' + res.lowest + (res.winners.includes(res.declarerId) ? '' : ' — ' + esc(decl) + ' did not have the lowest hand') + '</div></div>' +
      '<div class="panel" style="margin-top:14px"><div class="scroll"><table class="tbl"><thead><tr><th>Player</th><th>Hand</th><th>Penalty</th><th>Round</th><th>Total</th></tr></thead><tbody>' +
      res.rows.map((r) => '<tr class="' + (r.winner ? 'winner' : '') + '" style="border-top:1px solid var(--line)"><td style="border:0">' + esc(r.name) + '</td><td style="border:0">' + r.handPoints + '</td><td style="border:0">' + (r.penalty ? '+' + r.penalty : '0') + '</td><td style="border:0">' + r.roundPoints + '</td><td style="border:0"><b>' + r.total + '</b></td></tr>' +
        '<tr class="' + (r.winner ? 'winner' : '') + '"><td colspan="5" style="border:0;text-align:left;padding-top:0">' + (r.winner ? '<span class="badge win">Winner</span> ' : '') + (r.declarer ? '<span class="badge">SHOW</span> ' : '') + (r.eliminated ? '<span class="badge bad">Eliminated</span>' : '') + miniCards(r.hand) + '</td></tr>').join('') +
      '</tbody></table></div></div>' +
      '<div class="actions" style="margin-top:16px">' +
      (me && me.status !== 'left' ? '<button class="btn primary" data-act="next">' + (res.gameOver ? 'See final results' : 'Next round') + '</button>' : '') + '</div>' +
      '<p class="center muted" style="font-size:14px">Anyone can continue once everyone has seen the result.</p></div>';
  }

  function viewGameEnd(room) {
    const g = room.game;
    const host = room.hostId === room.you;
    const win = g.ranking[0];
    return '<div class="wrap"><div class="top"><span class="title">CENTURY</span><span class="meta">Room ' + esc(room.code) + '</span></div>' +
      '<div class="panel banner"><div class="muted">Overall CENTURY winner</div><h2>\u{1F451} ' + esc(win.name) + '</h2><div class="muted">' + win.total + ' points · ' + win.roundsWon + ' round' + (win.roundsWon === 1 ? '' : 's') + ' won</div></div>' +
      '<div class="panel" style="margin-top:14px"><div class="scroll"><table class="tbl"><thead><tr><th>#</th><th>Player</th><th>Status</th><th>Total</th><th>Rounds won</th></tr></thead><tbody>' +
      g.ranking.map((r) => '<tr><td class="rank" style="text-align:left">' + r.rank + '</td><td>' + esc(r.name) + '</td><td>' + (r.rank === 1 ? 'Winner' : r.status === 'left' ? 'Left' : 'Eliminated') + '</td><td><b>' + r.total + '</b></td><td>' + r.roundsWon + '</td></tr>').join('') +
      '</tbody></table></div></div>' +
      '<div class="actions" style="margin-top:16px">' + (host ? '<button class="btn primary" data-act="reset">Play again (back to lobby)</button>' : '<span class="muted">Waiting for the host to start a new game…</span>') +
      '<button class="btn" data-act="leave">Leave room</button></div></div>';
  }

  function render() {
    const focus = document.activeElement && document.activeElement.id;
    const room = S.room;
    let html;
    if (!S.session || !room) html = S.session ? '<div class="wrap center" style="padding-top:80px"><h2 class="serif">Connecting…</h2></div>' : viewHome();
    else html = room.game ? viewGame(room) : viewLobby(room);
    if (S.conn === 'reconnecting' && S.session) html = '<div class="conn">Reconnecting…</div>' + html;
    if (S.scores && room && room.game) html += '<div class="modal" data-act="close-scores"><div class="sheet" data-stop><div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 class="serif">Scoreboard</h3><button class="btn small" data-act="close-scores">Close</button></div>' + scoreTable(room.game) + '</div></div>';
    const keep = (focus === 'name' || focus === 'code') ? { id: focus, v: document.getElementById(focus).value, s: document.getElementById(focus).selectionStart } : null;
    $app.innerHTML = html;
    if (keep) { const el = document.getElementById(keep.id); if (el) { el.value = keep.v; el.focus(); try { el.setSelectionRange(keep.s, keep.s); } catch (e) { /* ignore */ } } }
  }

  // ---------- events ----------
  async function guarded(fn) {
    if (S.busy) return;
    S.busy = true;
    try { await fn(); } catch (e) { toast(e.message); if (e.status === 404 && S.session) { setTimeout(recheck, 0); } }
    finally { S.busy = false; }
  }

  $app.addEventListener('input', (e) => { if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $app.addEventListener('change', (e) => {
    if (e.target.id === 'hs') guarded(() => action('settings', { handSize: Number(e.target.value) }));
  });
  $app.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.id === 'name' || e.target.id === 'code')) {
      const code = document.getElementById('code').value.trim();
      const btn = $app.querySelector(code ? '[data-act=join]' : '[data-act=create]');
      if (btn) btn.click();
    }
  });
  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'close-scores') { if (el.classList.contains('modal') && e.target !== el) return; S.scores = false; return render(); }
    const room = S.room, g = room && room.game;
    switch (act) {
      case 'create': case 'join': return guarded(async () => {
        const name = document.getElementById('name').value.trim();
        if (!name) { document.getElementById('name').focus(); throw new Error('Please enter your name first.'); }
        lsSet(LS.name, name);
        let r;
        if (act === 'create') r = await api('/api/create', { name });
        else {
          const code = document.getElementById('code').value.trim();
          if (code.length < 5) throw new Error('Enter the 5-letter room code.');
          r = await api('/api/join', { code, name });
        }
        saveSession({ code: r.code, token: r.token, id: r.id });
        history.replaceState(null, '', '/?room=' + r.code);
        S.room = null; render(); connect();
      });
      case 'copy': return navigator.clipboard && navigator.clipboard.writeText(inviteLink(room.code)).then(() => toast('Invite link copied', true), () => toast(inviteLink(room.code), true));
      case 'share': return navigator.share({ title: 'CENTURY', text: 'Join my CENTURY card game! Room ' + room.code, url: inviteLink(room.code) }).catch(() => {});
      case 'leave': if (!confirm('Leave this room?')) return;
        return guarded(async () => { try { await action('leave'); } catch (err) { /* already gone */ } goHome(); });
      case 'start': return guarded(() => action('start'));
      case 'remove': return guarded(() => action('remove', { target: el.dataset.id }));
      case 'reset': return guarded(() => action('reset'));
      case 'next': return guarded(() => action('next'));
      case 'scores': S.scores = true; return render();
      case 'toggle': {
        const id = Number(el.dataset.card);
        if (S.sel.has(id)) S.sel.delete(id); else if (S.sel.size < 4) S.sel.add(id);
        return render();
      }
      case 'pick-deck': S.pick = { source: 'deck' }; return render();
      case 'pick-center': S.pick = { source: 'center' }; return render();
      case 'pick-pile': S.pick = { source: 'pile', card: Number(el.dataset.card) }; return render();
      case 'play': return guarded(async () => {
        const body = { discard: [...S.sel], source: S.pick.source };
        if (S.pick.card != null) body.card = S.pick.card;
        await action('play', body);
        resetSel();
      });
      case 'show': if (!confirm('Call SHOW with ' + g.you.handTotal + ' points? Everyone reveals their hand. If anyone has strictly fewer points you get +20 for each of them.')) return;
        return guarded(() => action('show'));
    }
  });

  // ---------- boot ----------
  (function boot() {
    const params = new URLSearchParams(location.search);
    const urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    let saved = null;
    try { saved = JSON.parse(lsGet(LS.session) || 'null'); } catch (e) { /* ignore */ }
    if (saved && saved.code && saved.token && (!urlCode || urlCode === saved.code)) {
      S.session = saved;
      render();
      recheck(); // confirms the seat still exists, then opens the live connection
      return;
    }
    S.prefillCode = urlCode;
    render();
  })();
})();
