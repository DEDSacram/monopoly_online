// Frontend is dumb: throw dice / custom dice, server evaluates everything,
// returns {dice, oldPos, newPos, events} and we animate the 3D board.
import {
  initBoard3D, renderBoard3D, animateSteps3D, animateFly3D,
  showDice3D, resetView3D, onTileClick3D, resize3D,
  updateHUD3D, onHUDClick3D, openDialog3D, openDicePick3D,
  setTargeting3D, isDialogOpen3D, setPanelsVisible3D,
} from './board3d.js';

let G = null, gameId = null, playerId = null, ws = null;
let boardReady = false;
let flyTargeting = false;
let panelsOn = true;

function togglePanels() {
  if (!boardReady) return;
  panelsOn = !panelsOn;
  setPanelsVisible3D(panelsOn);
  $("hint").textContent = panelsOn ? "floating panels on" : "floating panels off (clean board)";
  updateHUD3D(hudDefs());
}
document.addEventListener("keydown", e => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return; // don't hijack typing
  if ((e.key === "h" || e.key === "H") && boardReady) togglePanels();
});
const $ = id => document.getElementById(id);
const api = (m, u, b) => fetch(u, {method: m, headers: {"Content-Type": "application/json"}, body: b ? JSON.stringify(b) : undefined}).then(async r => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || "error");
  return j;
});
const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const N = 28; // board tiles

function ensureBoard() {
  if (boardReady) return;
  initBoard3D($("board"));
  onHUDClick3D(onHUD);
  onTileClick3D((idx, state) => {
    // fly-targeting mode: clicking a glowing tile IS the destination picker
    if (flyTargeting) { doFly(idx); return; }
    const t = state.board[idx];
    const me = state.players.find(p => p.id === playerId);
    const owner = state.players.find(p => p.id === t.ownerId);
    $("hint").textContent = `${t.name} (tile ${idx}, side ${t.side}, ${t.type})` +
      (t.price ? ` · buy $${t.price}` : "") +
      (t.rent != null ? ` · rent $${t.rent}` : "") +
      (t.level ? (t.level === 4 ? " · 🏨 HOTEL" : ` · houses Lv${t.level}`) : "") +
      (t.boost ? ` · 🏆x${t.boost}` : "") +
      (owner ? ` · owned by ${owner.name}` : "") +
      (t.index === 7 ? " · ✈️ no-fly zone" : "") +
      (me ? ` · 💸 YOU: ${landingCost(state, me, t)}` : "");
  });
  boardReady = true;
  resize3D();
}

function seatOf(state, pid) {
  return Math.max(0, state.players.findIndex(p => p.id === pid));
}

// What would *you* pay if you stepped on this tile right now?
function landingCost(state, me, t) {
  if (t.type === "property") {
    const owner = state.players.find(p => p.id === t.ownerId);
    if (!owner) return `for sale $${t.price}`;
    if (owner.id === me.id) return "yours — free";
    if (state.mode === "team" && owner.team === me.team) return `teammate ${owner.name} — free`;
    return `you'd pay $${t.rent} to ${owner.name}`;
  }
  if (t.type === "tax_agency") return `you'd pay ~$${Math.max(1, Math.floor(me.netWorth * 0.10))} (10% of your net)`;
  if (t.type === "tour") return me.tourPending ? "already armed — fly from here" : `you'd pay $${state.constants.flightFee} and arm a flight`;
  if (t.type === "sender") return "⚠️ Storm → trapped on Lost Island";
  if (t.type === "island") return me.inJail ? "you are trapped here" : "just visiting — safe";
  if (t.type === "championship") return "+1 rent-boost token";
  if (t.type === "chance") return "luck of the draw";
  if (t.type === "go") return `+$${state.constants.startSalary} + lap when passed`;
  return "safe";
}

$("btnCreate").onclick = async () => {
  try {
    const r = await api("POST", "/api/games", {maxPlayers: +$("maxPlayers").value, turnTimeout: +$("timeout").value, mode: $("mode").value});
    gameId = r.gameId; G = r.state;
    $("gameId").value = gameId;
    $("meInfo").textContent = `Game ${gameId} [${r.state.mode}] created — enter name & Join.`;
    render(G);
  } catch (e) { $("meInfo").textContent = e.message; }
};
$("btnJoin").onclick = async () => {
  try {
    gameId = $("gameId").value.trim(); const name = $("playerName").value.trim() || "Player";
    const team = $("team").value === "" ? null : +$("team").value;
    const r = await api("POST", `/api/games/${gameId}/join`, {name, team});
    playerId = r.playerId; G = r.state;
    $("meInfo").textContent = `You are ${name} (${playerId}). Game ${gameId}.`;
    $("game").classList.remove("hidden");
    connectWS(); render(G);
  } catch (e) { $("meInfo").textContent = e.message; }
};
$("btnStart").onclick = async () => { try { render((await api("POST", `/api/games/${gameId}/start`)).state); } catch (e) { $("hint").textContent = e.message; } };

