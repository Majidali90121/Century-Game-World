# CENTURY – web card game (2–8 players)

Open a link, create a private room, share the code/link, play. No installs, no accounts.
Runs on any phone, tablet or computer browser.

## Run it
```
node server.js          # Node 18+; no npm install needed (zero dependencies)
# open http://localhost:3000   (PORT env var changes the port)
npm test                # 20 automated tests
```

## Put it online (one shareable URL)
Any host that runs Node works. Easiest free route: **Render.com**
1. Put this folder in a GitHub repo.
2. Render → New → Web Service → pick the repo. `render.yaml` is included (Free plan, `node server.js`, health check `/healthz`).
3. Render gives you `https://<name>.onrender.com` – that is the link you share.
(A `Dockerfile` is included for Fly.io, Railway, Google Cloud Run, etc.)

### Free-tier limits and costs (checked against Render's docs, Nov 2026 – re-check before relying on it)
- Free web services **spin down after 15 min without traffic**; the next visit takes ~1 minute to wake. Rooms live in server memory, so **a spin-down/restart/redeploy ends all rooms**. Active games keep it awake (every move is a request), but an idle lobby or a long break may not.
- 750 free instance hours/month per workspace; one instance only; outbound bandwidth is metered (a game uses very little).
- Cost to remove the sleep/restart limitation: Render's cheapest paid instance (a few dollars per month; see render.com/pricing). Nothing else is needed – there is no database.
- Not stored anywhere: no accounts, no personal data, only a display name held in memory while the room exists (rooms deleted after 6 h idle).

## How it works
- `lib/game.js` – the rules engine (authoritative). `lib/cards.js` – card/combination rules shared with the browser for previews only.
- `server.js` – rooms, per-player views, HTTP API, Server-Sent Events for live sync. Each player receives only **their own hand**; opponents' cards are never sent until SHOW.
- `public/` – the responsive client. Refreshing the page or a brief disconnect reseats you automatically (a secret token is kept in the browser).
- Host can start the game, set the starting hand (5–10, limited by player count), remove a *disconnected* player mid-game, and start a new game from the final screen.

## Rule decisions (please confirm)
Implemented exactly as in the brief, plus these interpretations where the brief is silent:
1. **Tie for lowest hand (brief §14, unconfirmed):** implemented as *all tied players share the round win* (each gets "rounds won" +1). This changes only the "rounds won" tally – scoring and penalties are unaffected. It is one line in `lib/game.js` (`x.winner = ...`) if you decide otherwise. No other tie-break was invented.
2. A single card may always be discarded, even if a pair/sequence is available (brief lists "one single card" as allowed).
3. Sequences are exactly 3 consecutive cards of one suit; Ace is low only (A-2-3 yes, Q-K-A no).
4. SHOW is called at the start of your turn instead of discarding; it is available whenever your hand is ≤ 6 at that moment (your hand only changes on your own turn, so this always means you got there on an earlier turn).
5. First player of round 1 is the host; afterwards the start rotates to the next active seat. Everyone is dealt the same hand size.
6. Centre card is chosen (value ≥ 6) before dealing; the draw deck always keeps ≥ 5 cards after the deal.
7. Unpicked cards of a discard go to the bottom of the deck in the order they were discarded, at the moment the next player picks (or draws instead).
8. If every remaining player is eliminated in the same round, the one with the lowest total wins. A player who leaves mid-game is out; their cards go to the bottom of the deck; if one player remains they win.
9. Eliminated players can keep watching.

## Testing done
- Rules unit tests (values, combos, setup for 2–8 players, centre/draw, pile returns, SHOW timing, penalty example from the brief, elimination, ranking).
- Randomised full-game simulations for 2–8 players with a 52-unique-cards check after every move.
- Network tests: full games over HTTP + live streams with 2, 4 and 8 players, verifying no hand leakage, out-of-turn rejection, room capacity, reconnect, host powers.
- Headless-browser run with phone and desktop viewports (screenshots reviewed).
Not tested: real-world load, or very old browsers.
