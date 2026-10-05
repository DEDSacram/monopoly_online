// Game controller: talks to the server and drives the scene. There is no HTML
// UI in-game — the board, the table, the characters and every panel are drawn in
// one WebGL canvas by board3d.js + ui3d.js.
import {
  initBoard3D, renderBoard3D, animateSteps3D, animateFly3D, showDice3D,
  resetView3D, onTileClick3D, onSeatClick3D, resize3D, setTargeting3D,
  setPlatesVisible3D, getRenderer3D, getCamera3D, attachUI, setCameraMode3D,
  getCameraMode3D, cycleViewSeat3D, watchSeat3D, getViewSeat3D, celebrate3D,
  setViewSeat3D, debugState3D, getSceneObject3D, getChars3D, tileScreenPos3D,
  charScreenPos3D, getCameraPos3D, projectToScreen3D,
} from './board3d.js';
import {
  attachUI3D, layoutUI3D, setMyPlayerId3D, isDialogOpen3D, openDialog3D,
  openDicePick3D, onHUDClick3D, onLobbyClick3D, setHUD3D, setRoster3D, setTop3D,
  setLog3D, toggleLog3D, showLobby3D, getLobbyField3D, setLobbyField3D,
  getLobbyName3D, appendLobbyName3D, backspaceLobbyName3D, setLobbyGameId3D,
  getLobbyGameId3D, getLobbySettings3D, setLobbyMessage3D, toast3D, stepUI3D,
  routeClick3D, routeHover3D, showSum3D, toggleLobbyRules3D, isLobbyVisible3D,
  findUIButton, getDialogOptions, clickDialogOption, getLogState3D,
  liveTextureCount3D, liveGeometryCount3D, getLastToast3D, getLobbyState3D,
  showWaiting3D, setWaitingInfo3D, isWaitingVisible3D, routeAt3D, uiCounts3D,
  layoutAudit3D,
} from './ui3d.js';

let G = null, gameId = null, playerId = null, ws = null;
let boardReady = false;
let flyTargeting = false;
// tile name plates start off: the printed tile tops are the readable surface,
// and the plates only help from the far freecam
let platesOn = false;
let camMode = 'free';
let logOpen = false;
let gameOverShown = null;

const $ = id => document.getElementById(id);
const api = (m, u, b) => fetch(u, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b ? JSON.stringify(b) : undefined,
}).then(async r => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || 'error');
  return j;
});
const N = 28;
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------------- boot ----------------
function ensureBoard() {
  if (boardReady) return;
  initBoard3D($('board'));
  attachUI3D(getRenderer3D(), getCamera3D());
  // hand ui3d a small bridge so the scene can ask the UI questions
  attachUI({
  // the bridge is a snapshot object, so expose the id through a getter so
  // board3d always sees the current value
  get myPlayerId() { return playerId; },
  isDialogOpen: () => isDialogOpen3D(),
    showSum: (sum, dbl) => showSum3D(sum, dbl),
    step: now => stepUI3D(now),
    onResize: () => layoutUI3D(),
    routeClick: e => routeClick3D(e),
    routeHover: e => routeHover3D(e),
  });
  onHUDClick3D(onHUD);
  onLobbyClick3D(onLobby);

  onTileClick3D((idx, state) => {
    if (flyTargeting) { doFly(idx); return; }
    const t = state.board[idx];
    const me = state.players.find(p => p.id === playerId);
    const owner = state.players.find(p => p.id === t.ownerId);
    const bits = [
      `tile ${idx} · side ${t.side}`,
      t.type === 'property' ? `buy $${t.price}` : (t.type === 'go' ? 'start' : t.type),
      t.rent != null ? `rent $${t.rent}` : '',
      t.level ? (t.level === 4 ? 'HOTEL' : `houses Lv${t.level}`) : '',
      t.boost ? `boost x${t.boost}` : '',
      owner ? `owned by ${owner.name}` : '',
      t.index === 7 ? 'no-fly zone' : '',
      me ? `you: ${landingCost(state, me, t)}` : '',
    ].filter(Boolean);
    toast3D(`${t.name} — ${bits.join(' · ')}`, 4600);
  });

  onSeatClick3D(seat => {
    watchSeat3D(seat);
    toast3D(`${seatName(seat)} — camera moved`, 1800);
    refreshHUD();
  });

  boardReady = true;
  resize3D();
}

