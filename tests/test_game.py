import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from game import GameManager, RESORT_TILES, BOARD

def setup_game(n=2, timeout=0, mode="ffa"):
    m = GameManager()
    g = m.create(max_players=4 if mode == "team" else n, turn_timeout=timeout, mode=mode)
    if mode == "team":
        ps = [m.join(g, f"P{i}", team=i % 2) for i in range(4)]
    else:
        ps = [m.join(g, f"P{i}") for i in range(n)]
    m.start(g)
    return m, g, ps

# ---- legacy behavior (kept) ----
def test_dice_evaluated_server_side():
    m, g, ps = setup_game()
    r = m.roll(g, ps[0].id, dice=[3, 4])
    assert r["dice"] == [3, 4]
    assert r["newPos"] == 7  # Lost Island visit
    assert g.players[0].position == 7

def test_buy_and_rent():
    m, g, ps = setup_game()
    g.players[0].position = 1; g.players[0].has_rolled = True
    before = g.players[0].money
    m.buy(g, ps[0].id)
    assert g.ownership[1] == ps[0].id
    assert g.players[0].money == before - 60
    m.end_turn(g, ps[0].id)
    p0before = g.players[0].money
    p1before = g.players[1].money
    g.players[1].position = 26  # 26+3=29%28=1, passes Start
    r = m.roll(g, ps[1].id, dice=[1, 2])
    assert r["newPos"] == 1
    assert any(e["type"] == "rent" for e in r["events"])
    assert any(e["type"] == "passed_go" for e in r["events"])
    assert g.players[1].money == p1before + 200 - 6
    assert g.players[0].money == p0before + 6

def test_upgrade_needs_lap_then_hotel_locked():
    m, g, ps = setup_game()
    g.players[0].position = 1; g.players[0].has_rolled = True
    m.buy(g, ps[0].id)
    try:
        m.upgrade(g, ps[0].id, 1)
        assert False, "upgrade should require a lap"
    except ValueError as e:
        assert "lap" in str(e)
    g.players[0].laps = 1  # simulate completed lap
    for lvl in (1, 2, 3):
        assert m.upgrade(g, ps[0].id, 1)["level"] == lvl
    try:
        m.upgrade(g, ps[0].id, 1)
        assert False, "hotel should be locked before round 4"
    except ValueError as e:
        assert "Hotel" in str(e)
    g.round = 4
    assert m.upgrade(g, ps[0].id, 1)["level"] == 4

def test_four_players_and_win():
    m, g, ps = setup_game(n=4)
    for p in ps[:3]:
        p.money = -1
        m._bankrupt(g, p, [])
    g.check_winner()
    assert g.status == "finished" and g.winner == ps[3].id

def test_timer_optional():
    m, g, ps = setup_game(timeout=0)
    assert g.timer_active() is False
    g.turn_timeout = 30
    g.round = 3
    g.start_turn_timer()
    assert g.timer_active() is True
    assert g.seconds_left() is not None and g.seconds_left() > 0

# ---- new: laps ----
def test_passing_start_grants_lap_and_salary():
    m, g, ps = setup_game()
    g.players[0].position = 26
    before = g.players[0].money
    r = m.roll(g, ps[0].id, dice=[1, 1])  # 26+2=28%28=0 Start
    assert r["newPos"] == 0
    assert g.players[0].laps == 1
    assert g.players[0].money == before + 200

# ---- new: Lost Island ----
def test_lost_island_trap_and_fee():
    m, g, ps = setup_game()
    m.roll(g, ps[0].id, dice=[3, 4])  # lands 7 = Lost Island (visit -> safe)
    assert g.players[0].position == 7 and not g.players[0].in_jail
    # sender tile 20 -> trapped
    m.end_turn(g, ps[0].id)
    g.players[1].position = 18
    r = m.roll(g, ps[1].id, dice=[1, 1])  # 18+2=20 sender
    assert g.players[1].in_jail and g.players[1].position == 7
    before = g.players[1].money
    m.pay_jail(g, ps[1].id)
    assert not g.players[1].in_jail and g.players[1].money == before - 150

# ---- new: Tax Agency 10% ----
def test_tax_agency_ten_percent():
    m, g, ps = setup_game()
    g.players[0].position = 2  # 2+2=4 Tax Agency
    before_worth = g.net_worth(ps[0])
    r = m.roll(g, ps[0].id, dice=[1, 1])
    assert r["newPos"] == 4
    tax = next(e["amount"] for e in r["events"] if e["type"] == "tax")
    assert tax == max(1, int(before_worth * 0.10))