// ---- game actions (driven from the 3D HUD) ----
async function doRoll() {
  $("dice").classList.add("shake");
  try {
    const r = await api("POST", `/api/games/${gameId}/roll`, {playerId});
    $("dice").classList.remove("shake");
    animateMove(r);
  } catch (e) { $("dice").classList.remove("shake"); $("hint").textContent = e.message; }
}
async function doFly(dest) {
  flyTargeting = false;
  setTargeting3D(false);
  try {
    animateFly(await api("POST", `/api/games/${gameId}/fly`, {playerId, destination: dest}));
  } catch (e) { $("hint").textContent = e.message; }
}
function toggleFlyTargeting() {
  const me = G.players.find(p => p.id === playerId);
  if (!me || !me.tourPending) { $("hint").textContent = "no World Tour flight available"; return; }
  flyTargeting = !flyTargeting;
  setTargeting3D(flyTargeting);
  $("hint").textContent = flyTargeting ? "✈️ click a glowing tile to fly there (Fly button cancels)" : "flight cancelled";
  if (boardReady) updateHUD3D(hudDefs());
}
async function onHUD(id) {
  try {
    const me = G.players.find(p => p.id === playerId);
    switch (id) {
      case "roll": await doRoll(); break;
      case "custom": {
        const pick = await openDicePick3D();
        if (pick) animateMove(await api("POST", `/api/games/${gameId}/custom-roll`, {playerId, d1: pick.d1, d2: pick.d2}));
        break;
      }
      case "reroll":
        animateMove(await api("POST", `/api/games/${gameId}/reroll`, {playerId}));
        break;
      case "buy": openBuyDialog3D(me.position); break;
      case "upgrade":
        render((await api("POST", `/api/games/${gameId}/upgrade`, {playerId, tile: me.position})).state);
        break;
      case "boost":
        render((await api("POST", `/api/games/${gameId}/boost`, {playerId, tile: me.position})).state);
        break;
      case "fly": toggleFlyTargeting(); break;
      case "island":
        render((await api("POST", `/api/games/${gameId}/pay-island`, {playerId})).state);
        break;
      case "bail": bailoutDialog3D(); break;
      case "end":
        render((await api("POST", `/api/games/${gameId}/end-turn`, {playerId})).state);
        break;
      case "view": resetView3D(); break;
      case "timer": timerDialog3D(); break;
      case "panels": togglePanels(); break;
    }
  } catch (e) { $("hint").textContent = e.message; }
}