function seatName(seat) {
  const p = G && G.players[seat];
  return p ? p.name : `character ${seat + 1}`;
}

// What would *you* pay landing on this tile right now?
function landingCost(state, me, t) {
  if (t.type === 'property') {
    const owner = state.players.find(p => p.id === t.ownerId);
    if (!owner) return `for sale $${t.price}`;
    if (owner.id === me.id) return 'yours — free';
    if (state.mode === 'team' && owner.team === me.team) return `teammate ${owner.name} — free`;
    return `you'd pay $${t.rent} to ${owner.name}`;
  }
  if (t.type === 'tax_agency') return `~$${Math.max(1, Math.floor(me.netWorth * 0.10))} (10% of net)`;
  if (t.type === 'tour') return me.tourPending ? 'already armed' : `$${state.constants.flightFee} + flight`;
  if (t.type === 'sender') return 'storm → Lost Island';
  if (t.type === 'island') return me.inJail ? 'you are trapped' : 'safe visit';
  if (t.type === 'championship') return '+1 rent-boost token';
  if (t.type === 'chance') return 'luck of the draw';
  if (t.type === 'go') return `+$${state.constants.startSalary} + a lap`;
  return 'safe';
}

// ---------------- lobby (a 3D screen, driven by clicks + typing) ----------
async function onLobby(id) {
  try {
    const cfg = getLobbySettings3D();
    switch (id) {
      case 'name': setLobbyField3D('name'); break;
      case 'gameid': setLobbyField3D('gameid'); break;
      case 'mode-ffa': setLobbyMessage3D('free for all — everyone for themselves', { mode: 'ffa' }); break;
      case 'mode-team': setLobbyMessage3D('2v2 teams — four players required', { mode: 'team', max: 4 }); break;
      case 'max-1': case 'max-2': case 'max-3': case 'max-4': {
        const n = +id.slice(4);
        setLobbyMessage3D(n === 1 ? 'solo practice run' : `up to ${n} players`, { max: n });
        break;
      }
      case 'timer': {
        const opts = [0, 15, 30, 60];
        const next = opts[(opts.indexOf(cfg.timer) + 1) % opts.length];
        setLobbyMessage3D(next ? `turn timer ${next}s` : 'turn timer off', { timer: next });
        break;
      }
      case 'create': await doCreate(); break;
      case 'join': await doJoin(); break;
      case 'start': await doStart(); break;
      case 'spectate': await doSpectate(); break;
      case 'back': showLobby3D(true); render(G); break;
    }
  } catch (e) { setLobbyMessage3D(e.message); }
}

async function doCreate() {
  const cfg = getLobbySettings3D();
  const r = await api('POST', '/api/games', { maxPlayers: cfg.max, turnTimeout: cfg.timer, mode: cfg.mode });
  gameId = r.gameId;
  G = r.state;
  setLobbyGameId3D(gameId);
  setLobbyMessage3D(`game ${gameId} dealt — type your name, then JOIN`, {
    players: G.players, status: G.status, message: `game ${gameId} dealt — type your name, then JOIN`,
  });
}

async function doJoin() {
  const cfg = getLobbySettings3D();
  const gid = getLobbyGameId3D();
  if (!gid) { setLobbyMessage3D('deal a new game first, or paste a game id'); return; }
  const name = (getLobbyName3D() || '').trim() || `Player${cfg.seat + 1}`;
  const r = await api('POST', `/api/games/${gid}/join`, { name });
  playerId = r.playerId;
  G = r.state;
  setMyPlayerId3D(playerId);
  gameId = gid;
  ensureBoard();
  connectWS();
  render(G);
  // sit straight down at the table, looking through your own character
  const seat = seatOf(G, playerId);
  setViewSeat3D(seat);
  showLobby3D(false);
  setCameraMode3D('seat');
  camMode = 'seat';
  render(G);
  toast3D(`you are ${name} — wait for the others, then START`, 4000);
}

