"""FastAPI backend: full game state kept here. Dice evaluated server-side."""
from typing import Dict, Optional, Set
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.game import GameManager

app = FastAPI(title="Monopoly Online")
mgr = GameManager()

subs: Dict[str, Set[WebSocket]] = {}

async def broadcast(gid: str):
    g = mgr.get(gid)
    if not g:
        return
    data = {"kind": "state", "state": g.to_dict()}
    for ws in list(subs.get(gid, set())):
        try:
            await ws.send_json(data)
        except Exception:
            pass

class CreateReq(BaseModel):
    maxPlayers: int = 4
    turnTimeout: int = 30
    mode: str = "ffa"  # ffa | team (2v2)

class JoinReq(BaseModel):
    name: str
    team: Optional[int] = None  # 0 | 1 (team mode)

class RollReq(BaseModel):
    playerId: str

class BuyReq(BaseModel):
    playerId: str

class UpgradeReq(BaseModel):
    playerId: str
    tile: int

class EndTurnReq(BaseModel):
    playerId: str

class TimerReq(BaseModel):
    turnTimeout: int

class CustomDiceReq(BaseModel):
    playerId: str
    d1: int
    d2: int

class RerollReq(BaseModel):
    playerId: str

class FlyReq(BaseModel):
    playerId: str
    destination: int

class BoostReq(BaseModel):
    playerId: str
    tile: int

class BailoutReq(BaseModel):
    playerId: str
    to: str
    amount: int

def _game(gid: str):
    g = mgr.get(gid)
    if not g:
        raise HTTPException(404, "game not found")
    return g

@app.post("/api/games")
async def create_game(req: CreateReq):
    g = mgr.create(max_players=req.maxPlayers, turn_timeout=req.turnTimeout, mode=req.mode)
    return {"gameId": g.id, "state": g.to_dict()}

@app.post("/api/games/{gid}/join")
async def join_game(gid: str, req: JoinReq):
    g = _game(gid)
    try:
        p = mgr.join(g, req.name, team=req.team)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast(gid)
    return {"playerId": p.id, "state": g.to_dict()}

@app.post("/api/games/{gid}/start")
async def start_game(gid: str):
    g = _game(gid)
    try:
        mgr.start(g)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast(gid)
    return {"state": g.to_dict()}

@app.get("/api/games/{gid}/state")
async def get_state(gid: str):
    g = _game(gid)
    g.check_timeout()
    return g.to_dict()

@app.post("/api/games/{gid}/roll")
async def roll_dice(gid: str, req: RollReq):
    g = _game(gid)
    try:
        res = mgr.roll(g, req.playerId)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/custom-roll")
async def custom_roll(gid: str, req: CustomDiceReq):
    """Targeted roll with a customized die (consumes resource)."""
    g = _game(gid)
    try:
        res = mgr.custom_roll(g, req.playerId, req.d1, req.d2)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/reroll")
async def reroll(gid: str, req: RerollReq):
    g = _game(gid)
    try:
        res = mgr.reroll(g, req.playerId)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/buy")
async def buy_prop(gid: str, req: BuyReq):
    g = _game(gid)
    try:
        res = mgr.buy(g, req.playerId)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/upgrade")
async def upgrade_prop(gid: str, req: UpgradeReq):
    g = _game(gid)
    try:
        res = mgr.upgrade(g, req.playerId, req.tile)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/boost")
async def boost_rent(gid: str, req: BoostReq):
    """World Championship effect: inflate rent of an owned city."""
    g = _game(gid)
    try:
        res = mgr.boost_rent(g, req.playerId, req.tile)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/fly")
async def fly(gid: str, req: FlyReq):
    """World Tour flight to almost any tile."""
    g = _game(gid)
    try:
        res = mgr.fly(g, req.playerId, req.destination)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/bailout")
async def bailout(gid: str, req: BailoutReq):
    """2v2: send cash to your partner."""
    g = _game(gid)
    try:
        res = mgr.bailout(g, req.playerId, req.to, req.amount)
    except ValueError as e:
        raise HTTPException(400, str(e))
    res["state"] = g.to_dict()
    await broadcast(gid)
    return res

@app.post("/api/games/{gid}/end-turn")
async def end_turn(gid: str, req: EndTurnReq):
    g = _game(gid)
    try:
        mgr.end_turn(g, req.playerId)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast(gid)
    return {"state": g.to_dict()}

@app.post("/api/games/{gid}/pay-jail")
async def pay_jail(gid: str, req: BuyReq):
    return await _pay_island(gid, req)

@app.post("/api/games/{gid}/pay-island")
async def pay_island(gid: str, req: BuyReq):
    return await _pay_island(gid, req)

async def _pay_island(gid: str, req: BuyReq):
    g = _game(gid)
    try:
        mgr.pay_jail(g, req.playerId)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast(gid)
    return {"state": g.to_dict()}

@app.post("/api/games/{gid}/timer")
async def set_timer(gid: str, req: TimerReq):
    g = _game(gid)
    g.turn_timeout = max(0, req.turnTimeout)
    g.start_turn_timer()
    await broadcast(gid)
    return {"state": g.to_dict()}

@app.websocket("/ws/{gid}/{pid}")
async def ws_game(ws: WebSocket, gid: str, pid: str):
    await ws.accept()
    subs.setdefault(gid, set()).add(ws)
    try:
        g = mgr.get(gid)
        if g:
            await ws.send_json({"kind": "state", "state": g.to_dict()})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        subs.get(gid, set()).discard(ws)

import os
FRONT = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(FRONT):
    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(os.path.join(FRONT, "index.html"))
    app.mount("/static", StaticFiles(directory=FRONT), name="static")