// Contextual 3D HUD: only actions relevant right now.
function hudDefs() {
  const st = G;
  if (!st || !boardReady) return [];
  const me = st.players.find(p => p.id === playerId);
  if (!me) return [{id: "view", label: "📷"}, {id: "timer", label: "⏱"}];
  const d = [];
  const myTurn = playerId && st.currentPlayerId === playerId && st.status === "playing";
  if (myTurn) {
    const cur = st.players[st.current];
    if (!(cur && cur.hasRolled)) {
      d.push({id: "roll", label: "🎲 Throw"});
      d.push({id: "custom", label: `⚙️ ×${me.customDice}`, enabled: me.customDice > 0});
      d.push({id: "reroll", label: `↻ ×${me.rerolls}`, enabled: me.rerolls > 0});
    }
    const t = st.board[me.position];
    if (t.type === "property" && !t.ownerId) d.push({id: "buy", label: "Buy", sub: `$${t.price}`});
    if (t.ownerId === playerId) {
      if (t.level < 4) {
        const cost = t.upgradeCost * (t.level + 1);
        const r = me.laps < 1 ? "need 1 lap"
          : (t.level + 1 === 4 && st.round < st.hotelUnlockRound) ? `hotel R${st.hotelUnlockRound}`
          : (me.money < cost ? "no cash" : "");
        d.push({id: "upgrade", label: `⬆ ${t.level + 1 === 4 ? "HOTEL" : "Lv" + (t.level + 1)}`, sub: r || `$${cost}`, enabled: !r});
      }
      if (t.boost < st.constants.maxBoost) {
        const free = me.boostTokens > 0, c = st.constants.boostCost;
        d.push({id: "boost", label: `🏆 ×${t.boost + 1}`, sub: free ? "token" : `$${c}`, enabled: free || me.money >= c});
      }
    }
    if (me.tourPending) d.push({id: "fly", label: flyTargeting ? "✈️ Cancel" : "✈️ Fly"});
    if (me.inJail) d.push({id: "island", label: "🏝️ Free", sub: `$${st.constants.islandFine}`, enabled: me.money >= st.constants.islandFine});
    if (st.mode === "team") {
      const mate = st.players.find(p => p.team === me.team && p.id !== playerId && !p.bankrupt);
      if (mate) d.push({id: "bail", label: "💸 Bail", sub: mate.name.slice(0, 10)});
    }
    if (cur && cur.hasRolled) d.push({id: "end", label: "End ⏭"});
  }
  d.push({id: "timer", label: "⏱"});
  d.push({id: "panels", label: "👁", sub: panelsOn ? "panels on" : "panels off"});
  d.push({id: "view", label: "📷"});
  return d;
}
$("btnView").onclick = () => { if (boardReady) resetView3D(); };
$("btnPanel").onclick = () => {
  const side = $("side");
  side.classList.toggle("hidden");
  $("btnPanel").textContent = side.classList.contains("hidden") ? "▶ Show panel" : "◀ Hide panel";
  if (boardReady) setTimeout(resize3D, 30);
};
$("btnFull").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      // fullscreen the 3D viewport itself (falls back to the whole page)
      const wrap = $("boardWrap");
      if (wrap && wrap.requestFullscreen) await wrap.requestFullscreen();
      else await document.documentElement.requestFullscreen();
    }
  } catch (e) { $("hint").textContent = e.message; }
};
document.addEventListener("fullscreenchange", () => {
  $("btnFull").textContent = document.fullscreenElement ? "⛶ Exit fullscreen" : "⛶ Fullscreen";
});

function connectWS() {
  if (ws) ws.close();
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${gameId}/${playerId}`);
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.kind === "state") render(m.state, true); };
}

function describe(e) {
  switch (e.type) {
    case "dice": return `rolled ${e.dice[0]}+${e.dice[1]}${e.double ? " (doubles!)" : ""}`;
    case "passed_go": return `passed Start +$${e.amount} (lap ${e.lap})`;
    case "buy_offer": return `can BUY for $${e.price}`;
    case "rent": return `paid $${e.amount} rent`;
    case "team_safe": return `teammate's city — no rent`;
    case "tax": return `Tax Agency -$${e.amount} (10% net worth)`;
    case "chance": return `Chance: ${e.text} (${e.amount})`;
    case "tour": return `World Tour -$${e.fee} — fly available!`;
    case "fly": return `✈️ flew ${e.from} → ${e.to}`;
    case "boost_token": return `🏆 +1 rent-boost token`;
    case "goto_jail": return `→ Lost Island!`;
    case "jail_out": return `escaped Lost Island (doubles)`;
    case "jail_fine": return `escaped Lost Island -$${e.amount}`;
    case "jail_stay": return `trapped on Lost Island`;
    case "extra_turn": return "doubles → roll again!";
    case "bankrupt": return "BANKRUPT!";
    default: return e.type;
  }
}

const LEVEL_LABEL = ["Land only", "House Lv1", "Houses Lv2", "Houses Lv3", "🏨 HOTEL"];
function levelPlan(t, level) {
  let build = 0;
  for (let l = 1; l <= level; l++) build += t.upgradeCost * l;
  return {build, total: t.price + build};
}

// Buy dialog: single tap buys the city at the chosen level.
async function openBuyDialog3D(tileIdx, err = "") {
  while (true) {
    const st = G;
    const t = st.board[tileIdx];
    if (!t || t.type !== "property" || t.ownerId) return;
    const me = st.players.find(p => p.id === playerId);
    if (!me || st.currentPlayerId !== playerId || st.status !== "playing") return;
    const reason = lvl => {
      if (lvl >= 1 && me.laps < 1) return "needs 1 lap";
      if (lvl >= 4 && st.round < st.hotelUnlockRound) return `hotel at R${st.hotelUnlockRound}`;
      if (me.money < levelPlan(t, lvl).total) return "can't afford";
      return "";
    };
    const lines = [`price $${t.price} · rent $${t.rent} · you have $${me.money}`];
    if (err) lines.push("! " + err);
    const options = [0, 1, 2, 3, 4].map(lvl => {
      const r = reason(lvl);
      return {id: "lvl" + lvl, label: LEVEL_LABEL[lvl], sub: r || `$${levelPlan(t, lvl).total}`, disabled: !!r};
    });
    options.push({id: "skip", label: "Skip", accent: "#475569"});
    const id = await openDialog3D({title: `🏙️ ${t.name}`, lines, options});
    if (!id || id === "skip") return;
    try {
      render((await api("POST", `/api/games/${gameId}/buy-level`, {playerId, level: +id.slice(3)})).state);
      return;
    } catch (e) { err = e.message; }
  }
}