async function doStart() {
  if (!gameId) { setLobbyMessage3D('no game to start'); return; }
  try {
    const r = await api('POST', `/api/games/${gameId}/start`);
    G = r.state;
    setWaitingInfo3D('');
    render(G);
    celebrate3D(seatOf(G, playerId) >= 0 ? seatOf(G, playerId) : 0);
    toast3D('the game is on — good luck', 3200);
  } catch (e) {
    setWaitingInfo3D(e.message);
    render(G);
    toast3D(e.message, 3200);
  }
}

async function doSpectate() {
  const gid = getLobbyGameId3D();
  if (!gid) { setLobbyMessage3D('no game id to watch'); return; }
  gameId = gid;
  G = await api('GET', `/api/games/${gid}/state`);
  ensureBoard();
  showLobby3D(false);
  connectWS();
  render(G);
  toast3D(`watching ${gid}`, 2600);
}

// ---------------- keyboard ----------------
window.addEventListener('keydown', e => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (isLobbyVisible3D()) return lobbyKey(e);
  if (e.key === ' ') e.preventDefault();
  const k = e.key.toLowerCase();
  switch (k) {
    case 'l': logOpen = toggleLog3D(); refreshHUD(); break;
    case 'h':
      platesOn = !platesOn;
      setPlatesVisible3D(platesOn);
      toast3D(platesOn ? 'full tile labels on' : 'tile labels off — reading the tiles', 1800);
      refreshHUD(); break;
    case 'c': toggleCam(); break;
    case '1': case '2': case '3': case '4': goSeat(+k - 1); break;
    case 'tab':
      e.preventDefault();
      goSeat((getViewSeat3D() + 1) % 4);
      break;
    case 'v': resetView3D(); break;
    case 'f': toggleFullscreen(); break;
    case 'r': if (e.shiftKey) resetView3D(); break;
    case ' ':
      if (!isDialogOpen3D() && playerId && G && G.currentPlayerId === playerId && G.status === 'playing') onHUD('roll');
      break;
  }
});

function lobbyKey(e) {
  const field = getLobbyField3D();
  if (field === 'name') {
    if (e.key === 'Backspace') { backspaceLobbyName3D(); e.preventDefault(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== ' ') { appendLobbyName3D(e.key); e.preventDefault(); return; }
  } else if (field === 'gameid') {
    if (e.key === 'Backspace') { setLobbyGameId3D(getLobbyGameId3D().slice(0, -1)); e.preventDefault(); return; }
    if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) { setLobbyGameId3D(getLobbyGameId3D() + e.key); e.preventDefault(); return; }
  }
  switch (e.key) {
    case 'Escape': setLobbyField3D(''); break;
    case 'Tab': setLobbyField3D(field === 'name' ? 'gameid' : 'name'); e.preventDefault(); break;
    case '?': toggleLobbyRules3D(); break;
    case 'Enter':
      e.preventDefault();
      if (gameId && playerId && G && G.status === 'waiting') onLobby('start');
      else if (gameId) onLobby('join');
      else onLobby('create');
      break;
  }
}

function toggleCam() {
  camMode = camMode === 'free' ? 'seat' : 'free';
  setCameraMode3D(camMode);
  toast3D(camMode === 'seat' ? `riding ${seatName(getViewSeat3D())}` : 'freecam — drag to orbit', 1800);
  refreshHUD();
}

function goSeat(seat) {
  watchSeat3D(seat);
  if (camMode === 'seat') setViewSeat3D(seat);
  toast3D(`watching ${seatName(seat)}`, 1800);
  refreshHUD();
}

