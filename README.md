# Monopoly Online (server-authoritative, 3D board)

Up to 4 players roll dice to navigate a square board of cities + specials.
**Full game state + dice on the backend** (FastAPI). Frontend only sends moves
and animates tokens from the server's `{dice, oldPos, newPos, events}` response.

## 3D board (Three.js, vendored locally)
- `frontend/board3d.js` renders all 28 tiles as 3D blocks around a square,
  with canvas-texture labels (name, price, rent, houses/hotel, boosts, owner),
  pawn tokens, house/hotel meshes, boost stars, owner flags, center logo slab.
- Camera starts **at the Start corner** (behind tile #0) looking diagonally
  across the board; drag to orbit, scroll to zoom, 📷 button resets the view.
- Rolls play a 3D dice toss (correct pips face up) + token hop per tile;
  World Tour flights arc through the air. Clicking a tile inspects it and
  pre-fills the fly-target box. Three.js r160 is vendored under
  `frontend/vendor/` so Docker works offline.

## Rules
- 28-tile board, $1500 start. Landing on an unowned city → option to buy.
- Passing **Start** grants $200 salary **+ a lap**; laps unlock upgrades
  (houses Lv1–Lv3, 🏨 hotel Lv4 from round 4). Rent scales with level.
- Specials:
  - 🏝️ **Lost Island** — trapped 3 turns (doubles to escape) or pay $150;
    the ⛈️ Storm tile sends you there.
  - 🏛️ **Tax Agency** — taxes 10% of total net worth (cash + deeds + investments).
  - 🏆 **World Championship** — landing grants a rent-boost token; inflate an
    owned city's rent +50% per boost (max 3, else $150 a boost).
  - ✈️ **World Tour** — pay $100 flight fee, then `/fly` to almost any tile
    (not Lost Island) on a later turn.
- Instant wins: bankrupt everyone · all **4 resorts** · full **side** ·
  **3 color sets** (triple monopoly). Game ends immediately.
- Modes: `ffa` or `team` (2v2: shared win, no rent on partner tiles, `/bailout`).
- Resources: 2× ⚙️ **custom dice** (targeted rolls) + 2× ↻ **re-rolls** per player.
- Optional per-turn timer (`turnTimeout`, 0=off), active from round 3.

## Run (docker)
```bash
docker compose up --build        # http://localhost:8000
```

## API
| Method | Endpoint | Notes |
|---|---|---|
| POST | `/api/games` `{maxPlayers, turnTimeout, mode}` | `mode`: ffa\|team |
| POST | `/api/games/{id}/join` `{name, team}` | team 0\|1 (team mode) |
| POST | `/api/games/{id}/start` | 2+ players (4 for 2v2) |
| GET  | `/api/games/{id}/state` | full state |
| POST | `/api/games/{id}/roll` `{playerId}` | random dice, server-side |
| POST | `/api/games/{id}/custom-roll` `{playerId, d1, d2}` | targeted roll |
| POST | `/api/games/{id}/reroll` `{playerId}` | undo + fresh roll |
| POST | `/api/games/{id}/buy` `{playerId}` | buy landed city |
| POST | `/api/games/{id}/upgrade` `{playerId, tile}` | needs 1 lap |
| POST | `/api/games/{id}/boost` `{playerId, tile}` | rent inflation |
| POST | `/api/games/{id}/fly` `{playerId, destination}` | World Tour |
| POST | `/api/games/{id}/bailout` `{playerId, to, amount}` | team partner |
| POST | `/api/games/{id}/end-turn` `{playerId}` | |
| POST | `/api/games/{id}/pay-island` (`/pay-jail` alias) | |
| POST | `/api/games/{id}/timer` `{turnTimeout}` | 0 disables |
| WS   | `/ws/{gameId}/{playerId}` | live state push |

## Tests
```bash
python3 -m pytest tests/ -q   # 17 tests: laps, island, tax 10%, tour/fly,
                               # boost, 3 instant wins, 2v2, custom dice/reroll…
```
