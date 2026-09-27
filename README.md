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
- Every tile carries a **camera-facing name plate** (sprite): city name plus
  price / rent + owner / level / boosts, bordered in the group color —
  readable from the Start corner and every orbit angle. Flat tops show big
  index / price / rent for at-a-glance reading when zoomed in. Clicking any
  tile tells you exactly what **you** would pay landing there (rent to whom,
  ~tax on your net worth, flight fee, trap warnings).
- Chunky glowing pawns with floating **name tags**, tile plates pushed outward
  so tokens stay visible, and a pulsing gold **ring under the current player**.
- Corner **roster overlay** in the scene (seats → TL/TR/BL/BR): name, cash,
  net worth, status icons, gold border on whose turn it is — every cash change
  pops the panel green/red with a rising `+$200` / `-$50` ticker.
- 👁 HUD button or `H` key toggles the tile name plates (roster + tags stay on).
- Rolls play a 3D dice toss (correct pips face up) + token hop per tile;
  World Tour flights arc through the air. Clicking a tile inspects it and
  pre-fills the fly-target box. Three.js r160 is vendored under
  `frontend/vendor/` so Docker works offline.

## Rules
- 28-tile board, $1500 start. Landing on an unowned city → option to buy.
- Passing **Start** grants $200 salary **+ a lap**; laps unlock upgrades
  (houses Lv1–Lv3, 🏨 hotel Lv4 from round 4). Rent scales with level.
- **Upgrades only where you stand** — houses, hotels and rent boosts can only
  be built on the city your token is on (buy-at-level on purchase excepted).
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
- Modes: `ffa` (1–4, solo is a practice run — monopolies still win), or `team`
  (2v2: shared win, no rent on partner tiles, `/bailout`).
- Resources: 2× ⚙️ **custom dice** (targeted rolls) + 2× ↻ **re-rolls** per player.
- Optional per-turn timer (`turnTimeout`, 0=off), active from round 3.

## Frontend: fullscreen + everything in 3D
- Full-viewport flex layout (board fills available space) + ⛶ button that puts
  the **3D viewport itself** in fullscreen (page fallback) + collapsible side
  panel for a near-fullscreen board.
- No HTML controls in-game: a contextual **3D HUD bar** (camera-attached,
  auto-fit to window width) shows only relevant actions — Throw / Custom (×left) /
  Re-roll / Buy / Upgrade / Boost / Fly / Island / Bailout / End / Timer / View.
- All dialogs are **3D panels in the scene** (orbit locks while open): 🎲 dice
  result → ▶ move · 🏙️ buy-at-level (single tap, Lv0–4, lock reasons shown) ·
  🏝️ island pay-or-stay · ⚙️ custom-dice stepper picker · 💸 bailout amounts ·
  ⏱ timer presets · 🏆 game-over screen.
- World Tour fly works by **clicking a glowing tile** (pulsing highlight,
  Lost Island excluded); plain tile clicks inspect.
- Rent / tax / chance / tokens need no extra dialog — itemized in the dice dialog.

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
| POST | `/api/games/{id}/buy` `{playerId}` | buy landed city (level 0) |
| POST | `/api/games/{id}/buy-level` `{playerId, level}` | buy city built straight to Lv0–4 |
| POST | `/api/games/{id}/upgrade` `{playerId, tile}` | needs 1 lap + standing on it |
| POST | `/api/games/{id}/boost` `{playerId, tile}` | rent inflation, standing on it |
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