function toggleFullscreen() {
  const el = $('boardWrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el && el.requestFullscreen) el.requestFullscreen();
  else document.documentElement.requestFullscreen();
}

// ---------------- game actions (from the 3D HUD) ----------------
// One action at a time: the dice toss, the token walk and any dialog it opens
// are a single animated beat, so a second click has to wait its turn.
let busy = false;
async function withBusy(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } finally { busy = false; }
}

async function doRoll() {
  await withBusy(async () => {
    try { await animateMove(await api('POST', `/api/games/${gameId}/roll`, { playerId })); }
    catch (e) { toast3D(e.message); }
  });
}
async function doFly(dest) {
  flyTargeting = false;
  setTargeting3D(false);
  await withBusy(async () => {
    try { await animateFly(await api('POST', `/api/games/${gameId}/fly`, { playerId, destination: dest })); }
    catch (e) { toast3D(e.message); }
  });
}
function toggleFlyTargeting() {
  const me = G.players.find(p => p.id === playerId);
  if (!me || !me.tourPending) { toast3D('no World Tour flight available'); return; }
  flyTargeting = !flyTargeting;
  setTargeting3D(flyTargeting);
  toast3D(flyTargeting ? 'click a glowing tile to fly there' : 'flight cancelled', 3200);
  refreshHUD();
}

async function onHUD(id) {
  try {
    const me = G && G.players.find(p => p.id === playerId);
    switch (id) {
      case 'roll': await doRoll(); break;
      case 'custom': {
        const pick = await openDicePick3D();
        if (pick) animateMove(await api('POST', `/api/games/${gameId}/custom-roll`, { playerId, d1: pick.d1, d2: pick.d2 }));
        break;
      }
      case 'reroll': animateMove(await api('POST', `/api/games/${gameId}/reroll`, { playerId })); break;
      case 'buy': openBuyDialog3D(me.position); break;
      case 'upgrade': render((await api('POST', `/api/games/${gameId}/upgrade`, { playerId, tile: me.position })).state); break;
      case 'boost': render((await api('POST', `/api/games/${gameId}/boost`, { playerId, tile: me.position })).state); break;
      case 'fly': toggleFlyTargeting(); break;
      case 'island': render((await api('POST', `/api/games/${gameId}/pay-island`, { playerId })).state); break;
      case 'bail': bailoutDialog3D(); break;
      case 'end': render((await api('POST', `/api/games/${gameId}/end-turn`, { playerId })).state); break;
      case 'view': resetView3D(); break;
      case 'timer': timerDialog3D(); break;
      case 'start': await doStart(); break;
      case 'back': showLobby3D(true); render(G); break;
      case 'labels': platesOn = !platesOn; setPlatesVisible3D(platesOn); refreshHUD(); break;
      case 'cam': toggleCam(); break;
      case 'seat': goSeat((getViewSeat3D() + 1) % 4); break;
      case 'log': logOpen = toggleLog3D(); refreshHUD(); break;
    }
  } catch (e) { toast3D(e.message); }
}

