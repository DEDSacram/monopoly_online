// Frontend is dumb: throw dice / custom dice, server evaluates everything,
// returns {dice, oldPos, newPos, events} and we animate the 3D board.
import {
  initBoard3D, renderBoard3D, animateSteps3D, animateFly3D,
  showDice3D, resetView3D, onTileClick3D, resize3D,
} from './board3d.js';

let G = null, gameId = null, playerId = null, ws = null;
let boardReady = false;
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
  onTileClick3D((idx, state) => {
    const t = state.board[idx];
    const owner = state.players.find(p => p.id === t.ownerId);
    $("hint").textContent = `#${idx} ${t.name} [side ${t.side}, ${t.type}]` +
      (t.price ? ` · buy $${t.price}` : "") +
      (t.rent != null ? ` · rent $${t.rent}` : "") +
      (t.level ? (t.level === 4 ? " · 🏨 HOTEL" : ` · houses Lv${t.level}`) : "") +
      (t.boost ? ` · 🏆x${t.boost}` : "") +
      (owner ? ` · owned by ${owner.name}` : "");
    $("flyDest").value = idx; // click sets the World Tour target
  });
  boardReady = true;
  resize3D();
}

function seatOf(state, pid) {
  return Math.max(0, state.players.findIndex(p => p.id === pid));
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
$("btnRoll").onclick = async () => {
  try {
    $("dice").classList.add("shake");
    const r = await api("POST", `/api/games/${gameId}/roll`, {playerId});
    $("dice").classList.remove("shake");
    animateMove(r);
  } catch (e) { $("dice").classList.remove("shake"); $("hint").textContent = e.message; }
};
$("btnCustom").onclick = async () => {
  try {
    const r = await api("POST", `/api/games/${gameId}/custom-roll`, {playerId, d1: +$("cd1").value, d2: +$("cd2").value});
    animateMove(r);
  } catch (e) { $("hint").textContent = e.message; }
};
$("btnReroll").onclick = async () => {
  try { animateMove(await api("POST", `/api/games/${gameId}/reroll`, {playerId})); }
  catch (e) { $("hint").textContent = e.message; }
};
$("btnBuy").onclick = async () => { try { render((await api("POST", `/api/games/${gameId}/buy`, {playerId})).state); } catch (e) { $("hint").textContent = e.message; } };
$("btnEnd").onclick = async () => { try { render((await api("POST", `/api/games/${gameId}/end-turn`, {playerId})).state); } catch (e) { $("hint").textContent = e.message; } };
$("btnJail").onclick = async () => {
  try { render((await api("POST", `/api/games/${gameId}/pay-island`, {playerId})).state); }
  catch { try { render((await api("POST", `/api/games/${gameId}/pay-jail`, {playerId})).state); } catch (e) { $("hint").textContent = e.message; } }
};
$("btnFly").onclick = async () => { try { animateFly(await api("POST", `/api/games/${gameId}/fly`, {playerId, destination: +$("flyDest").value})); } catch (e) { $("hint").textContent = e.message; } };
$("btnBail").onclick = async () => {
  try {
    const me = G.players.find(p => p.id === playerId);
    const mate = G.players.find(p => p.team === me.team && p.id !== playerId && !p.bankrupt);
    if (!mate) throw new Error("no living partner");
    render((await api("POST", `/api/games/${gameId}/bailout`, {playerId, to: mate.id, amount: +$("bailAmt").value})).state);
  } catch (e) { $("hint").textContent = e.message; }
};
$("btnTimer").onclick = async () => { try { render((await api("POST", `/api/games/${gameId}/timer`, {turnTimeout: +$("timerSet").value})).state); } catch (e) { $("hint").textContent = e.message; } };
$("btnView").onclick = () => { if (boardReady) resetView3D(); };

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

async function animateMove(res) {
  const [d1, d2] = res.dice;
  $("dice").textContent = `${DICE_FACES[d1]} ${DICE_FACES[d2]} (${d1 + d2})`;
  // 3D dice toss + token hop along the travelled path
  const seat = seatOf(res.state, playerId);
  let pos = res.oldPos;
  const steps = (res.newPos - pos + N) % N || (res.events.some(e => e.type === "passed_go") ? N : 0);
  const path = [];
  for (let s = 0; s < steps; s++) { pos = (pos + 1) % N; path.push(pos); }
  await Promise.all([showDice3D(d1, d2), animateSteps3D(seat, path)]);
  $("hint").textContent = res.events.map(describe).join(" · ");
  render(res.state);
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
    const mine = state.board.filter(t => t.ownerId === playerId && t.type === "property");
    $("myprops").innerHTML = mine.length ? "" : "<i>none yet — land on a city and press Buy (upgrades need 1 lap)</i>";
    mine.forEach(t => {
      const next = t.level + 1;
      const lockedLap = me.laps < 1;
      const lockedHotel = next === 4 && state.round < state.hotelUnlockRound;
      const ub = document.createElement("button");
      ub.textContent = `${t.name} Lv${t.level} → ${next === 4 ? "🏨 HOTEL" : "Lv" + next} ($${t.upgradeCost * next})${lockedLap ? " 🔒lap" : ""}${lockedHotel ? " 🔒R" + state.hotelUnlockRound : ""}`;
      ub.disabled = t.level >= 4 || playerId !== state.currentPlayerId;
      ub.onclick = async () => { try { render((await api("POST", `/api/games/${gameId}/upgrade`, {playerId, tile: t.index})).state); } catch (e) { $("hint").textContent = e.message; } };
      const bb = document.createElement("button");
      bb.textContent = `🏆 Boost ${t.name} (x${t.boost}→x${t.boost + 1}, ${me.boostTokens > 0 ? "free token" : "$" + state.constants.boostCost})`;
      bb.disabled = t.boost >= state.constants.maxBoost || playerId !== state.currentPlayerId;
      bb.onclick = async () => { try { render((await api("POST", `/api/games/${gameId}/boost`, {playerId, tile: t.index})).state); } catch (e) { $("hint").textContent = e.message; } };
      $("myprops").appendChild(ub); $("myprops").appendChild(bb);
    });
  }
  $("log").innerHTML = state.log.slice().reverse().map(l => `<div>${l}</div>`).join("");
  const myTurn = playerId && state.currentPlayerId === playerId && state.status === "playing";
  const cur = state.players[state.current];
  $("btnRoll").disabled = !myTurn || (cur && cur.hasRolled);
  $("btnCustom").disabled = !myTurn || (cur && cur.hasRolled) || (me && me.customDice <= 0);
  $("btnReroll").disabled = !myTurn || (me && me.rerolls <= 0);
  $("btnBuy").disabled = !myTurn;
  $("btnEnd").disabled = !myTurn;
  $("btnFly").disabled = !myTurn || !(me && me.tourPending);
}

setInterval(async () => {
  if (!gameId) return;
  if (!ws || ws.readyState > 1) {
    try { render(await api("GET", `/api/games/${gameId}/state`)); } catch {}
  } else if (G && G.timerActive) {
    try { render(await api("GET", `/api/games/${gameId}/state`)); } catch {}
  }
}, 2000);