# ---- new: World Tour fly ----
def test_world_tour_then_fly():
    m, g, ps = setup_game()
    g.players[0].position = 7  # Lost Island (visit, not trapped)
    r = m.roll(g, ps[0].id, dice=[1, 2])  # 7+3=10 World Tour
    assert any(e["type"] == "tour" for e in r["events"])
    assert g.players[0].tour_pending
    m.end_turn(g, ps[0].id)
    # P1 does something neutral
    g.players[1].position = 0
    m.roll(g, ps[1].id, dice=[2, 3])
    m.end_turn(g, ps[1].id)
    res = m.fly(g, ps[0].id, 25)  # fly to Ivory Resort
    assert res["newPos"] == 25 and not g.players[0].tour_pending
    try:
        m.fly(g, ps[0].id, 7)
        assert False, "cannot fly to Lost Island"
    except ValueError:
        pass

# ---- new: World Championship boost ----
def test_championship_boost_inflates_rent():
    m, g, ps = setup_game()
    g.players[0].position = 10  # 10+2=12 championship
    m.roll(g, ps[0].id, dice=[1, 1])
    assert g.players[0].boost_tokens == 1
    # buy tile 1 then boost it with the free token
    g.players[0].position = 1; g.players[0].has_rolled = True
    m.buy(g, ps[0].id)
    base = g.rent_for(1)
    m.boost_rent(g, ps[0].id, 1)
    assert g.rent_for(1) == int(base * 1.5)

# ---- new: instant wins ----
def test_resort_monopoly_instant_win():
    m, g, ps = setup_game()
    for i in RESORT_TILES:
        g.ownership[i] = ps[0].id
        g.levels[i] = 0
    assert g.check_monopoly_win(ps[0].id)
    assert g.status == "finished" and g.win_reason == "resort_monopoly"

def test_side_monopoly_instant_win():
    m, g, ps = setup_game()
    for i in range(0, 7):
        if BOARD[i]["type"] == "property":
            g.ownership[i] = ps[1].id
    assert g.check_monopoly_win(ps[1].id)
    assert g.win_reason == "side_monopoly" and g.winner == ps[1].id

def test_triple_monopoly_instant_win():
    m, g, ps = setup_game()
    for i in (1, 3, 11, 13, 14, 16):  # brown + pink + orange
        g.ownership[i] = ps[0].id
    assert g.check_monopoly_win(ps[0].id)
    assert g.win_reason == "triple_monopoly"

# ---- new: team mode ----
def test_team_mode_rent_free_bailout_and_win():
    m, g, ps = setup_game(mode="team")  # P0,P2 team1; P1,P3 team2
    assert ps[0].team == 0 and ps[2].team == 0
    g.players[0].position = 1; g.players[0].has_rolled = True
    m.buy(g, ps[0].id)
    m.end_turn(g, ps[0].id)
    # teammate P2 (team 0) lands on tile 1 -> no rent (skip P1 first)
    g.players[1].position = 0
    m.roll(g, ps[1].id, dice=[2, 3])  # 0+5=5 unowned resort, no effect
    m.end_turn(g, ps[1].id)
    before = g.players[2].money
    g.players[2].position = 27  # 27+2=29%28=1
    r = m.roll(g, ps[2].id, dice=[1, 1])
    assert r["newPos"] == 1
    assert any(e["type"] == "team_safe" for e in r["events"])
    assert g.players[2].money == before + 200  # only GO salary, no rent
    # bailout
    m.bailout(g, ps[2].id, ps[0].id, 100)
    assert g.players[0].money >= 0
    # eliminate team 2 -> team 1 wins
    for p in (ps[1], ps[3]):
        p.money = -1
        m._bankrupt(g, p, [])
    g.check_winner()
    assert g.status == "finished" and g.winning_team == 0

def test_bailout_rejected_in_ffa():
    m, g, ps = setup_game()
    try:
        m.bailout(g, ps[0].id, ps[1].id, 50)
        assert False
    except ValueError as e:
        assert "team mode" in str(e)

# ---- new: custom dice + reroll ----
def test_custom_dice_targeted_roll():
    m, g, ps = setup_game()
    r = m.custom_roll(g, ps[0].id, 1, 2)  # 0+3=3 Portside (buyable)
    assert r["newPos"] == 3
    assert g.players[0].custom_dice == 1
    assert any(e["type"] == "buy_offer" for e in r["events"])

