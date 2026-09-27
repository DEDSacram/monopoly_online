"""Core game logic. Full state kept on backend. Dice evaluated server-side.

Rules (per design doc):
- Up to 4 players roll dice to navigate a square board of cities + specials.
- Landing on an unowned city -> option to buy.
- Passing Start grants salary AND a lap; upgrades unlock only after 1+ laps.
- Houses Lv1-Lv3, Lv4 HOTEL (round-gated). Hotels/boosts multiply rent.
- Specials: Lost Island (trap unless fee), Tax Agency (10% of net worth),
  World Championship (rent-boost tokens), World Tour (paid flight, then fly
  almost anywhere next turn).
- Instant wins: bankrupt everyone | all 4 resorts | full side | 3 color sets.
- Modes: free-for-all or 2v2 teams (shared win, free rent, bailouts).
- Resources: custom dice (targeted rolls) + rerolls.
"""
import copy
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

START_MONEY = 1500
GO_SALARY = 200
ISLAND_FINE = 150        # hefty fee to escape Lost Island
TRAP_TURNS = 3           # turns trapped on Lost Island
FLIGHT_FEE = 100         # World Tour flight fee
BOOST_COST = 150         # World Championship paid boost (free if token held)
MAX_BOOST = 3            # max rent-boosts per city
HOTEL_UNLOCK_ROUND = 4   # Lv4 hotel only after this round
TIMER_START_ROUND = 3
DEFAULT_TURN_TIMEOUT = 30

RENT_MULT = [1.0, 2.0, 3.5, 5.5, 8.0]  # L0..L4
BOOST_MULT = 0.5  # each boost adds +50% rent


def make_board():
    return [
        {"name": "Start", "type": "go"},
        {"name": "Harbor Town", "type": "property", "price": 60, "base_rent": 6, "group": "brown", "upgrade_cost": 50},
        {"name": "Chance", "type": "chance"},
        {"name": "Portside", "type": "property", "price": 60, "base_rent": 6, "group": "brown", "upgrade_cost": 50},
        {"name": "Tax Agency", "type": "tax_agency"},
        {"name": "Coral Resort", "type": "property", "price": 300, "base_rent": 30, "group": "resort", "upgrade_cost": 150},
        {"name": "Neon City", "type": "property", "price": 100, "base_rent": 10, "group": "cyan", "upgrade_cost": 50},
        {"name": "Lost Island", "type": "island"},
        {"name": "Glass City", "type": "property", "price": 100, "base_rent": 10, "group": "cyan", "upgrade_cost": 50},
        {"name": "Mirror City", "type": "property", "price": 120, "base_rent": 12, "group": "cyan", "upgrade_cost": 60},
        {"name": "World Tour", "type": "tour"},
        {"name": "Rose Town", "type": "property", "price": 140, "base_rent": 14, "group": "pink", "upgrade_cost": 100},
        {"name": "World Championship", "type": "championship"},
        {"name": "Sakura Town", "type": "property", "price": 140, "base_rent": 14, "group": "pink", "upgrade_cost": 100},
        {"name": "Ember City", "type": "property", "price": 180, "base_rent": 18, "group": "orange", "upgrade_cost": 100},
        {"name": "Palm Resort", "type": "property", "price": 300, "base_rent": 30, "group": "resort", "upgrade_cost": 150},
        {"name": "Blaze City", "type": "property", "price": 200, "base_rent": 20, "group": "orange", "upgrade_cost": 100},
        {"name": "Ruby City", "type": "property", "price": 220, "base_rent": 22, "group": "red", "upgrade_cost": 120},
        {"name": "Chance", "type": "chance"},
        {"name": "Garnet City", "type": "property", "price": 240, "base_rent": 24, "group": "red", "upgrade_cost": 120},
        {"name": "Storm -> Lost Island", "type": "sender"},
        {"name": "Pine Town", "type": "property", "price": 160, "base_rent": 16, "group": "green", "upgrade_cost": 100},
        {"name": "Tax Agency", "type": "tax_agency"},
        {"name": "Fern Town", "type": "property", "price": 180, "base_rent": 18, "group": "green", "upgrade_cost": 100},
        {"name": "Azure Bay", "type": "property", "price": 200, "base_rent": 20, "group": "blue", "upgrade_cost": 120},
        {"name": "Ivory Resort", "type": "property", "price": 350, "base_rent": 35, "group": "resort", "upgrade_cost": 175},
        {"name": "Cobalt Bay", "type": "property", "price": 220, "base_rent": 22, "group": "blue", "upgrade_cost": 120},
        {"name": "Pearl Resort", "type": "property", "price": 350, "base_rent": 35, "group": "resort", "upgrade_cost": 175},
    ]