// Lost Island dialog: pay the fee now or sit out the trap turns.
async function islandDialog3D() {
  const st = G;
  const me = st.players.find(p => p.id === playerId);
  if (!me || !me.inJail || st.currentPlayerId !== playerId || st.status !== "playing") return;
  const fee = st.constants.islandFine;
  const id = await openDialog3D({
    title: "🏝️ Lost Island",
    lines: [`trapped — doubles escape, or pay $${fee} (you have $${me.money})`],
    options: [
      {id: "pay", label: `Pay $${fee}`, sub: "walk free", disabled: me.money < fee},
      {id: "stay", label: "Stay trapped", accent: "#475569"},
    ],
  });
  if (id === "pay") {
    try { render((await api("POST", `/api/games/${gameId}/pay-island`, {playerId})).state); }
    catch (e) { $("hint").textContent = e.message; }
  }
}

// Bailout dialog: fixed-amount options for the (single) living partner.
async function bailoutDialog3D() {
  const st = G;
  const me = st.players.find(p => p.id === playerId);
  const mate = me && st.players.find(p => p.team === me.team && p.id !== playerId && !p.bankrupt);
  if (!mate) { $("hint").textContent = "no living partner"; return; }
  const options = [50, 100, 250].map(a => ({
    id: "a" + a, label: `$${a} → ${mate.name.slice(0, 12)}`,
    sub: me.money - a < 0 ? "can't afford" : `leaves $${me.money - a}`, disabled: me.money - a < 0,
  }));
  options.push({id: "cancel", label: "Cancel", accent: "#475569"});
  const id = await openDialog3D({title: "💸 Bail out partner", lines: [`you $${me.money} · ${mate.name} $${mate.money}`], options});
  if (id && id !== "cancel") {
    try { render((await api("POST", `/api/games/${gameId}/bailout`, {playerId, to: mate.id, amount: +id.slice(1)})).state); }
    catch (e) { $("hint").textContent = e.message; }
  }
}

// Timer dialog: fixed presets instead of a number input.
async function timerDialog3D() {
  const cur = G.turnTimeout;
  const options = [0, 15, 30, 60].map(v => ({
    id: "t" + v, label: v === 0 ? "Timer off" : `${v}s`, sub: v === cur ? "current" : "",
  }));
  options.push({id: "cancel", label: "Cancel", accent: "#475569"});
  const id = await openDialog3D({title: "⏱ Turn timer", lines: ["auto-skips turns from round 3"], options});
  if (id && id !== "cancel") {
    try { render((await api("POST", `/api/games/${gameId}/timer`, {turnTimeout: +id.slice(1)})).state); }
    catch (e) { $("hint").textContent = e.message; }
  }
}

// Game-over dialog, once per finished game (winner or solo bankruptcy).
let gameOverShown = null;
async function maybeGameOverDialog3D(state) {
  if (state.status !== "finished") return;
  const key = `${state.id}|${state.winner || "none"}|${state.winReason}`;
  if (gameOverShown === key) return;
  gameOverShown = key;
  const champ = state.players.find(p => p.id === state.winner) || {};
  const reason = {resort_monopoly: "all 4 resorts", side_monopoly: "full board side", triple_monopoly: "triple monopoly", team_elimination: "rival team eliminated", bankruptcy: "last player standing"}[state.winReason] || state.winReason;
  const head = state.winner
    ? [`${champ.name || "?"} wins${state.mode === "team" && state.winningTeam != null ? ` · Team ${state.winningTeam + 1}` : ""}`, `by ${reason}`]
    : ["💀 Bankrupt — no winner", "solo run over"];
  await openDialog3D({title: "🏆 Game over", big: state.winner ? "🎉" : "💀", lines: head, options: [{id: "gg", label: "GG — close"}]});
}