// Contextual HUD: only the actions that matter right now.
function hudDefs() {
  const st = G;
  if (!st || !boardReady) return [];
  const me = st.players.find(p => p.id === playerId);
  const d = [];
  if (me && st.currentPlayerId === playerId && st.status === 'playing') {
    const cur = st.players[st.current];
    if (!(cur && cur.hasRolled)) {
      d.push({ id: 'roll', label: '🎲 THROW' });
      d.push({ id: 'custom', label: `⚙️ ×${me.customDice}`, enabled: me.customDice > 0 });
      d.push({ id: 'reroll', label: `↻ ×${me.rerolls}`, enabled: me.rerolls > 0 });
    }
    const t = st.board[me.position];
    if (t.type === 'property' && !t.ownerId) d.push({ id: 'buy', label: 'BUY', sub: `$${t.price}` });
    if (t.ownerId === playerId) {
      if (t.level < 4) {
        const cost = t.upgradeCost * (t.level + 1);
        const reason = me.laps < 1 ? 'need 1 lap'
          : (t.level + 1 === 4 && st.round < st.hotelUnlockRound) ? `hotel R${st.hotelUnlockRound}`
          : (me.money < cost ? 'no cash' : '');
        d.push({ id: 'upgrade', label: t.level + 1 === 4 ? '⬆ HOTEL' : `⬆ Lv${t.level + 1}`, sub: reason || `$${cost}`, enabled: !reason });
      }
      if (t.boost < st.constants.maxBoost) {
        const free = me.boostTokens > 0, c = st.constants.boostCost;
        d.push({ id: 'boost', label: `🏆 ×${t.boost + 1}`, sub: free ? 'token' : `$${c}`, enabled: free || me.money >= c });
      }
    }
    if (me.tourPending) d.push({ id: 'fly', label: flyTargeting ? '✈️ CANCEL' : '✈️ FLY' });
    if (me.inJail) d.push({ id: 'island', label: '🏝️ FREE', sub: `$${st.constants.islandFine}`, enabled: me.money >= st.constants.islandFine });
    if (st.mode === 'team') {
      const mate = st.players.find(p => p.team === me.team && p.id !== playerId && !p.bankrupt);
      if (mate) d.push({ id: 'bail', label: '💸 BAIL', sub: mate.name.slice(0, 10) });
    }
    if (cur && cur.hasRolled) d.push({ id: 'end', label: 'END TURN' });
  }
  d.push({ id: 'cam', label: camMode === 'seat' ? '🎥 RIDING' : '🎥 FREE', sub: camMode === 'seat' ? seatName(getViewSeat3D()) : 'orbit' });
  d.push({ id: 'seat', label: '🔀 SEAT', sub: seatName(getViewSeat3D()) });
  d.push({ id: 'log', label: '📜 LOG', sub: logOpen ? 'hide' : 'show' });
  d.push({ id: 'labels', label: platesOn ? '🏷 FULL' : '🏷 TILES', sub: 'labels' });
  d.push({ id: 'view', label: '📷 VIEW' });
  d.push({ id: 'timer', label: '⏱' });
  return d;
}
function refreshHUD() { if (boardReady) setHUD3D(hudDefs()); }

// ---------------- dialogs ----------------
const LEVEL_LABEL = ['Land only', 'House Lv1', 'Houses Lv2', 'Houses Lv3', '🏨 HOTEL'];
function levelPlan(t, level) {
  let build = 0;
  for (let l = 1; l <= level; l++) build += t.upgradeCost * l;
  return { build, total: t.price + build };
}

async function openBuyDialog3D(tileIdx, err = '') {
  while (true) {
    const st = G;
    const t = st.board[tileIdx];
    if (!t || t.type !== 'property' || t.ownerId) return;
    const me = st.players.find(p => p.id === playerId);
    if (!me || st.currentPlayerId !== playerId || st.status !== 'playing') return;
    const reason = lvl => {
      if (lvl >= 1 && me.laps < 1) return 'needs 1 lap';
      if (lvl >= 4 && st.round < st.hotelUnlockRound) return `hotel at R${st.hotelUnlockRound}`;
      if (me.money < levelPlan(t, lvl).total) return "can't afford";
      return '';
    };
    const lines = [`price $${t.price} · rent $${t.rent} · you have $${me.money}`];
    if (err) lines.push({ text: '! ' + err, color: '#f87171' });
    const options = [0, 1, 2, 3, 4].map(lvl => {
      const r = reason(lvl);
      return { id: 'lvl' + lvl, label: LEVEL_LABEL[lvl], sub: r || `$${levelPlan(t, lvl).total}`, disabled: !!r };
    });
    options.push({ id: 'skip', label: 'Skip', accent: '#475569' });
    const id = await openDialog3D({ title: `🏙️ ${t.name}`, lines, options });
    if (!id || id === 'skip') return;
    try {
      render((await api('POST', `/api/games/${gameId}/buy-level`, { playerId, level: +id.slice(3) })).state);
      return;
    } catch (e) { err = e.message; }
  }
}