def test_reroll_restores_and_rolls_again():
    m, g, ps = setup_game()
    g.players[0].position = 5
    m.roll(g, ps[0].id, dice=[1, 1])
    n_rerolls = g.players[0].rerolls
    r = m.reroll(g, ps[0].id)
    assert g.players[0].rerolls == n_rerolls - 1
    assert "dice" in r and r["oldPos"] == 5

def test_reroll_void_after_buy():
    m, g, ps = setup_game()
    g.players[0].position = 0
    m.custom_roll(g, ps[0].id, 1, 2)  # -> tile 3
    g.players[0].position = 3; g.players[0].has_rolled = True
    m.buy(g, ps[0].id)
    try:
        m.reroll(g, ps[0].id)
        assert False, "re-roll must be void after buying"
    except ValueError:
        pass

def test_buy_to_level_atomic():
    m, g, ps = setup_game()
    g.players[0].laps = 1
    g.players[0].position = 3  # Portside $60, upgrade $50
    before = g.players[0].money
    r = m.buy_to_level(g, ps[0].id, 2)  # 60 + 50 + 100
    assert r == {"tile": 3, "level": 2, "cost": 210}
    assert g.players[0].money == before - 210
    assert g.ownership[3] == ps[0].id and g.levels[3] == 2
    assert g.upgrade_spent[3] == 150

def test_buy_to_level_guards():
    m, g, ps = setup_game()
    g.players[0].position = 3
    try:
        m.buy_to_level(g, ps[0].id, 1)
        assert False, "levels need a lap"
    except ValueError as e:
        assert "lap" in str(e)
    g.players[0].laps = 1
    try:
        m.buy_to_level(g, ps[0].id, 4)
        assert False, "hotel locked before round 4"
    except ValueError as e:
        assert "Hotel" in str(e)
    g.round = 4
    g.players[0].money = 100
    try:
        m.buy_to_level(g, ps[0].id, 2)
        assert False, "must be atomic on insufficient funds"
    except ValueError as e:
        assert "need $" in str(e)
    assert 3 not in g.ownership and g.players[0].money == 100

def test_upgrade_requires_standing_on_city():
    m, g, ps = setup_game()
    g.players[0].laps = 1
    g.players[0].position = 1; g.players[0].has_rolled = True
    m.buy(g, ps[0].id)
    g.players[0].position = 5  # walk away
    try:
        m.upgrade(g, ps[0].id, 1)
        assert False, "must stand on the city to upgrade"
    except ValueError as e:
        assert "stand on" in str(e)
    g.players[0].position = 1  # step back on it
    assert m.upgrade(g, ps[0].id, 1)["level"] == 1

def test_boost_requires_standing_on_city():
    m, g, ps = setup_game()
    g.players[0].position = 1; g.players[0].has_rolled = True
    m.buy(g, ps[0].id)
    g.players[0].boost_tokens = 1
    g.players[0].position = 5  # walk away
    try:
        m.boost_rent(g, ps[0].id, 1)
        assert False, "must stand on the city to boost"
    except ValueError as e:
        assert "stand on" in str(e)
    g.players[0].position = 1
    assert m.boost_rent(g, ps[0].id, 1)["boost"] == 1

def setup_solo(timeout=0):
    m = GameManager()
    g = m.create(max_players=1, turn_timeout=timeout)
    p = m.join(g, "Solo")
    m.start(g)
    return m, g, p

def test_solo_start_roll_buy():
    m, g, p = setup_solo()
    assert g.status == "playing" and g.max_players == 1
    r = m.roll(g, p.id, dice=[1, 2])  # -> tile 3 Portside
    assert r["newPos"] == 3
    m.buy(g, p.id)
    assert g.ownership[3] == p.id
    assert g.status == "playing"  # last-player rule must not end a solo run

def test_solo_instant_win():
    m, g, p = setup_solo()
    for i in RESORT_TILES:
        g.ownership[i] = p.id
    assert g.check_monopoly_win(p.id)
    assert g.status == "finished" and g.winner == p.id
    assert g.win_reason == "resort_monopoly"

def test_solo_bankruptcy_ends_winnerless():
    m, g, p = setup_solo()
    p.money = -1
    m._bankrupt(g, p, [])
    g.check_winner()
    assert g.status == "finished" and g.winner is None