async function animateMove(res) {
  const [d1, d2] = res.dice;
  $("dice").textContent = `${DICE_FACES[d1]} ${DICE_FACES[d2]} (${d1 + d2})`;
  // straight into the 3D dice toss + token hop — no gate dialog
  const seat = seatOf(res.state, playerId);
  let pos = res.oldPos;
  const steps = (res.newPos - pos + N) % N || (res.events.some(e => e.type === "passed_go") ? N : 0);
  const path = [];
  for (let s = 0; s < steps; s++) { pos = (pos + 1) % N; path.push(pos); }
  await Promise.all([showDice3D(d1, d2), animateSteps3D(seat, path)]);
  $("hint").textContent = res.events.map(describe).join(" · ");
  render(res.state);
  // landed on a buyable city -> offer buy-at-level dialog
  const offer = res.events.find(e => e.type === "buy_offer");
  if (offer && res.state.status === "playing" && res.state.currentPlayerId === playerId) {
    const tile = res.state.board[offer.tile];
    if (tile && !tile.ownerId) { openBuyDialog3D(offer.tile); return; }
  }
  // trapped on Lost Island -> pay-or-stay dialog
  if (res.events.some(e => e.type === "goto_jail" || e.type === "jail_stay")) islandDialog3D();
}

async function animateFly(res) {
  await animateFly3D(seatOf(G, playerId), res.oldPos, res.newPos);
  $("hint").textContent = res.events.map(describe).join(" · ");
  render(res.state);
}

function render(state, fromWS = false) {
  G = state;
  const me = state.players.find(p => p.id === playerId);
  const winName = state.winner ? (state.players.find(p => p.id === state.winner) || {}).name : null;
  $("status").textContent = `Game ${state.id} [${state.mode}] · ${state.status} · round ${state.round} · turn: ${(state.players[state.current] || {}).name || "-"}` +
    (state.winner ? ` · WINNER: ${winName}${state.winReason ? " (" + state.winReason + ")" : ""}` : "");
  $("timer").textContent = state.timerActive ? `⏱ ${state.secondsLeft.toFixed(0)}s left` : (state.turnTimeout === 0 ? "timer off (optional)" : `timer starts round ${state.timerStartRound}`);
    // 3D board (only once the game panel is visible so WebGL gets a real size)
  if (!$("game").classList.contains("hidden")) {
    ensureBoard();
    renderBoard3D(state);
  }
  $("players").innerHTML = state.players.map((p, i) =>
    `<div class="pcard" style="border-color:${p.color}"><b>${i === state.current ? "👉" : ""}${p.name}</b> ` +
    (state.mode === "team" ? `[T${p.team + 1}] ` : "") +
    `$${p.money} (net $${p.netWorth}) @${p.position} · laps ${p.laps}` +
    `${p.inJail ? " 🏝️ISLAND" : ""}${p.tourPending ? " ✈️FLY READY" : ""}` +
    `${p.bankrupt ? " 💀" : ""}${p.id === playerId ? " (you)" : ""}` +
    `<br>⚙️${p.customDice} ↻${p.rerolls} 🏆${p.boostTokens} · sets: ${p.completedGroups.join(",") || "-"}</div>`).join("");
  if (me) {
    // read-only holdings: upgrades/boosts run from the 3D HUD while standing on the city
    const mine = state.board.filter(t => t.ownerId === playerId && t.type === "property");
    $("myprops").innerHTML = mine.length
      ? mine.map(t => `<div>📍 ${t.name} (tile ${t.index}) — ` +
          (t.level === 4 ? "🏨 HOTEL" : t.level ? `houses Lv${t.level}` : "land") +
          (t.boost ? ` · 🏆×${t.boost}` : "") +
          ` · rent $${t.rent}${me.position === t.index ? " · <b>you are here</b>" : ""}</div>`).join("")
      : "<i>none yet — land on a city to buy (upgrades need 1 lap + standing on the city)</i>";
  }
  $("log").innerHTML = state.log.slice().reverse().map(l => `<div>${l}</div>`).join("");
  // fly targeting only makes sense on your own armed turn
  if (flyTargeting && !(me && me.tourPending && state.currentPlayerId === playerId && state.status === "playing")) {
    flyTargeting = false;
    setTargeting3D(false);
  }
  updateHUD3D(hudDefs());
  maybeGameOverDialog3D(state);
}

setInterval(async () => {
  if (!gameId) return;
  if (!ws || ws.readyState > 1) {
    try { render(await api("GET", `/api/games/${gameId}/state`)); } catch {}
  } else if (G && G.timerActive) {
    try { render(await api("GET", `/api/games/${gameId}/state`)); } catch {}
  }
}, 2000);