async function islandDialog3D() {
  const st = G;
  const me = st.players.find(p => p.id === playerId);
  if (!me || !me.inJail || st.currentPlayerId !== playerId || st.status !== 'playing') return;
  const fee = st.constants.islandFine;
  const id = await openDialog3D({
    title: '🏝️ Lost Island',
    lines: [`trapped — doubles escape, or pay $${fee} (you have $${me.money})`],
    options: [
      { id: 'pay', label: `Pay $${fee}`, sub: 'walk free', disabled: me.money < fee },
      { id: 'stay', label: 'Stay trapped', accent: '#475569' },
    ],
  });
  if (id === 'pay') {
    try { render((await api('POST', `/api/games/${gameId}/pay-island`, { playerId })).state); }
    catch (e) { toast3D(e.message); }
  }
}

async function bailoutDialog3D() {
  const st = G;
  const me = st.players.find(p => p.id === playerId);
  const mate = me && st.players.find(p => p.team === me.team && p.id !== playerId && !p.bankrupt);
  if (!mate) { toast3D('no living partner'); return; }
  const options = [50, 100, 250].map(a => ({
    id: 'a' + a, label: `$${a} → ${mate.name.slice(0, 12)}`,
    sub: me.money - a < 0 ? "can't afford" : `leaves $${me.money - a}`, disabled: me.money - a < 0,
  }));
  options.push({ id: 'cancel', label: 'Cancel', accent: '#475569' });
  const id = await openDialog3D({ title: '💸 Bail out partner', lines: [`you $${me.money} · ${mate.name} $${mate.money}`], options });
  if (id && id !== 'cancel') {
    try { render((await api('POST', `/api/games/${gameId}/bailout`, { playerId, to: mate.id, amount: +id.slice(1) })).state); }
    catch (e) { toast3D(e.message); }
  }
}

async function timerDialog3D() {
  const cur = G.turnTimeout;
  const options = [0, 15, 30, 60].map(v => ({
    id: 't' + v, label: v === 0 ? 'Timer off' : `${v}s`, sub: v === cur ? 'current' : '',
  }));
  options.push({ id: 'cancel', label: 'Cancel', accent: '#475569' });
  const id = await openDialog3D({ title: '⏱ Turn timer', lines: ['auto-skips turns from round 3'], options });
  if (id && id !== 'cancel') {
    try { render((await api('POST', `/api/games/${gameId}/timer`, { turnTimeout: +id.slice(1) })).state); }
    catch (e) { toast3D(e.message); }
  }
}

async function maybeGameOver(state) {
  if (state.status !== 'finished') return;
  const key = `${state.id}|${state.winner || 'none'}|${state.winReason}`;
  if (gameOverShown === key) return;
  gameOverShown = key;
  const champ = state.players.find(p => p.id === state.winner);
  const reason = {
    resort_monopoly: 'all 4 resorts', side_monopoly: 'full board side',
    triple_monopoly: 'triple monopoly', team_elimination: 'rival team eliminated',
    bankruptcy: 'last player standing',
  }[state.winReason] || state.winReason;
  const head = state.winner
    ? [`${champ ? champ.name : '?'} wins${state.mode === 'team' && state.winningTeam != null ? ` · Team ${state.winningTeam + 1}` : ''}`, `by ${reason}`]
    : ['💀 Bankrupt — no winner', 'solo run over'];
  if (champ) celebrate3D(state.players.indexOf(champ), champ.color);
  await openDialog3D({ title: '🏆 Game over', big: state.winner ? '🎉' : '💀', lines: head, options: [{ id: 'gg', label: 'GG — close' }] });
}

// ---------------- movement + animation ----------------
function seatOf(state, pid) { return Math.max(0, state.players.findIndex(p => p.id === pid)); }