BOARD = make_board()
BOARD_SIZE = len(BOARD)
ISLAND_INDEX = 7
RESORT_TILES = [i for i, t in enumerate(BOARD) if t.get("group") == "resort"]
SIDES = [list(range(0, 7)), list(range(7, 14)), list(range(14, 21)), list(range(21, 28))]
GROUP_TILES: Dict[str, List[int]] = {}
for i, t in enumerate(BOARD):
    if t["type"] == "property":
        GROUP_TILES.setdefault(t["group"], []).append(i)

CHANCE_CARDS = [
    ("Bank pays you dividend", 100),
    ("Pay hospital fees", -75),
    ("Win lottery", 150),
    ("Pay speeding fine", -50),
    ("Tax refund", 75),
    ("Street repairs", -40),
]


@dataclass
class Player:
    id: str
    name: str
    color: str
    team: int = 0
    position: int = 0
    money: int = START_MONEY
    in_jail: bool = False       # trapped on Lost Island
    jail_turns: int = 0
    bankrupt: bool = False
    doubles_count: int = 0
    has_rolled: bool = False
    laps: int = 0               # full laps via Start
    tour_pending: bool = False  # World Tour flight available
    custom_dice: int = 2        # targeted-roll resources
    rerolls: int = 2            # re-roll resources
    boost_tokens: int = 0       # free rent-boosts from World Championship