async function animateMove(res) {
  const [d1, d2] = res.dice;
  const seat = seatOf(res.state, playerId);
  let pos = res.oldPos;
  const steps = (res.newPos - pos + N) % N || (res.events.some(e => e.type === 'passed_go') ? N : 0);
  const path = [];
  for (let s = 0; s < steps; s++) { pos = (pos + 1) % N; path.push(pos); }
  // the state is already authoritative: paint the destination immediately so
  // the HUD/roster never lag behind, while the walk plays out on the board
  render(res.state);
  await Promise.all([showDice3D(d1, d2), animateSteps3D(seat, path)]);
  toast3D(res.events.map(describe).join(' · '), 4600);
  const offer = res.events.find(e => e.type === 'buy_offer');
  if (offer && res.state.status === 'playing' && res.state.currentPlayerId === playerId) {
    const tile = res.state.board[offer.tile];
    if (tile && !tile.ownerId) { openBuyDialog3D(offer.tile); return; }
  }
  if (res.events.some(e => e.type === 'goto_jail' || e.type === 'jail_stay')) islandDialog3D();
}

async function animateFly(res) {
  render(res.state);
  await animateFly3D(seatOf(G, playerId), res.oldPos, res.newPos);
  toast3D(res.events.map(describe).join(' · '), 4000);
}

function describe(e) {
  switch (e.type) {
    case 'dice': return `rolled ${e.dice[0]}+${e.dice[1]}${e.double ? ' (doubles!)' : ''}`;
    case 'passed_go': return `passed Start +$${e.amount} (lap ${e.lap})`;
    case 'buy_offer': return `can BUY for $${e.price}`;
    case 'rent': return `paid $${e.amount} rent`;
    case 'team_safe': return "teammate's city — no rent";
    case 'tax': return `Tax Agency -$${e.amount}`;
    case 'chance': return `Chance: ${e.text} (${e.amount})`;
    case 'tour': return `World Tour -$${e.fee} — fly available`;
    case 'fly': return `✈️ flew ${e.from} → ${e.to}`;
    case 'boost_token': return '🏆 +1 rent-boost token';
    case 'goto_jail': return '→ Lost Island!';
    case 'jail_out': return 'escaped Lost Island (doubles)';
    case 'jail_fine': return `escaped Lost Island -$${e.amount}`;
    case 'jail_stay': return 'trapped on Lost Island';
    case 'extra_turn': return 'doubles → roll again!';
    case 'bankrupt': return 'BANKRUPT!';
    default: return e.type;
  }
}

// ---------------- websocket + render ----------------
function connectWS() {
  if (ws) ws.close();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${gameId}/${playerId || 'spectator'}`);
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.kind === 'state') render(m.state);
  };
  ws.onclose = () => { ws = null; };
  ws.onerror = () => { ws = null; };
}

function render(state) {
  G = state;
  ensureBoard();
  renderBoard3D(state);
  setTop3D(state);
  setRoster3D(state);
  setLog3D(state.log);
  // waiting room: whoever created the table can deal the first round
  if (playerId && state.status === 'waiting') {
    const canStart = state.players.length >= (state.mode === 'team' ? 4 : 1)
      && (state.players[0]?.id === playerId || state.players.length >= 2);
    showWaiting3D(state, canStart);
  } else showWaiting3D({ status: 'playing' }, false);
  const me = state.players.find(p => p.id === playerId);
  if (flyTargeting && !(me && me.tourPending && state.currentPlayerId === playerId && state.status === 'playing')) {
    flyTargeting = false;
    setTargeting3D(false);
  }
  refreshHUD();
  maybeGameOver(state);
}

// keep the table fresh: the timer counts down and turns auto-skip server-side
setInterval(async () => {
  if (!gameId || !G) return;
  try {
    if ((G.timerActive && G.status === 'playing') || !ws || ws.readyState > 1) {
      render(await api('GET', `/api/games/${gameId}/state`));
    }
  } catch {}
}, 2000);

document.addEventListener('fullscreenchange', () => { if (boardReady) setTimeout(resize3D, 60); });
window.addEventListener('resize', () => { if (boardReady) resize3D(); });

// ---------------- test / debug bridge ----------------
// Exposed for the headless e2e harness (tools/e2e.mjs) and console poking.
function installDebugHooks() {
  Object.assign(window, {
    __ui3d: { findBtn: findUIButton },
    __cam: getCamera3D(),
    __renderer: getRenderer3D(),
    __scene: getSceneObject3D(),
    __chars: getChars3D(),
    __camMode: getCameraMode3D,
    __seat: getViewSeat3D,
    __mySeat: () => (G ? seatOf(G, playerId) : -1),
    __state: () => G,
    __players: () => (G ? G.players : []),
    __logOpen: () => getLogState3D().open,
    __logCount: () => getLogState3D().count,
    __lobbyName: getLobbyName3D,
    __lobbyGameId: getLobbyGameId3D,
    __lobbyVisible: isLobbyVisible3D,
    __waitingVisible: isWaitingVisible3D,
    __lobbyState: getLobbyState3D,
    __pid: () => playerId,
    __setLobbyField: setLobbyField3D,
    __dialogOpen: isDialogOpen3D,
    __dialogOptions: getDialogOptions,
    __clickDialog: id => clickDialogOption(id),
    __clickHud: id => onHUD(id),
    __tileScreenPos: idx => JSON.stringify(tileScreenPos3D(idx)),
    __charScreenPos: seat => JSON.stringify(charScreenPos3D(seat)),
    __btnPos: id => {
      const m = findUIButton(id);
      return m ? JSON.stringify(projectToScreen3D(m)) : null;
    },
    __debug: debugState3D,
    __camPos: getCameraPos3D,

    // test aid: advance the current turn the way a human would
    __forceEndTurn: async () => {
      const st = G.players[G.current];
      if (!st) return 'no-current-player';
      if (!st.hasRolled && !st.inJail) {
        // the API only checks whose turn it is, so the harness can roll for
        // every seat to walk the whole table forward
        const r = await api('POST', `/api/games/${gameId}/roll`, { playerId: st.id });
        if (st.id === playerId) render(r.state);
        else G = r.state;
        let guard = 0;
        while (isDialogOpen3D() && guard++ < 4) {
          const opts = getDialogOptions();
          const pick = opts.find(o => o.id === 'lvl0' && o.enabled) || opts.find(o => o.enabled);
          if (!pick) break;
          clickDialogOption(pick.id);
          await wait(500);
        }
      }
      try {
        const res = await api('POST', `/api/games/${gameId}/end-turn`, { playerId: st.id });
        if (st.id === playerId) render(res.state); else G = res.state;
        return 'ended';
      } catch (e) { return e.message; }
    },
    __joinOthers: async n => {
      for (let i = 0; i < n; i++) {
        await api('POST', `/api/games/${gameId}/join`, { name: ['Bo', 'Cy', 'Di'][i] });
      }
      const st = await api('GET', `/api/games/${gameId}/state`);
      setLobbyMessage3D(`${st.players.length} players at the table`, { players: st.players, status: st.status });
    },
    __celebrate: seat => celebrate3D(seat, '#fbbf24'),
    __celebrating: () => debugState3D().celebrating,
    __showGameOverDialog: () => {
      // fire and forget: the dialog promise only settles when the player
      // clicks, so this hook must not return it
      gameOverShown = null;
      maybeGameOver({
        ...G, status: 'finished', winner: playerId, winReason: 'side_monopoly',
      });
      return 'shown';
    },
    __toast: toast3D,
    __toastText: getLastToast3D,
    __onLobby: onLobby,
    __onHUD: onHUD,
    __hitTest: id => {
      const m = findUIButton(id);
      if (!m) return 'no-mesh';
      const p = projectToScreen3D(m);
      return JSON.stringify({ pos: [Math.round(p.x), Math.round(p.y)], hit: routeAt3D(p.x, p.y) });
    },
    __btnCounts: () => uiCounts3D(),
    __busy: () => busy,
    __liveTextures: liveTextureCount3D,
    __liveGeometries: liveGeometryCount3D,
    __layoutAudit: () => layoutAudit3D(),
  });
}

// open straight on the 3D lobby screen
ensureBoard();
layoutUI3D();
installDebugHooks();