@dataclass
class Game:
    id: str
    players: List[Player] = field(default_factory=list)
    ownership: Dict[int, str] = field(default_factory=dict)
    levels: Dict[int, int] = field(default_factory=dict)
    boost: Dict[int, int] = field(default_factory=dict)          # tile -> 0..MAX_BOOST
    upgrade_spent: Dict[int, int] = field(default_factory=dict)  # tile -> $ invested
    current: int = 0
    round: int = 1
    status: str = "waiting"
    winner: Optional[str] = None
    winning_team: Optional[int] = None
    win_reason: Optional[str] = None
    log: List[str] = field(default_factory=list)
    last_dice: List[int] = field(default_factory=lambda: [1, 1])
    turn_timeout: int = DEFAULT_TURN_TIMEOUT
    turn_deadline: Optional[float] = None
    max_players: int = 4
    mode: str = "ffa"  # ffa | team
    _snapshots: Dict[str, dict] = field(default_factory=dict, repr=False)

    def log_msg(self, m: str):
        self.log.append(f"[R{self.round}] {m}")
        if len(self.log) > 200:
            self.log = self.log[-200:]

    def current_player(self) -> Optional[Player]:
        if not self.players:
            return None
        return self.players[self.current % len(self.players)]

    def get_player(self, pid: str) -> Optional[Player]:
        for p in self.players:
            if p.id == pid:
                return p
        return None

    def active_players(self):
        return [p for p in self.players if not p.bankrupt]

    # ---- economy ----
    def net_worth(self, p: Player) -> int:
        total = p.money
        for i, o in self.ownership.items():
            if o == p.id:
                total += BOARD[i].get("price", 0) + self.upgrade_spent.get(i, 0)
        return total

    def rent_for(self, tile_idx: int) -> int:
        tile = BOARD[tile_idx]
        lvl = self.levels.get(tile_idx, 0)
        b = self.boost.get(tile_idx, 0)
        return int(tile["base_rent"] * RENT_MULT[lvl] * (1 + BOOST_MULT * b))

    def completed_groups(self, pid: str) -> List[str]:
        done = []
        for grp, tiles in GROUP_TILES.items():
            if tiles and all(self.ownership.get(i) == pid for i in tiles):
                done.append(grp)
        return done

    def completed_side(self, pid: str) -> Optional[int]:
        for s, tiles in enumerate(SIDES):
            props = [i for i in tiles if BOARD[i]["type"] == "property"]
            if props and all(self.ownership.get(i) == pid for i in props):
                return s
        return None

    # ---- timer ----
    def timer_active(self) -> bool:
        return (
            self.turn_timeout > 0
            and self.status == "playing"
            and self.round >= TIMER_START_ROUND
            and self.turn_deadline is not None
        )

    def seconds_left(self) -> Optional[float]:
        if not self.timer_active():
            return None
        return max(0.0, self.turn_deadline - time.time())

    def start_turn_timer(self):
        if self.turn_timeout > 0 and self.round >= TIMER_START_ROUND:
            self.turn_deadline = time.time() + self.turn_timeout
        else:
            self.turn_deadline = None

    def check_timeout(self) -> bool:
        if self.status != "playing":
            return False
        if self.turn_timeout <= 0 or self.round < TIMER_START_ROUND:
            return False
        if self.turn_deadline is None:
            return False
        if time.time() < self.turn_deadline:
            return False
        p = self.current_player()
        self.log_msg(f"Timer expired for {p.name} — turn skipped.")
        self._advance_turn()
        return True

    def _advance_turn(self):
        for _ in range(len(self.players)):
            self.current = (self.current + 1) % len(self.players)
            if self.current == 0:
                self.round += 1
            if not self.players[self.current].bankrupt:
                break
        nxt = self.current_player()
        if nxt:
            nxt.has_rolled = False
            nxt.doubles_count = 0
        self._snapshots.clear()
        self.start_turn_timer()
        self.check_winner()

    # ---- winners ----
    def _finish(self, pid: str, reason: str, detail: str):
        p = self.get_player(pid)
        self.status = "finished"
        self.winner = pid
        self.winning_team = p.team if p else None
        self.win_reason = reason
        self.log_msg(f"{p.name if p else '?'} wins instantly: {detail} [{reason}]")

    def check_monopoly_win(self, pid: str) -> bool:
        """Instant-win: 4 resorts | full side | triple monopoly. Returns True if won."""
        if self.status != "playing":
            return False
        if all(self.ownership.get(i) == pid for i in RESORT_TILES):
            self._finish(pid, "resort_monopoly", "all 4 resorts")
            return True
        side = self.completed_side(pid)
        if side is not None:
            self._finish(pid, "side_monopoly", f"owns full side {side + 1}")
            return True
        groups = self.completed_groups(pid)
        if len(groups) >= 3:
            self._finish(pid, "triple_monopoly", f"3 color sets ({', '.join(groups)})")
            return True
        return False

    def check_winner(self):
        if self.status != "playing":
            return
        if self.mode == "team":
            teams: Dict[int, List[Player]] = {}
            for p in self.players:
                teams.setdefault(p.team, []).append(p)
            alive_teams = {t: [p for ps in [ps2 for t2, ps2 in teams.items() if t2 == t] for p in ps] for t in teams}
            alive = {t: [p for p in ps if not p.bankrupt] for t, ps in teams.items() if t in (0, 1)}
            if 0 in alive and 1 in alive:
                if len(alive[0]) == 0 and len(alive[1]) > 0:
                    self.status = "finished"
                    self.winner = alive[1][0].id
                    self.winning_team = 1
                    self.win_reason = "team_elimination"
                    self.log_msg("Team 2 wins — Team 1 eliminated!")
                elif len(alive[1]) == 0 and len(alive[0]) > 0:
                    self.status = "finished"
                    self.winner = alive[0][0].id
                    self.winning_team = 0
                    self.win_reason = "team_elimination"
                    self.log_msg("Team 1 wins — Team 2 eliminated!")
            _ = alive_teams
        else:
            alive = self.active_players()
            if len(alive) == 1 and len(self.players) > 1:
                self.status = "finished"
                self.winner = alive[0].id
                self.winning_team = alive[0].team
                self.win_reason = "bankruptcy"
                self.log_msg(f"{alive[0].name} wins the game!")
            elif len(alive) == 0:
                self.status = "finished"
                self.win_reason = "bankruptcy"

    # ---- snapshots (re-roll support) ----
    def snapshot(self, pid: str):
        self._snapshots[pid] = {
            "players": copy.deepcopy([(p.position, p.money, p.in_jail, p.jail_turns,
                                       p.bankrupt, p.laps, p.tour_pending, p.doubles_count,
                                       p.custom_dice, p.rerolls, p.boost_tokens) for p in self.players]),
            "last_dice": list(self.last_dice),
        }

    def restore(self, pid: str) -> bool:
        snap = self._snapshots.get(pid)
        if not snap:
            return False
        for p, s in zip(self.players, snap["players"]):
            (p.position, p.money, p.in_jail, p.jail_turns, p.bankrupt, p.laps,
             p.tour_pending, p.doubles_count, p.custom_dice, p.rerolls, p.boost_tokens) = s
        self.last_dice = list(snap["last_dice"])
        return True

    def to_dict(self):
        return {
            "id": self.id,
            "status": self.status,
            "round": self.round,
            "current": self.current,
            "currentPlayerId": self.current_player().id if self.current_player() else None,
            "lastDice": self.last_dice,
            "winner": self.winner,
            "winningTeam": self.winning_team,
            "winReason": self.win_reason,
            "maxPlayers": self.max_players,
            "mode": self.mode,
            "turnTimeout": self.turn_timeout,
            "secondsLeft": self.seconds_left(),
            "timerActive": self.timer_active(),
            "hotelUnlockRound": HOTEL_UNLOCK_ROUND,
            "timerStartRound": TIMER_START_ROUND,
            "constants": {
                "startSalary": GO_SALARY, "islandFine": ISLAND_FINE, "trapTurns": TRAP_TURNS,
                "flightFee": FLIGHT_FEE, "boostCost": BOOST_COST, "maxBoost": MAX_BOOST,
                "resortTiles": RESORT_TILES,
            },
            "board": [
                {
                    "index": i,
                    "name": t["name"],
                    "type": t["type"],
                    "price": t.get("price"),
                    "baseRent": t.get("base_rent"),
                    "group": t.get("group"),
                    "upgradeCost": t.get("upgrade_cost"),
                    "side": next(s for s, ts in enumerate(SIDES) if i in ts) + 1,
                    "ownerId": self.ownership.get(i),
                    "level": self.levels.get(i, 0),
                    "boost": self.boost.get(i, 0),
                    "rent": self.rent_for(i) if t["type"] == "property" else None,
                }
                for i, t in enumerate(BOARD)
            ],
            "players": [
                {
                    "id": p.id, "name": p.name, "color": p.color, "team": p.team,
                    "position": p.position, "money": p.money,
                    "netWorth": self.net_worth(p),
                    "inJail": p.in_jail, "bankrupt": p.bankrupt,
                    "hasRolled": p.has_rolled, "laps": p.laps,
                    "tourPending": p.tour_pending,
                    "customDice": p.custom_dice, "rerolls": p.rerolls,
                    "boostTokens": p.boost_tokens,
                    "properties": [i for i, o in self.ownership.items() if o == p.id],
                    "completedGroups": self.completed_groups(p.id),
                }
                for p in self.players
            ],
            "log": self.log[-30:],
        }


COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12"]


class GameManager:
    def __init__(self):
        self.games: Dict[str, Game] = {}

    def create(self, max_players: int = 4, turn_timeout: int = DEFAULT_TURN_TIMEOUT,
               mode: str = "ffa") -> Game:
        mode = "team" if mode == "team" else "ffa"
        if mode == "team":
            max_players = 4
        gid = uuid.uuid4().hex[:8]
        g = Game(id=gid, max_players=min(4, max(2, max_players)),
                 turn_timeout=max(0, turn_timeout), mode=mode)
        g.log_msg(f"Game {gid} created [{mode}]. Waiting for players (2-{g.max_players}).")
        self.games[gid] = g
        return g

    def get(self, gid: str) -> Optional[Game]:
        return self.games.get(gid)

    def join(self, g: Game, name: str, team: Optional[int] = None):
        if g.status != "waiting":
            raise ValueError("game already started")
        if len(g.players) >= g.max_players:
            raise ValueError("game is full")
        if g.mode == "ffa":
            team_id = len(g.players)
        else:
            counts = {0: 0, 1: 0}
            for p in g.players:
                if p.team in counts:
                    counts[p.team] += 1
            if team in (0, 1):
                if counts[team] >= 2:
                    raise ValueError(f"team {team + 1} is full")
                team_id = team
            else:
                team_id = 0 if counts[0] <= counts[1] else 1
        pid = uuid.uuid4().hex[:8]
        color = COLORS[len(g.players) % len(COLORS)]
        p = Player(id=pid, name=name[:16] or f"P{len(g.players) + 1}", color=color, team=team_id)
        g.players.append(p)
        extra = f" (team {team_id + 1})" if g.mode == "team" else ""
        g.log_msg(f"{p.name} joined{extra} ({len(g.players)}/{g.max_players}).")
        return p

    def start(self, g: Game):
        if g.status != "waiting":
            raise ValueError("already started")
        if len(g.players) < 2:
            raise ValueError("need at least 2 players")
        if g.mode == "team" and len(g.players) != 4:
            raise ValueError("team mode needs exactly 4 players (2v2)")
        g.status = "playing"
        g.current = 0
        g.round = 1
        g.start_turn_timer()
        g.log_msg(f"Game started! {g.current_player().name} goes first.")

    # ---------- dice / movement (server-evaluated) ----------
    def roll(self, g: Game, pid: str, dice: Optional[List[int]] = None):
        self._assert_turn(g, pid, need_fresh_roll=True)
        d1 = dice[0] if dice else random.randint(1, 6)
        d2 = dice[1] if dice else random.randint(1, 6)
        return self._do_roll(g, pid, d1, d2)

    def custom_roll(self, g: Game, pid: str, d1: int, d2: int):
        """Targeted roll using a customized die resource."""
        self._assert_turn(g, pid, need_fresh_roll=True)
        p = g.get_player(pid)
        if p.custom_dice <= 0:
            raise ValueError("no custom dice left")
        if not (1 <= d1 <= 6 and 1 <= d2 <= 6):
            raise ValueError("dice must be 1-6")
        p.custom_dice -= 1
        g.log_msg(f"{p.name} uses a custom die → [{d1}, {d2}] ({p.custom_dice} left).")
        return self._do_roll(g, pid, d1, d2)

    def reroll(self, g: Game, pid: str):
        """Spend a re-roll: undo this turn's roll, then roll fresh random dice."""
        if g.status != "playing":
            raise ValueError("game not in play")
        p = g.get_player(pid)
        if not p or p.bankrupt:
            raise ValueError("unknown/bankrupt player")
        if g.current_player().id != pid:
            raise ValueError("not your turn")
        if pid not in g._snapshots:
            raise ValueError("nothing to re-roll (roll first)")
        if p.rerolls <= 0:
            raise ValueError("no re-rolls left")
        if not g.restore(pid):
            raise ValueError("nothing to re-roll")
        p = g.get_player(pid)
        p.rerolls -= 1
        p.has_rolled = False
        g.log_msg(f"{p.name} re-rolls! ({p.rerolls} left).")
        return self._do_roll(g, pid, random.randint(1, 6), random.randint(1, 6))

    def _assert_turn(self, g: Game, pid: str, need_fresh_roll: bool):
        g.check_timeout()
        if g.status != "playing":
            raise ValueError("game not in play")
        p = g.get_player(pid)
        if not p or p.bankrupt:
            raise ValueError("unknown/bankrupt player")
        if g.current_player().id != pid:
            raise ValueError("not your turn")
        if need_fresh_roll and p.has_rolled and p.doubles_count == 0:
            raise ValueError("already rolled — buy/upgrade or end turn")

    def _do_roll(self, g: Game, pid: str, d1: int, d2: int):
        p = g.get_player(pid)
        g.snapshot(pid)
        g.last_dice = [d1, d2]
        is_double = d1 == d2
        old_pos = p.position
        events = [{"type": "dice", "dice": [d1, d2], "double": is_double}]

        if p.in_jail:  # Lost Island
            if is_double:
                p.in_jail = False
                p.jail_turns = 0
                events.append({"type": "jail_out", "reason": "doubles"})
                g.log_msg(f"{p.name} rolled doubles and escapes Lost Island.")
            else:
                p.jail_turns += 1
                if p.jail_turns >= TRAP_TURNS:
                    p.money -= ISLAND_FINE
                    p.in_jail = False
                    p.jail_turns = 0
                    events.append({"type": "jail_fine", "amount": ISLAND_FINE})
                    g.log_msg(f"{p.name} pays ${ISLAND_FINE} to escape Lost Island.")
                else:
                    events.append({"type": "jail_stay"})
                    g.log_msg(f"{p.name} is trapped on Lost Island ({p.jail_turns}/{TRAP_TURNS}).")
                    p.has_rolled = True
                    if p.money < 0:
                        self._bankrupt(g, p, events)
                    g.check_winner()
                    return {"dice": [d1, d2], "oldPos": old_pos, "newPos": p.position, "events": events}
        else:
            if is_double:
                p.doubles_count += 1
                if p.doubles_count >= 3:
                    p.position = ISLAND_INDEX
                    p.in_jail = True
                    p.has_rolled = True
                    p.doubles_count = 0
                    events.append({"type": "goto_jail", "reason": "3 doubles"})
                    g.log_msg(f"{p.name} rolled 3 doubles → Lost Island!")
                    g.check_winner()
                    return {"dice": [d1, d2], "oldPos": old_pos, "newPos": p.position, "events": events}
            else:
                p.doubles_count = 0

        steps = d1 + d2
        new_pos = (old_pos + steps) % BOARD_SIZE
        if (old_pos + steps) >= BOARD_SIZE:
            p.money += GO_SALARY
            p.laps += 1
            events.append({"type": "passed_go", "amount": GO_SALARY, "lap": p.laps})
            g.log_msg(f"{p.name} passes Start +${GO_SALARY} (lap {p.laps} — upgrades unlocked).")
        p.position = new_pos

        self._land(g, p, new_pos, BOARD[new_pos], events)
        if p.money < 0:
            self._bankrupt(g, p, events)

        p.has_rolled = True
        if is_double and not p.in_jail and p.money >= 0 and g.status == "playing":
            p.has_rolled = False
            events.append({"type": "extra_turn", "reason": "doubles"})
        g.check_winner()
        return {"dice": [d1, d2], "oldPos": old_pos, "newPos": new_pos, "events": events}

    def _land(self, g: Game, p: Player, idx: int, tile: dict, events: list, via_fly: bool = False):
        t = tile["type"]
        if t == "property":
            owner = g.ownership.get(idx)
            if owner is None:
                events.append({"type": "buy_offer", "tile": idx, "price": tile["price"]})
                g.log_msg(f"{p.name} landed on {tile['name']} (unowned, ${tile['price']}).")
            elif owner == p.id:
                events.append({"type": "own_property", "tile": idx})
                g.log_msg(f"{p.name} landed on own {tile['name']}.")
            else:
                op = g.get_player(owner)
                if g.mode == "team" and op and op.team == p.team:
                    events.append({"type": "team_safe", "tile": idx})
                    g.log_msg(f"{p.name} visits teammate {op.name}'s {tile['name']} (no rent).")
                else:
                    rent = g.rent_for(idx)
                    p.money -= rent
                    if op and not op.bankrupt:
                        op.money += rent
                    events.append({"type": "rent", "tile": idx, "amount": rent, "to": owner})
                    g.log_msg(f"{p.name} pays ${rent} rent to {op.name if op else '?'} "
                              f"({tile['name']} Lv{g.levels.get(idx, 0)} +{g.boost.get(idx, 0)}).")
        elif t == "tax_agency":
            amount = max(1, int(g.net_worth(p) * 0.10))
            p.money -= amount
            events.append({"type": "tax", "amount": amount})
            g.log_msg(f"{p.name} pays Tax Agency ${amount} (10% of net worth ${g.net_worth(p) + amount}).")
        elif t == "sender":
            p.position = ISLAND_INDEX
            p.in_jail = True
            p.jail_turns = 0
            events.append({"type": "goto_jail"})
            g.log_msg(f"{p.name} caught by the Storm → Lost Island!")
        elif t == "championship":
            p.boost_tokens += 1
            events.append({"type": "boost_token"})
            g.log_msg(f"{p.name} wins World Championship → +1 rent-boost token ({p.boost_tokens}).")
        elif t == "tour":
            if via_fly:
                events.append({"type": "safe", "tile": tile["name"]})
            elif p.tour_pending:
                events.append({"type": "safe", "tile": tile["name"]})
            else:
                p.money -= FLIGHT_FEE
                p.tour_pending = True
                events.append({"type": "tour", "fee": FLIGHT_FEE})
                g.log_msg(f"{p.name} pays ${FLIGHT_FEE} flight fee → World Tour armed (fly next turn).")
        elif t == "chance":
            text, amt = random.choice(CHANCE_CARDS)
            p.money += amt
            events.append({"type": "chance", "text": text, "amount": amt})
            g.log_msg(f"{p.name} draws Chance: {text} ({'+' if amt > 0 else ''}{amt}).")
        elif t == "go":
            events.append({"type": "go"})
        else:  # island (visit), others
            events.append({"type": "safe", "tile": tile["name"]})

    def _bankrupt(self, g: Game, p: Player, events: list):
        p.bankrupt = True
        for i, o in list(g.ownership.items()):
            if o == p.id:
                del g.ownership[i]
                g.levels.pop(i, None)
                g.boost.pop(i, None)
                g.upgrade_spent.pop(i, None)
        events.append({"type": "bankrupt"})
        g.log_msg(f"{p.name} is BANKRUPT and out of the game!")

    # ---------- economy actions ----------
    def buy(self, g: Game, pid: str):
        g.check_timeout()
        p = g.get_player(pid)
        if not p or g.current_player().id != pid or g.status != "playing":
            raise ValueError("not your turn")
        idx = p.position
        tile = BOARD[idx]
        if tile["type"] != "property":
            raise ValueError("nothing to buy here")
        if idx in g.ownership:
            raise ValueError("already owned")
        if p.money < tile["price"]:
            raise ValueError("not enough money")
        p.money -= tile["price"]
        g.ownership[idx] = pid
        g.levels[idx] = 0
        g._snapshots.pop(pid, None)  # economy action voids re-roll
        g.log_msg(f"{p.name} buys {tile['name']} for ${tile['price']}.")
        if p.money < 0:
            self._bankrupt(g, p, [])
        g.check_monopoly_win(pid)
        g.check_winner()
        return {"tile": idx}

    def upgrade(self, g: Game, pid: str, tile_idx: int):
        g.check_timeout()
        p = g.get_player(pid)
        if not p or g.current_player().id != pid or g.status != "playing":
            raise ValueError("not your turn")
        if g.ownership.get(tile_idx) != pid:
            raise ValueError("you don't own this property")
        if p.laps < 1:
            raise ValueError("complete a full lap (pass Start) to unlock upgrades")
        lvl = g.levels.get(tile_idx, 0)
        if lvl >= 4:
            raise ValueError("max level reached")
        if lvl + 1 == 4 and g.round < HOTEL_UNLOCK_ROUND:
            raise ValueError(f"Hotel (Lv4) unlocks at round {HOTEL_UNLOCK_ROUND} (now {g.round})")
        cost = BOARD[tile_idx]["upgrade_cost"] * (lvl + 1)
        if p.money < cost:
            raise ValueError("not enough money")
        p.money -= cost
        g.levels[tile_idx] = lvl + 1
        g.upgrade_spent[tile_idx] = g.upgrade_spent.get(tile_idx, 0) + cost
        g._snapshots.pop(pid, None)  # economy action voids re-roll
        label = "HOTEL" if lvl + 1 == 4 else f"house Lv{lvl + 1}"
        g.log_msg(f"{p.name} builds {label} on {BOARD[tile_idx]['name']} for ${cost}.")
        return {"tile": tile_idx, "level": lvl + 1, "cost": cost}

    def boost_rent(self, g: Game, pid: str, tile_idx: int):
        """World Championship effect: inflate rent of an owned city."""
        g.check_timeout()
        p = g.get_player(pid)
        if not p or g.current_player().id != pid or g.status != "playing":
            raise ValueError("not your turn")
        if g.ownership.get(tile_idx) != pid:
            raise ValueError("you don't own this property")
        cur = g.boost.get(tile_idx, 0)
        if cur >= MAX_BOOST:
            raise ValueError("max boost reached")
        if p.boost_tokens > 0:
            p.boost_tokens -= 1
            cost = 0
        else:
            if p.money < BOOST_COST:
                raise ValueError(f"need a boost token or ${BOOST_COST}")
            p.money -= BOOST_COST
            cost = BOOST_COST
        g.boost[tile_idx] = cur + 1
        g.upgrade_spent[tile_idx] = g.upgrade_spent.get(tile_idx, 0) + cost
        g._snapshots.pop(pid, None)  # economy action voids re-roll
        g.log_msg(f"{p.name} inflates rent on {BOARD[tile_idx]['name']} "
                  f"+{int(BOOST_MULT * 100)}% (x{g.boost[tile_idx]}) for ${cost}.")
        return {"tile": tile_idx, "boost": cur + 1, "cost": cost}

    def fly(self, g: Game, pid: str, destination: int):
        """World Tour: travel to almost any tile."""
        g.check_timeout()
        p = g.get_player(pid)
        if not p or g.current_player().id != pid or g.status != "playing":
            raise ValueError("not your turn")
        if not p.tour_pending:
            raise ValueError("no World Tour flight available (land on World Tour first)")
        if not (0 <= destination < BOARD_SIZE):
            raise ValueError("invalid destination")
        if destination == ISLAND_INDEX:
            raise ValueError("cannot fly to Lost Island")
        old = p.position
        p.tour_pending = False
        p.position = destination
        events = [{"type": "fly", "from": old, "to": destination}]
        g.log_msg(f"{p.name} flies {BOARD[old]['name']} → {BOARD[destination]['name']}.")
        if destination == 0:
            p.money += GO_SALARY
            events.append({"type": "passed_go", "amount": GO_SALARY, "lap": p.laps})
        self._land(g, p, destination, BOARD[destination], events, via_fly=True)
        if p.money < 0:
            self._bankrupt(g, p, events)
        p.has_rolled = True
        g.check_winner()
        return {"oldPos": old, "newPos": destination, "events": events}

    def bailout(self, g: Game, sender_id: str, recipient_id: str, amount: int):
        """2v2: bail out a partner with cash."""
        if g.status != "playing":
            raise ValueError("game not in play")
        if g.mode != "team":
            raise ValueError("bailouts are for team mode only")
        s = g.get_player(sender_id)
        r = g.get_player(recipient_id)
        if not s or not r or s.bankrupt or r.bankrupt:
            raise ValueError("unknown/bankrupt player")
        if s.team != r.team or sender_id == recipient_id:
            raise ValueError("can only bail out your partner")
        if amount <= 0:
            raise ValueError("amount must be positive")
        if s.money - amount < 0:
            raise ValueError("cannot bail out more than you own")
        s.money -= amount
        r.money += amount
        g._snapshots.pop(sender_id, None)
        g.log_msg(f"{s.name} bails out partner {r.name} with ${amount}.")
        return {"from": sender_id, "to": recipient_id, "amount": amount}

    def end_turn(self, g: Game, pid: str):
        if g.status != "playing":
            raise ValueError("game not in play")
        if g.current_player().id != pid:
            raise ValueError("not your turn")
        p = g.get_player(pid)
        if not p.has_rolled and not p.in_jail:
            raise ValueError("roll first")
        p.has_rolled = False
        p.doubles_count = 0
        g._advance_turn()
        return {}

    def pay_jail(self, g: Game, pid: str):
        p = g.get_player(pid)
        if not p or not p.in_jail or g.current_player().id != pid:
            raise ValueError("cannot pay Lost Island fee now")
        if p.money < ISLAND_FINE:
            raise ValueError("not enough money")
        p.money -= ISLAND_FINE
        p.in_jail = False
        p.jail_turns = 0
        g.log_msg(f"{p.name} pays ${ISLAND_FINE} to escape Lost Island.")
        return {}
