// In-scene UI layer. Every panel is a camera-attached textured mesh, so the
// whole site is one WebGL canvas: lobby, roster, log, HUD bar, dialogs.
import * as THREE from 'three';
import { tex2d, roundRect } from './env3d.js';

const UI_Z = -8;          // camera-space depth of all UI
let root = null;          // THREE.Group parented to the camera
let groups = {};
let hudGroup, topGroup, rosterGroup, dlgGroup, logGroup, lobbyGroup;
let renderer = null, camera = null, raycaster = null;
let myPlayerId = null;

let hudBtns = [], dlgBtns = [], logBtns = [], lobbyBtns = [], rosterBtns = [];
let dlgResolve = null, dlgOpen = false;
let hudCb = null, logCb = null, lobbyCb = null;
let hudY = -2.35;

// log panel state
let logOpen = false, logRows = [], logSig = '';
let logPanel = null, logToggle = null;

// lobby state
let lobbyVisible = true;
let lobbySig = '';
let lobbyShowRules = false;
let lobbyField = 'name';   // which text field the keyboard writes into

// ---------- waiting room: shown after you sit down but before the game starts ----
let waitGroup = null, waitBtns = [], waitSig = '', waitInfo = null;

export function showWaiting3D(state, canStart) {
  if (!waitGroup) {
    waitGroup = new THREE.Group();
    root.add(waitGroup);
    root.userData.wait = waitGroup;
  }
  const on = state.status === 'waiting';
  waitGroup.visible = on;
  if (!on) { waitSig = ''; return; }
  const sig = JSON.stringify([state.id, state.players.map(p => p.name), canStart, state.mode]);
  if (sig === waitSig) return;
  waitSig = sig;
  clearGroup(waitGroup);
  waitBtns = [];
  const { hh, hw } = viewHalf();
  const me = state.players.find(p => p.id === myPlayerId);
  const seats = state.players.map((p, i) => ({
    text: `${i + 1}. ${p.name}${p.id === myPlayerId ? ' (you)' : ''}`,
    color: p.color, font: '700 36px system-ui,sans-serif',
  }));
  const rows = [
    { text: 'THE TABLE IS SET', color: '#fbbf24', font: '800 50px system-ui,sans-serif' },
    { text: `${state.id} · ${state.mode === 'team' ? '2v2 teams' : 'free for all'} · ${state.players.length}/${state.maxPlayers} seated`,
      color: '#94a3b8', font: '500 30px system-ui,sans-serif' },
    ...seats,
    ...(waitInfo ? [{ text: waitInfo, color: '#f87171', font: '600 30px system-ui,sans-serif' }] : []),
  ];
  const t = txt(rows, { w: 1100, h: 56 + rows.length * 46, bg: 'rgba(6,10,20,0.93)', border: '#fbbf24' });
  const panelW = 4.6, panelH = panelW * t.H / t.W;
  const p = panel(panelW, panelH, t.tex);
  const top = 2.1;                       // above the HUD row, clear of the board
  p.position.set(0, top + panelH / 2, UI_Z);
  waitGroup.add(p);
  const b = button(canStart ? '🎲 START THE GAME' : 'WAITING FOR THE HOST…', {
    sub: canStart ? 'deal the dice' : `${state.players.length} of ${state.maxPlayers}`, h: 0.5,
    accent: canStart ? '#22c55e' : '#334155', enabled: canStart,
  });
  b.userData.id = 'start';
  b.userData.enabled = canStart;
  b.position.set(0, top - 0.25, UI_Z);
  waitGroup.add(b);
  waitBtns.push(b);
  // leave-the-table escape hatch
  const back = button('← LOBBY', { sub: 'change name or table', h: 0.42, accent: '#475569' });
  back.userData.id = 'back';
  back.userData.enabled = true;
  back.position.set(0, top - 0.9, UI_Z);
  waitGroup.add(back);
  waitBtns.push(back);
}

export function setWaitingInfo3D(msg) {
  waitInfo = msg;
  waitSig = '';
}
export function isWaitingVisible3D() { return !!(waitGroup && waitGroup.visible); }

let floaters = [];
let moneyFx = [];
let lastState = null;      // kept so a resize can re-fit the top slate
let rosterPanels = [];
let rosterSig = '';
let rosterMoney = [];
let rosterGameId = null;
let sumSprite = null;

const WHITE = new THREE.Color(0xffffff);

export function attachUI3D(renderer3d, camera3d) {
  renderer = renderer3d;
  camera = camera3d;
  raycaster = new THREE.Raycaster();
  root = new THREE.Group();
  camera.add(root);
  groups = {
    hud: new THREE.Group(), top: new THREE.Group(), roster: new THREE.Group(),
    dlg: new THREE.Group(), log: new THREE.Group(), lobby: new THREE.Group(), fx: new THREE.Group(),
  };
  hudGroup = groups.hud; topGroup = groups.top; rosterGroup = groups.roster;
  dlgGroup = groups.dlg; logGroup = groups.log; lobbyGroup = groups.lobby;
  for (const g of Object.values(groups)) root.add(g);
  root.renderOrder = 1000;
  buildLogPanel();
  showLobby3D(true);
}

export function setMyPlayerId3D(id) { myPlayerId = id; }
export function isDialogOpen3D() { return dlgOpen; }
export function onHUDClick3D(cb) { hudCb = cb; }
export function onLogClick3D(cb) { logCb = cb; }
export function onLobbyClick3D(cb) { lobbyCb = cb; }

// ---------- generic helpers ----------
function clearGroup(g) {
  while (g.children.length) {
    const m = g.children.pop();
    if (m.geometry) m.geometry.dispose();
    if (m.material) {
      if (m.material.map) m.material.map.dispose();
      m.material.dispose();
    }
  }
}
function disposeMesh(m) {
  if (m.geometry) m.geometry.dispose();
  if (m.material) {
    if (m.material.map) m.material.map.dispose();
    m.material.dispose();
  }
}

function panel(w, h, tex, opts = {}) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })
  );
  mesh.renderOrder = opts.order ?? 1000;
  mesh.userData.isUI = true;
  return mesh;
}

// ---------- text that always fits its box ----------
// Panels are canvas textures sized in world units, so a string that is one
// character too long overflows instead of being clipped. These helpers measure
// and shrink (or wrap) so nothing ever spills outside its panel.

const measureCtx = document.createElement('canvas').getContext('2d');

// Largest font size (px) at or below `size` that fits `text` in `maxW`.
function fitFont(text, weight, family, size, maxW, minSize = 10) {
  let s = size;
  while (s > minSize) {
    measureCtx.font = `${weight} ${s}px ${family}`;
    if (measureCtx.measureText(text).width <= maxW) break;
    s -= Math.max(1, Math.round(s * 0.06));
  }
  measureCtx.font = `${weight} ${s}px ${family}`;
  return s;
}

// Draw text anchored at (x, y) and guaranteed to stay inside a `maxW` box that
// extends from that anchor in the direction implied by `align`:
//   left   -> occupies [x, x + maxW]     right -> [x - maxW, x]
//   center -> occupies [x - maxW/2, x + maxW/2]
function drawFitted(ctx, text, x, y, opts = {}) {
  const {
    weight = 600, family = 'system-ui,sans-serif', size = 40,
    maxW = ctx.canvas.width - 24, color = '#e2e8f0', align = 'center', minSize = 10,
  } = opts;
  const str = String(text);
  const s = fitFont(str, weight, family, size, maxW, minSize);
  ctx.font = `${weight} ${s}px ${family}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(str, x, y);
  return s;
}

// Greedy word wrap to `maxCols` visual columns (approximates advance widths).
function wrapToWidth(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const out = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const trial = cur + ' ' + words[i];
    if (ctx.measureText(trial).width <= maxW) cur = trial;
    else { out.push(cur); cur = words[i]; }
  }
  out.push(cur);
  return out;
}

// Draw one entry as up to `maxLines` fitted lines, growing the box as needed.
export function textHeight(text, opts = {}) {
  const W = opts.w || 768;
  const size = opts.size || 40;
  const lh = opts.lh || Math.round(size * 1.25);
  measureCtx.font = `${opts.weight || 600} ${size}px ${opts.family || 'system-ui,sans-serif'}`;
  const inner = W - (opts.padx ?? 28) * 2;
  const fitted = fitFont(String(text), opts.weight || 600, opts.family || 'system-ui,sans-serif', size, inner);
  measureCtx.font = `${opts.weight || 600} ${fitted}px ${opts.family || 'system-ui,sans-serif'}`;
  const lines = opts.wrap === false
    ? [String(text)]
    : wrapToWidth(measureCtx, text, inner).slice(0, opts.maxLines || 3);
  return { W, lh, lines, size: fitted, height: lines.length * lh + (opts.pad ?? 22) * 2 };
}

function txt(lines, opts = {}) {
  const W = opts.w || 768;
  const lh = opts.lh || 46;
  const pad = opts.pad ?? 34;
  const H = opts.h || (lines.length * lh + pad * 2);
  const tex = tex2d(W, H, (ctx, cw, ch) => {
    if (opts.bg !== false) {
      ctx.fillStyle = opts.bg || 'rgba(8,12,22,0.88)';
      roundRect(ctx, 4, 4, cw - 8, ch - 8, opts.r ?? 26);
      ctx.fill();
      if (opts.border) {
        ctx.strokeStyle = opts.border; ctx.lineWidth = opts.borderW || 6;
        roundRect(ctx, 4 + (opts.borderW || 6), 4 + (opts.borderW || 6),
          cw - 8 - 2 * (opts.borderW || 6), ch - 8 - 2 * (opts.borderW || 6), opts.r ?? 26);
        ctx.stroke();
      }
    }
    const inner = cw - 24;
    let y = pad;
    for (const ln of lines) {
      const spec = typeof ln === 'string' ? { text: ln } : ln;
      const font = spec.font || '600 40px system-ui,sans-serif';
      const m = /(\d+(?:\.\d+)?)px/.exec(font);
      const weight = (/^\d{3}\s/.test(font) ? '700' : '600');
      const family = font.replace(/^[^ ]+\s+\d+(?:\.\d+)?px\s*/, '') || 'system-ui,sans-serif';
      y += spec.size || lh;
      drawFitted(ctx, spec.text, cw / 2, y, {
        weight, family, size: m ? +m[1] : 40, maxW: inner,
        color: spec.color || '#e2e8f0', minSize: 12,
      });
      if (spec.sub) {
        y += 34;
        drawFitted(ctx, spec.sub, cw / 2, y, {
          weight: 500, family, size: 30, maxW: inner, color: '#94a3b8', minSize: 11,
        });
      }
    }
  });
  return { tex, W, H };
}

// A clickable 3D button. Its width is measured from the label, and the label
// itself is drawn fitted, so a long action name shrinks rather than spilling
// past the button face.
const MAX_BTN_W = 620;
function button(label, opts = {}) {
  const fs = opts.fs || 44;
  const meas = measureCtx;
  meas.font = `700 ${fs}px system-ui,sans-serif`;
  const tw = meas.measureText(label).width;
  meas.font = '600 28px system-ui,sans-serif';
  const sw = opts.sub ? meas.measureText(opts.sub).width : 0;
  const W = Math.ceil(Math.min(MAX_BTN_W, Math.max(tw, sw) + 90));
  const H = opts.sub ? 128 : 96;
  const enabled = opts.enabled !== false;
  const accent = opts.accent || '#22c55e';
  // pick readable ink for the fill we were given (dark slate toggles need
  // light text, bright accents need dark text)
  const ink = readableInk(accent);
  const tex = tex2d(W, H, (ctx) => {
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 3, 3, W - 6, H - 6, 24);
    // vertical gradient body so buttons read as physical objects
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (enabled) {
      g.addColorStop(0, lighten(accent, 0.16));
      g.addColorStop(1, accent);
    } else {
      g.addColorStop(0, '#3a4658'); g.addColorStop(1, '#2b3444');
    }
    ctx.fillStyle = g; ctx.fill();
    // top gloss
    ctx.fillStyle = enabled ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
    roundRect(ctx, 8, 8, W - 16, (H - 16) * 0.42, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 4;
    roundRect(ctx, 3, 3, W - 6, H - 6, 24); ctx.stroke();
    ctx.strokeStyle = enabled ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.1)'; ctx.lineWidth = 3;
    roundRect(ctx, 7, 7, W - 14, H - 14, 21); ctx.stroke();
    // fitted label: shrink before spilling outside the face
    drawFitted(ctx, label, W / 2, opts.sub ? 62 : 66, {
      weight: 700, size: fs, maxW: W - 28, color: enabled ? ink : '#8b98ab', minSize: 14,
    });
    if (opts.sub) {
      drawFitted(ctx, opts.sub, W / 2, 104, {
        weight: 600, size: 28, maxW: W - 28,
        color: enabled ? ink : '#6b7789', minSize: 12,
      });
    }
  });
  const h = opts.h || 0.5;
  const w = h * (W / H);
  const mesh = panel(w, h, tex);
  mesh.userData.enabled = enabled;
  mesh.userData.w = w;
  return mesh;
}

function lighten(hex, amt) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amt);
  return '#' + c.getHexString();
}
function darken(hex, amt) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, -amt);
  return '#' + c.getHexString();
}
// near-black ink on bright fills, near-white ink on dark fills
function readableInk(hex) {
  const c = new THREE.Color(hex);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return lum > 0.42 ? darken(hex, 0.7) : '#f1f5f9';
}

function viewHalf() {
  const hh = Math.abs(UI_Z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return { hh, hw: hh * camera.aspect };
}

export function layoutUI3D() {
  if (!root) return;
  const { hh } = viewHalf();
  hudY = -hh + 0.44;
  layoutHUD();     // also re-fits the log above the (possibly rescaled) HUD
  layoutRoster();
  layoutLog();
  // the top slate sizes itself to the viewport, so re-fit it after a resize
  if (topGroup.userData.topPanel && lastState) setTop3D(lastState);
  if (lobbyVisible) renderLobby3D();   // the lobby block re-fits itself
}

export function onResize3D() { layoutUI3D(); }

const DICE_FACE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// ---------- top bar ----------
// One centred slate. The four roster panels own the corners and the log owns the
// lower left, so the strip of screen this can take without hiding the board is
// the top middle: wide enough for the turn, narrow enough to see past.
export function setTop3D(state) {
  if (!topGroup) return;
  lastState = state;
  clearGroup(topGroup);
  const me = state.players.find(p => p.id === myPlayerId);
  const cur = state.players[state.current];
  const win = state.winner ? (state.players.find(p => p.id === state.winner) || {}).name : null;
  const d = state.lastDice || [];
  const { hh, hw } = viewHalf();

  const rows = [
    { text: `${state.id} · ${state.mode === 'team' ? '2v2 TEAMS' : 'FREE FOR ALL'}`, color: '#7f8ea3', font: '600 26px ui-monospace,monospace', align: 'center' },
    win
      ? { text: `🏆 ${win} WINS`, color: '#fbbf24', font: '800 40px system-ui,sans-serif', lh: 54, align: 'center' }
      : {
        text: state.status === 'playing'
          ? `ROUND ${state.round} · ${cur ? cur.name : '-'}`
          : `ROUND ${state.round} · ${state.status.toUpperCase()}`,
        color: '#e2e8f0', font: '700 40px system-ui,sans-serif', lh: 54, align: 'center',
      },
  ];
  // dice and timer share the bottom line, one per side
  const foot = [];
  if (state.timerActive) {
    const secs = Math.max(0, Math.floor(state.secondsLeft));
    foot.push({ text: `⏱ ${secs}s`, color: secs <= 5 ? '#f87171' : '#4ade80', font: '700 34px system-ui,sans-serif', align: 'left' });
  }
  foot.push({ text: me ? me.name : 'watching', color: me ? me.color : '#64748b', font: '700 32px system-ui,sans-serif', align: 'right' });

  const W = 900, H = 44 + rows.length * 50 + 44;
  const tex = tex2d(W, H, (ctx) => {
    ctx.fillStyle = 'rgba(6,10,20,0.86)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 28); ctx.fill();
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 5;
    roundRect(ctx, 9, 9, W - 18, H - 18, 24); ctx.stroke();
    let y = 26;
    for (const r of rows) {
      y += r.lh || 50;
      drawFitted(ctx, r.text, W / 2, y, { weight: 700, size: 40, maxW: W - 40, color: r.color });
    }
    y += 34;
    const halfW = (W - 68) / 2;
    drawFitted(ctx, foot[0].text, 34, y, {
      weight: 700, size: 34, maxW: halfW, color: foot[0].color, align: 'left',
    });
    if (foot[1]) {
      drawFitted(ctx, foot[1].text, W - 34, y, {
        weight: 700, size: 32, maxW: halfW, color: foot[1].color, align: 'right',
      });
    }
  });
  const w = Math.min(3.4, hw * 1.05);
  const h = w * H / W;
  const mesh = panel(w, h, tex);
  mesh.position.set(0, hh - h / 2 - 0.08, UI_Z);
  topGroup.add(mesh);
  topGroup.userData.topPanel = mesh;
}

// ---------- HUD action bar ----------
export function setHUD3D(defs) {
  if (!hudGroup) return;
  clearGroup(hudGroup);
  hudBtns = [];
  for (const d of defs) {
    const b = button(d.label, { sub: d.sub, accent: d.accent, enabled: d.enabled !== false, h: 0.44 });
    b.userData.id = d.id;
    hudGroup.add(b);
    hudBtns.push(b);
  }
  layoutHUD();
}

function layoutHUD() {
  if (!hudBtns.length) return;
  const gap = 0.1;
  const total = hudBtns.reduce((s, b) => s + b.userData.w, 0) + gap * (hudBtns.length - 1);
  let x = -total / 2;
  for (const b of hudBtns) {
    const w = b.userData.w;
    b.position.set(x + w / 2, hudY, UI_Z);
    x += w + gap;
  }
  const { hw } = viewHalf();
  hudGroup.scale.setScalar(Math.min(1, (hw * 1.94) / total));
  layoutLog();
}

// ---------- roster corner panels ----------
export function setRoster3D(state) {
  if (!rosterGroup) return;
  if (state.id !== rosterGameId) {
    rosterGameId = state.id;
    rosterMoney = state.players.map(p => p.money);
  }
  const deltas = state.players.map((p, s) => {
    const old = rosterMoney[s];
    rosterMoney[s] = p.money;
    return old === undefined || old === p.money ? 0 : p.money - old;
  });
  // The holdings line changes with ownership, level and boosts, so those go
  // into the signature that decides whether a panel is redrawn.
  const sig = JSON.stringify([
    state.players.map(p => [
      p.name, p.color, p.money, p.netWorth, p.bankrupt, p.inJail, p.tourPending,
      p.team, p.laps, p.position, state.currentPlayerId === p.id,
    ]),
    state.board.filter(t => t.ownerId).map(t => [t.index, t.ownerId, t.level, t.boost, t.rent]),
    state.mode,
  ]);
  if (sig !== rosterSig) {
    rosterSig = sig;
    clearGroup(rosterGroup);
    rosterPanels = [];
    rosterBtns = [];
    state.players.forEach((p, s) => {
      const tex = rosterTexture(p, state.currentPlayerId === p.id, p.id === myPlayerId, state);
      const mesh = panel(1.62, 1.62 * tex.image.height / tex.image.width, tex);
      mesh.userData.seat = s;
      rosterGroup.add(mesh);
      rosterPanels.push(mesh);
      rosterBtns.push(mesh);
    });
    // vacant seats, so the table always has four characters around it
    for (let s = state.players.length; s < 4; s++) {
      const tex = rosterTexture({ name: 'OPEN SEAT', color: '#475569', money: 0, netWorth: 0, bankrupt: false, laps: 0 }, false, false, state, true);
      const mesh = panel(1.62, 1.62 * tex.image.height / tex.image.width, tex);
      mesh.userData.seat = s;
      rosterGroup.add(mesh);
      rosterPanels.push(mesh);
    }
    rosterBtns = rosterPanels.slice();
    layoutRoster();
  }
  deltas.forEach((d, s) => { if (d !== 0) spawnMoneyFx(s, d); });
}

// How much would each opponent hand over if they stepped on this city?
// Free for your own token and your 2v2 partner, otherwise the tile's live rent.
function rentForViewer(state, tile, viewer) {
  if (!viewer) return null;
  if (tile.ownerId === viewer.id) return { amount: 0, note: 'yours', color: '#64748b' };
  if (state.mode === 'team' && tile.ownerId && viewer.team != null) {
    const owner = state.players.find(pp => pp.id === tile.ownerId);
    if (owner && owner.team === viewer.team) return { amount: 0, note: 'mate', color: '#38bdf8' };
  }
  return { amount: tile.rent, note: '', color: '#fbbf24' };
}

// One row per owned city, listing what each opponent would hand over if they
// stepped on it. That figure moves with houses and boosts, so it belongs here
// rather than printed on the tile. Your own token and your 2v2 partner pay
// nothing, and that is spelled out rather than shown as a misleading $0.
const MAX_HOLDINGS = 4;

function rosterTexture(p, isCurrent, isMe, state, vacant = false) {
  const held = vacant ? [] : state.board.filter(t => t.ownerId === p.id && t.type === 'property');
  const others = vacant ? [] : state.players.filter(pp => pp.id !== p.id && !pp.bankrupt);
  const shown = held.slice(0, MAX_HOLDINGS);
  const headH = 210;
  const cols = Math.max(1, others.length);
  const rowH = 40;
  const H = headH + (shown.length ? 46 + shown.length * rowH + (held.length > shown.length ? 26 : 0) : 0)
    + (held.length ? 0 : 40);
  const inner = 560 - 56;

  return tex2d(560, H, (ctx, W) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,10,20,0.88)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 30); ctx.fill();
    ctx.lineWidth = isCurrent ? 11 : 5;
    ctx.strokeStyle = isCurrent ? '#fbbf24' : isMe ? '#e2e8f0' : '#334155';
    roundRect(ctx, 9, 9, W - 18, H - 18, 26); ctx.stroke();
    ctx.fillStyle = vacant ? '#334155' : p.color;
    roundRect(ctx, 22, 22, 20, H - 44, 10); ctx.fill();

    // header: name, cash, standing
    const status = `${isCurrent ? '▶ ' : ''}${p.inJail ? '🏝 ' : ''}${p.tourPending ? '✈ ' : ''}${p.bankrupt ? '☠ ' : ''}`;
    drawFitted(ctx, `${status}${p.name}`, 58, 72, {
      weight: 700, size: 50, maxW: inner - (isMe ? 90 : 0),
      color: vacant ? '#64748b' : p.bankrupt ? '#94a3b8' : '#ffffff', align: 'left',
    });
    if (isMe) {
      drawFitted(ctx, 'YOU', W - 30, 46, {
        weight: 700, size: 26, maxW: 90, color: '#fbbf24', align: 'right', minSize: 13,
      });
    }
    drawFitted(ctx, vacant ? '—' : `$${p.money}`, 58, 134, {
      weight: 700, size: 58, maxW: inner, color: vacant ? '#475569' : '#4ade80', align: 'left',
    });
    drawFitted(ctx, vacant ? 'waiting for a player'
      : `net $${p.netWorth} · tile ${p.position} · laps ${p.laps}${state?.mode === 'team' && p.team != null ? ` · T${p.team + 1}` : ''}`,
    58, 178, {
      weight: 600, size: 28, maxW: inner, color: '#94a3b8', align: 'left', minSize: 16,
    });

    let y = headH;
    if (!shown.length) {
      drawFitted(ctx, vacant ? '' : 'no cities yet', 58, y + 24, {
        weight: 600, size: 30, maxW: inner, color: vacant ? '#475569' : '#64748b', align: 'left',
      });
      return;
    }

    // column header: whose rent is in which column
    const colW = (inner - 190) / cols;
    drawFitted(ctx, 'IF THEY STEP ON IT', 58, y, {
      weight: 700, size: 22, maxW: 184, color: '#7f8ea3', align: 'left',
    });
    others.forEach((v, k) => {
      drawFitted(ctx, v.name.slice(0, 6).toUpperCase(), 58 + 190 + colW * (k + 0.5), y, {
        weight: 700, size: 22, maxW: colW - 6, color: v.color, align: 'center', minSize: 11,
      });
    });
    y += 30;

    for (const t of shown) {
      const lvl = t.level >= 4 ? 'HOTEL' : t.level ? `L${t.level}` : '';
      ctx.fillStyle = p.color;
      ctx.font = '700 30px system-ui,sans-serif';
      const nameMax = 184 - (lvl ? 34 : 0);
      drawFitted(ctx, t.name, 58, y + 6, {
        weight: 700, size: 30, maxW: nameMax, color: p.color, align: 'left', minSize: 15,
      });
      if (lvl) {
        drawFitted(ctx, lvl, 58 + nameMax + 4, y + 6, {
          weight: 700, size: 22, maxW: 40,
          color: t.level >= 4 ? '#f87171' : '#4ade80', align: 'left', minSize: 11,
        });
      }
      others.forEach((v, k) => {
        const r = rentForViewer(state, t, v);
        const label = r.amount === 0 ? 'free' : `$${r.amount}`;
        drawFitted(ctx, label, 58 + 190 + colW * (k + 0.5), y + 6, {
          weight: 700, size: 28, maxW: colW - 6,
          color: r.amount === 0 ? '#64748b' : '#fbbf24', align: 'center', minSize: 13,
        });
      });
      y += rowH;
    }
    if (held.length > shown.length) {
      drawFitted(ctx, `+${held.length - shown.length} more cities`, 58, y + 14, {
        weight: 600, size: 24, maxW: inner, color: '#7f8ea3', align: 'left',
      });
    }
  });
}

function layoutRoster() {
  const { hh, hw } = viewHalf();
  // seats 0..3 -> TL, TR, BL, BR. Panels grow with the number of cities a
  // player holds, so each one is anchored to its own corner and grows inward:
  // a top panel extends downwards, a bottom panel upwards. That keeps the
  // frame edge clean however many holdings are listed.
  const spots = [[-1, 1], [1, 1], [-1, -1], [1, -1]];
  const m = 0.08;
  for (const mesh of rosterPanels) {
    const seat = mesh.userData.seat ?? 0;
    const [sx, sy] = spots[seat % 4];
    const pw = mesh.geometry.parameters.width;
    const ph = mesh.geometry.parameters.height;
    // anchor by the panel's own edge, so a taller panel grows inward and its
    // outer edge stays exactly m inside the frame
    mesh.position.set(
      sx * (hw - pw / 2 - m),
      sy * (hh - m - ph / 2),
      UI_Z,
    );
  }
}

function spawnMoneyFx(seat, delta) {
  const gain = delta > 0;
  const tex = txt([{ text: `${gain ? '+' : ''}$${delta}`, color: gain ? '#4ade80' : '#f87171', font: '800 76px system-ui,sans-serif' }],
    { w: 420, h: 130, bg: false });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.tex, transparent: true, depthTest: false, toneMapped: false }));
  sp.scale.set(1.5, 1.5 * 130 / 420, 1);
  sp.renderOrder = 1002;
  const base = rosterPanels[seat] ? rosterPanels[seat].position : new THREE.Vector3(0, 1.6, UI_Z);
  const stack = floaters.filter(f => f.seat === seat).length;
  sp.position.set(base.x, base.y + 0.9 + stack * 0.42, UI_Z);
  groups.fx.add(sp);
  floaters.push({ sprite: sp, seat, y0: sp.position.y, start: performance.now(), dur: 1400 });
  moneyFx.push({ seat, tint: gain ? 0x4a2a2a : 0x2a4a4a, start: performance.now() });
}

// ---------- foldable log panel ----------
function logLineStyle(l) {
  if (/wins|winner|instantly/i.test(l)) return '#fbbf24';
  if (/BANKRUPT|elimin/i.test(l)) return '#f87171';
  if (/pays|pay |buys|rent|tax/i.test(l)) return '#fca5a5';
  if (/joined|Game .*created|started/i.test(l)) return '#94a3b8';
  if (/passes Start|draws|flies|escapes/i.test(l)) return '#4ade80';
  return '#cbd5e1';
}

function buildLogPanel() {
  clearGroup(logGroup);
  logBtns = [];
  // the toggle pill: its caption changes with the fold state
  logToggle = logPill(false);
  logToggle.userData.id = 'log';
  logToggle.userData.enabled = true;
  logToggle.userData.w = 1.1;
  logGroup.add(logToggle);
  logBtns.push(logToggle);
  // the unfolding scroll itself
  const pTex = txt([{ text: 'log', color: '#cbd5e1', font: '600 34px system-ui,sans-serif' }],
    { w: 700, h: 420, bg: 'rgba(8,12,22,0.9)', border: '#c9a227' });
  logPanel = panel(2.6, 2.6 * 420 / 700, pTex.tex);
  logPanel.visible = false;
  logGroup.add(logPanel);
  layoutLog();
}

function logPill(open) {
  const t = txt([{
    text: open ? '📜 HIDE' : '📜 LOG',
    color: open ? '#fbbf24' : '#e2e8f0',
    font: '700 42px system-ui,sans-serif',
  }], { w: 320, h: 96, bg: 'rgba(8,12,22,0.9)', border: open ? '#fbbf24' : '#c9a227' });
  return panel(1.1, 1.1 * 96 / 320, t.tex);
}

export function toggleLog3D(force) {
  logOpen = force === undefined ? !logOpen : !!force;
  if (logToggle) {
    if (logToggle.material.map) logToggle.material.map.dispose();
    logToggle.material.map = logPill(logOpen).material.map;
    logToggle.material.needsUpdate = true;
  }
  renderLogRows();
  layoutLog();
  if (logPanel) logPanel.visible = logOpen;
  return logOpen;
}

export function setLog3D(entries) {
  logRows = (entries || []).slice(-24).reverse();
  const sig = logRows.length + '|' + (logRows[0] || '');
  if (sig === logSig) return;
  logSig = sig;
  renderLogRows();
}

function renderLogRows() {
  if (!logPanel) return;
  const W = 760, rowH = 40;
  const shown = logRows.slice(0, 14);
  const H = Math.max(120, 92 + shown.length * rowH);
  const tex = tex2d(W, H, (ctx) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,10,20,0.92)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 26); ctx.fill();
    ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 6;
    roundRect(ctx, 9, 9, W - 18, H - 18, 22); ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    roundRect(ctx, 22, 20, 200, 50, 16); ctx.fill();
    ctx.fillStyle = '#201404';
    ctx.font = '700 34px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GAME LOG', 122, 55);
    ctx.textAlign = 'left';
    // server lines carry names and amounts of unknown length, so fit each one
    // to the column instead of truncating mid-word
    shown.forEach((l, i) => {
      const y = 116 + i * rowH;
      ctx.globalAlpha = 1 - i / (shown.length + 3);
      drawFitted(ctx, l, 30, y, {
        weight: i === 0 ? 700 : 500, size: 30, maxW: W - 60,
        color: logLineStyle(l), align: 'left', minSize: 15,
      });
      ctx.globalAlpha = 1;
    });
    if (!shown.length) {
      drawFitted(ctx, 'nothing has happened yet', 30, 130, {
        weight: 500, size: 30, maxW: W - 60, color: '#64748b', align: 'left',
      });
    }
  });
  logPanel.geometry.dispose();
  const aspect = H / W;
  logPanel.geometry = new THREE.PlaneGeometry(2.6, 2.6 * aspect);
  if (logPanel.material.map) logPanel.material.map.dispose();
  logPanel.material.map = tex;
  logPanel.material.needsUpdate = true;
}

function layoutLog() {
  if (!logToggle) return;
  const { hh, hw } = viewHalf();
  // the scroll lives on the left edge, just above the HUD strip and below the
  // top-left roster panel, so unfolding it never covers the buttons
  const hudTop = hudY + 0.62;
  logToggle.position.set(-hw + 0.62, Math.max(hudTop + 0.3, -hh + 1.15), UI_Z);
  if (logPanel) {
    const h = logPanel.geometry.parameters.height;
    logPanel.position.set(
      logToggle.position.x + logPanel.geometry.parameters.width / 2 + 0.1,
      logToggle.position.y + 0.28 + h / 2,
      UI_Z,
    );
    logPanel.visible = logOpen;
  }
}

// ---------- lobby (all in 3D) ----------
export function showLobby3D(on) {
  lobbyVisible = on;
  if (lobbyGroup) {
    lobbyGroup.visible = on;
    lobbyGroup.position.z = 0;
  }
  if (hudGroup) hudGroup.visible = !on;
  if (logGroup) logGroup.visible = !on;
  if (topGroup) topGroup.visible = !on;
  if (rosterGroup) rosterGroup.visible = !on;
  if (on) renderLobby3D();
  else {
    // drop the lobby buttons so stale meshes can never be hit-test targets
    clearGroup(lobbyGroup);
    lobbyBtns = [];
  }
}

export function setLobby3D(opts) {
  Object.assign(lobbyState, opts);
  renderLobby3D();
}

const lobbyState = {
  name: '', gameId: '', mode: 'ffa', max: 4, timer: 30,
  team: '', seat: 0, joined: false, message: 'create a game or join one with an id',
  players: [], status: 'waiting',
};



function renderLobby3D() {
  // the lobby only exists while it is on screen; every setter routes through
  // here, so guard it or stale meshes would linger as click targets
  if (!lobbyGroup || !lobbyVisible) return;
  clearGroup(lobbyGroup);
  lobbyBtns = [];
  const { hh, hw } = viewHalf();
  const s = lobbyState;
  const rows = [
    { text: s.joined ? 'YOU ARE SEATED' : 'TAKE A SEAT AT THE TABLE', color: '#fbbf24', font: '800 46px system-ui,sans-serif' },
    { text: s.message, color: '#cbd5e1', font: '500 31px system-ui,sans-serif' },
  ];
  if (s.gameId) {
    rows.push({
      text: `${s.gameId} · ${s.status} · ${s.players.length} player(s)`,
      color: '#4ade80', font: '600 30px ui-monospace,monospace',
    });
  }
  const cardTex = txt(rows, { w: 1240, h: 44 + rows.length * 48, bg: 'rgba(10,14,26,0.92)', border: '#334155' });
  const cardH = 5.4 * cardTex.H / cardTex.W;

  // the whole card is one fixed-aspect block: title + status + all button rows,
  // then uniformly scaled to fit the viewport so nothing ever overlaps
  const blockW = 5.6;                 // world width of the button column
  const gap = 0.14, rowH = 0.5;
  const DIM = '#334155';   // unselected toggle fields sit back in slate
  const rowDefs = [
    [
      { id: 'name', label: s.name ? '✎ NAME' : '✎ YOUR NAME', sub: s.name || 'click, then type', active: lobbyField === 'name', accent: '#fbbf24' },
      { id: 'mode-ffa', label: 'FFA', sub: 'free for all', active: s.mode === 'ffa', accent: '#38bdf8' },
      { id: 'mode-team', label: '2v2', sub: 'teams', active: s.mode === 'team', accent: '#a78bfa' },
    ],
    [
      { id: 'max-1', label: '1', sub: 'solo', active: s.max === 1, accent: '#34d399' },
      { id: 'max-2', label: '2', sub: 'players', active: s.max === 2, accent: '#34d399' },
      { id: 'max-3', label: '3', sub: 'players', active: s.max === 3, accent: '#34d399' },
      { id: 'max-4', label: '4', sub: 'players', active: s.max === 4, accent: '#34d399' },
      { id: 'timer', label: `⏱ ${s.timer ? s.timer + 's' : 'off'}`, sub: 'turn timer', accent: '#fbbf24' },
    ],
    [
      { id: 'gameid', label: s.gameId ? '🔑 JOIN OTHER' : '🔑 GAME ID', sub: s.gameId || 'paste id to join', active: lobbyField === 'gameid', accent: '#fbbf24' },
      { id: 'create', label: 'NEW GAME', sub: 'deal a board', accent: '#22c55e' },
      { id: 'join', label: 'JOIN', sub: 'take a seat', accent: '#38bdf8' },
      { id: 'start', label: 'START', sub: 'begin play', accent: '#f59e0b', enabled: s.players.length >= (s.mode === 'team' ? 4 : 1) },
    ],
    [
      { id: 'rules', label: lobbyShowRules ? 'HIDE RULES' : 'RULES', sub: 'how it plays', accent: '#64748b' },
      { id: 'spectate', label: 'WATCH TABLE', sub: 'no seat needed', accent: '#0ea5e9' },
    ],
  ];

  // measure rows so the card can be sized to fit its contents. Uses the same
  // width rule as button(), so the layout estimate matches what gets drawn.
  const rowWidth = defs => defs.reduce((sum, d) => {
    measureCtx.font = '700 44px system-ui,sans-serif';
    const tw = measureCtx.measureText(d.label).width;
    measureCtx.font = '600 28px system-ui,sans-serif';
    const sw = measureCtx.measureText(d.sub || '').width;
    return sum + Math.min(MAX_BTN_W, Math.max(tw, sw) + 90) / 128 * rowH;
  }, 0) + gap * (defs.length - 1);
  const contentW = Math.max(...rowDefs.map(rowWidth)) / blockW;

  const titleTex = txt([
    { text: '🎲  MONOPOLY ONLINE', color: '#fbbf24', font: '800 70px Georgia,serif' },
    { text: 'cities of the world · 4 players round one table', color: '#94a3b8', font: '600 33px system-ui,sans-serif' },
  ], { w: 1280, h: 210, bg: 'rgba(6,10,20,0.92)', border: '#c9a227' });
  const titleH = blockW * 210 / 1280;
  const pad = 0.16;
  const rowsH = rowDefs.length * (rowH + gap) - gap;
  const labelH = 0.3;
  const totalH = titleH + pad + cardH + pad + rowsH + pad + labelH;
  // fit to the viewport with a small margin on every side
  const fit = Math.min(1, (hh * 1.88) / totalH, (hw * 1.9) / (contentW + pad * 2));
  const y0 = totalH * fit / 2;
  lobbyGroup.scale.setScalar(fit);

  let y = y0 - titleH / 2;
  const title = panel(blockW, titleH, titleTex.tex);
  title.position.set(0, y, UI_Z);
  lobbyGroup.add(title);

  y -= titleH / 2 + pad + cardH / 2;
  const card = panel(blockW, cardH, cardTex.tex);
  card.position.set(0, y, UI_Z);
  lobbyGroup.add(card);

  const addRow = (defs, rowY) => {
    const meshes = defs.map(d => {
      const accent = d.active ? d.accent : DIM;
      const b = button(d.label, {
        sub: d.sub, h: rowH, accent,
        enabled: d.enabled !== false,
      });
      b.userData.id = d.id;
      b.userData.enabled = d.enabled !== false;
      return b;
    });
    const total = meshes.reduce((a, m) => a + m.userData.w, 0) + gap * (meshes.length - 1);
    let x = -total / 2;
    meshes.forEach(m => {
      const w = m.userData.w;
      m.position.set(x + w / 2, rowY, UI_Z);
      x += w + gap;
      lobbyGroup.add(m);
      lobbyBtns.push(m);
    });
  };

  y -= cardH / 2 + pad + rowH / 2;
  rowDefs.forEach(defs => { addRow(defs, y); y -= rowH + gap; });

  // which character you will be
  const seatDefs = ['N', 'E', 'S', 'W'].map((d, seat) => {
    const taken = s.players[seat];
    return {
      id: 'seat-' + seat, label: d, sub: taken ? taken.name.slice(0, 8) : ['north', 'east', 'south', 'west'][seat],
      active: s.seat === seat, accent: taken ? taken.color : '#64748b',
    };
  });
  addRow(seatDefs, y);

  const seatLabel = txt([{ text: 'YOUR CHARACTER', color: '#94a3b8', font: '700 30px system-ui,sans-serif' }],
    { w: 500, h: 72, bg: false });
  const sl = panel(1.6, 1.6 * 72 / 500, seatLabel.tex);
  sl.position.set(0, y - rowH / 2 - labelH / 2, UI_Z);
  lobbyGroup.add(sl);

  // rules overlay replaces the button rows entirely
  if (lobbyShowRules) {
    // swap the button rows for the rules sheet
    [...lobbyGroup.children].forEach(m => { if (m !== title && m !== card) disposeMesh(m); });
    lobbyGroup.clear();
    lobbyGroup.add(title, card);
    lobbyBtns = [];
    const r = txt([
      { text: 'HOW THE TABLE WORKS', color: '#fbbf24', font: '800 50px system-ui,sans-serif' },
      { text: '• Throw the dice, walk that many tiles around the board', color: '#e2e8f0', font: '500 31px system-ui,sans-serif' },
      { text: '• Pass START for +$200 and a lap; a lap unlocks houses', color: '#e2e8f0', font: '500 31px system-ui,sans-serif' },
      { text: '• Land on a free city to buy it — straight to Lv4 HOTEL if rich', color: '#e2e8f0', font: '500 31px system-ui,sans-serif' },
      { text: '• Own all 4 resorts, a whole side, or 3 colour sets to WIN instantly', color: '#fbbf24', font: '600 31px system-ui,sans-serif' },
      { text: '• Lost Island traps you, Tax Agency takes 10% of your net worth', color: '#e2e8f0', font: '500 31px system-ui,sans-serif' },
      { text: '• World Tour buys a flight, Championship hands out rent boosts', color: '#e2e8f0', font: '500 31px system-ui,sans-serif' },
      { text: '• Click a character to sit in their eyes · C switches to freecam', color: '#4ade80', font: '600 31px system-ui,sans-serif' },
      { text: '• L unfolds the log · V resets the view · F fullscreen', color: '#4ade80', font: '600 31px system-ui,sans-serif' },
    ], { w: 1300, h: 44 + 9 * 50, bg: 'rgba(6,10,20,0.96)', border: '#c9a227' });
    const rp = panel(5.6, 5.6 * r.H / r.W, r.tex);
    rp.position.set(0, y0 - (5.6 * r.H / r.W) / 2, UI_Z - 0.3);
    lobbyGroup.add(rp);
  }
  lobbySig = JSON.stringify(lobbyState);
}

export function toggleLobbyRules3D() { lobbyShowRules = !lobbyShowRules; renderLobby3D(); return lobbyShowRules; }
export function getLobbyField3D() { return lobbyField; }
export function setLobbyField3D(f) { lobbyField = f; renderLobby3D(); }
export function getLobbyName3D() { return lobbyState.name; }
export function setLobbyName3D(v) { lobbyState.name = v.slice(0, 16); renderLobby3D(); }
export function appendLobbyName3D(ch) { lobbyState.name = (lobbyState.name + ch).slice(0, 16); renderLobby3D(); }
export function backspaceLobbyName3D() { lobbyState.name = lobbyState.name.slice(0, -1); renderLobby3D(); }
export function setLobbyGameId3D(v) { lobbyState.gameId = v.trim().slice(0, 12); renderLobby3D(); }
export function getLobbyGameId3D() { return lobbyState.gameId; }
export function getLobbySettings3D() {
  return { mode: lobbyState.mode, max: lobbyState.mode === 'team' ? 4 : lobbyState.max, timer: lobbyState.timer, seat: lobbyState.seat };
}
export function setLobbySeat3D(seat) { lobbyState.seat = seat; renderLobby3D(); }
export function lobbyToggleMode3D() { lobbyState.mode = lobbyState.mode === 'ffa' ? 'team' : 'ffa'; renderLobby3D(); }
export function lobbyCycleMax3D() { lobbyState.max = lobbyState.max >= 4 ? 1 : lobbyState.max + 1; renderLobby3D(); }
export function lobbyCycleTimer3D() {
  const opts = [0, 15, 30, 60];
  lobbyState.timer = opts[(opts.indexOf(lobbyState.timer) + 1) % opts.length];
  renderLobby3D();
}
export function setLobbyMessage3D(msg, extra = {}) {
  lobbyState.message = msg;
  Object.assign(lobbyState, extra);
  renderLobby3D();
}

// ---------- dialogs ----------
export function openDialog3D(spec) {
  if (!ready3D()) return Promise.resolve(null);
  closeDialog3D(null);
  return new Promise(resolve => { dlgResolve = resolve; buildDialog(spec); });
}
function ready3D() { return !!dlgGroup; }

function buildDialog(spec) {
  clearGroup(dlgGroup);
  dlgBtns = [];
  const lines = (spec.lines || []).slice(0, 7);
  const titleH = 116, bigH = spec.big ? 200 : 0, lineH = 46, pad = 52;
  const CH = Math.min(1024, titleH + bigH + lines.length * lineH + pad);
  const tex = tex2d(1024, CH, (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(38,48,66,0.97)');
    g.addColorStop(1, 'rgba(20,27,40,0.97)');
    ctx.fillStyle = g;
    roundRect(ctx, 4, 4, W - 8, H - 8, 36); ctx.fill();
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 7;
    roundRect(ctx, 11, 11, W - 22, H - 22, 30); ctx.stroke();
    ctx.textAlign = 'center';
    drawFitted(ctx, spec.title || '', W / 2, 86, {
      weight: 800, size: 66, maxW: W - 80, color: '#fff', minSize: 20,
    });
    let y = titleH;
    if (spec.big) {
      drawFitted(ctx, spec.big, W / 2, y + 148, {
        weight: 400, size: 150, maxW: W - 80, color: '#fff', minSize: 40,
      });
      y += bigH;
    }
    for (const ln of lines) {
      y += lineH;
      const s = typeof ln === 'string' ? { text: ln } : ln;
      const m = /(\d+(?:\.\d+)?)px/.exec(s.font || '');
      drawFitted(ctx, s.text, W / 2, y, {
        weight: 500, size: m ? +m[1] : 36, maxW: W - 80,
        color: s.color || '#cbd5e1', minSize: 16,
      });
    }
  });
  const panelW = 5.4, panelH = panelW * (CH / 1024);
  const p = panel(panelW, panelH, tex);
  p.renderOrder = 1001;
  dlgGroup.add(p);

  const opts = spec.options || [];
  const gap = 0.1, bh = 0.5;
  const totalH = panelH + 0.22 + opts.length * (bh + gap);
  p.position.set(0, totalH / 2 - panelH / 2 + 0.3, UI_Z);
  let y = totalH / 2 - panelH - 0.22 + 0.3;
  for (const o of opts) {
    const b = button(o.label, {
      sub: o.sub || o.reason || '', h: bh,
      accent: o.accent || '#22c55e', enabled: !o.disabled,
    });
    b.position.set(0, y - bh / 2, UI_Z);
    b.userData.id = o.id;
    b.userData.enabled = !o.disabled;
    b.renderOrder = 1001;
    dlgGroup.add(b);
    dlgBtns.push(b);
    y -= bh + gap;
  }
  dlgGroup.visible = true;
  hudGroup.visible = false;
  dlgOpen = true;
}

export function closeDialog3D(result) {
  if (!dlgGroup) return;
  const r = dlgResolve;
  dlgResolve = null;
  dlgBtns = [];
  dlgOpen = false;
  if (dlgGroup.userData.step) dlgGroup.userData.step = null;
  clearGroup(dlgGroup);
  dlgGroup.visible = false;
  if (hudGroup) hudGroup.visible = !lobbyVisible;
  if (r) { try { r(result ?? null); } catch (e) { console.warn(e); } }
}

// custom dice stepper
const PICK_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
export function openDicePick3D() {
  if (!dlgGroup) return Promise.resolve(null);
  closeDialog3D(null);
  let d1 = 3, d2 = 4;
  return new Promise(resolve => {
    dlgResolve = resolve;
    dlgGroup.visible = true;
    dlgOpen = true;
    if (hudGroup) hudGroup.visible = false;
    const redraw = () => {
      clearGroup(dlgGroup);
      dlgBtns = [];
      const t = txt([
        { text: '⚙️ CUSTOM DICE', color: '#fbbf24', font: '800 62px system-ui,sans-serif' },
        { text: `${PICK_FACES[d1]}  ${PICK_FACES[d2]}`, font: '150px system-ui,sans-serif', color: '#fff' },
        { text: `move exactly ${d1 + d2} tiles`, color: '#cbd5e1', font: '500 36px system-ui,sans-serif' },
        { text: `d1 = ${d1}      d2 = ${d2}`, color: '#94a3b8', font: '600 34px ui-monospace,monospace' },
      ], { w: 1024, h: 460, bg: 'rgba(24,32,48,0.97)', border: '#fbbf24' });
      const p = panel(5.4, 5.4 * 460 / 1024, t.tex);
      p.position.set(0, 1.7, UI_Z);
      dlgGroup.add(p);
      const mk = (id, label, x, y, accent, sub = '') => {
        const b = button(label, { h: 0.52, accent, sub });
        b.position.set(x, y, UI_Z);
        b.userData.id = id;
        b.userData.enabled = true;
        dlgGroup.add(b);
        dlgBtns.push(b);
      };
      mk('d1-', 'd1 −', -2.4, -0.5, '#38bdf8');
      mk('d1+', 'd1 +', -1.2, -0.5, '#38bdf8');
      mk('d2-', 'd2 −', 1.2, -0.5, '#38bdf8');
      mk('d2+', 'd2 +', 2.4, -0.5, '#38bdf8');
      mk('ok', `▶ ROLL ${d1 + d2}`, 0, -1.25, '#22c55e');
      mk('cancel', 'Cancel', 0, -1.95, '#475569');
    };
    dlgGroup.userData.step = id => {
      if (id === 'd1-') d1 = d1 > 1 ? d1 - 1 : 6;
      else if (id === 'd1+') d1 = d1 < 6 ? d1 + 1 : 1;
      else if (id === 'd2-') d2 = d2 > 1 ? d2 - 1 : 6;
      else if (id === 'd2+') d2 = d2 < 6 ? d2 + 1 : 1;
      else if (id === 'ok') { closeDialog3D({ d1, d2 }); return; }
      else { closeDialog3D(null); return; }
      redraw();
    };
    redraw();
  });
}

// ---------- dice sum / toast ----------
export function showSum3D(sum, doubles) {
  if (!groups.fx) return;
  // drawn by hand rather than via txt(): the number is centred with a measure
  // pass, so any total (and the word under it) stays inside the sprite
  const W = 560, H = 320;
  const tex = tex2d(W, H, (ctx) => {
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = '800 180px system-ui,sans-serif';
    while (ctx.measureText(String(sum)).width > W - 40 && parseInt(ctx.font) > 60) {
      ctx.font = `800 ${parseInt(ctx.font) - 8}px system-ui,sans-serif`;
    }
    ctx.lineWidth = 16;
    ctx.strokeStyle = 'rgba(2,6,23,0.9)';
    ctx.strokeText(String(sum), W / 2, 190);
    ctx.fillStyle = doubles ? '#fbbf24' : '#ffffff';
    ctx.fillText(String(sum), W / 2, 190);
    const cap = doubles ? 'DOUBLES!' : 'total';
    ctx.font = '700 48px system-ui,sans-serif';
    while (ctx.measureText(cap).width > W - 40 && parseInt(ctx.font) > 18) {
      ctx.font = `700 ${parseInt(ctx.font) - 3}px system-ui,sans-serif`;
    }
    ctx.strokeStyle = 'rgba(2,6,23,0.9)';
    ctx.strokeText(cap, W / 2, 258);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(cap, W / 2, 258);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
  sp.scale.set(2.2, 2.2 * H / W, 1);
  sp.renderOrder = 1003;
  sp.position.set(0, 1.0, UI_Z);
  groups.fx.add(sp);
  floaters.push({ sprite: sp, seat: -1, y0: 1.0, start: performance.now(), dur: 1400 });
}

// The toast is a caption for one beat. Tile names plus a dozen details easily
// outrun one line, so it wraps and the box grows to fit instead of clipping.
export function toast3D(text, ms = 2400) {
  if (!groups.fx) return;
  lastToast = text;
  const W = 1000, inner = W - 48;
  measureCtx.font = '600 36px system-ui,sans-serif';
  let size = 36;
  let lines = wrapToWidth(measureCtx, text, inner);
  // prefer fewer lines over tiny text: step the font down a little, then wrap
  while (lines.length > 3 && size > 24) {
    size -= 2;
    measureCtx.font = `600 ${size}px system-ui,sans-serif`;
    lines = wrapToWidth(measureCtx, text, inner);
  }
  lines = lines.slice(0, 3);
  const lh = Math.round(size * 1.4);
  const H = lines.length * lh + 56;
  const tex = tex2d(W, H, (ctx) => {
    ctx.fillStyle = 'rgba(8,12,22,0.92)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 24); ctx.fill();
    ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 5;
    roundRect(ctx, 9, 9, W - 18, H - 18, 20); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `600 ${size}px system-ui,sans-serif`;
    lines.forEach((ln, i) => ctx.fillText(ln, W / 2, 30 + lh * i + size * 0.8));
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
  const w = 4.4;
  sp.scale.set(w, w * H / W, 1);
  sp.renderOrder = 1003;
  sp.position.set(0, -0.35, UI_Z);
  groups.fx.add(sp);
  floaters.push({ sprite: sp, seat: -2, y0: -0.35, start: performance.now(), dur: ms });
}

// per-frame FX + hover, driven from board3d's loop
export function stepUI3D(now) {
  floaters = floaters.filter(f => {
    const k = (now - f.start) / f.dur;
    if (k >= 1) {
      if (f.sprite.parent) f.sprite.parent.remove(f.sprite);
      if (f.sprite.material.map) f.sprite.material.map.dispose();
      f.sprite.material.dispose();
      return false;
    }
    f.sprite.position.y = f.y0 + k * 0.9;
    f.sprite.material.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    return true;
  });
  moneyFx = moneyFx.filter(fx => {
    const k = (now - fx.start) / 700;
    if (k >= 1) return false;
    const mesh = rosterPanels[fx.seat];
    if (mesh) {
      mesh.material.color.setHex(fx.tint).lerp(WHITE, k);
      mesh.scale.setScalar(1 + 0.12 * Math.sin(Math.PI * Math.min(1, k * 1.6)));
    }
    return true;
  });
  for (const m of rosterPanels) {
    if (m.material.color.getHex() !== WHITE.getHex() && !moneyFx.some(fx => rosterPanels[fx.seat] === m)) {
      m.material.color.setHex(0xffffff);
      m.scale.setScalar(1);
    }
  }
}

// ---------- pointer routing ----------
function ptrNDC(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1
  );
}

export function routeClick3D(e) {
  if (!raycaster) return false;
  raycaster.setFromCamera(ptrNDC(e), camera);
  // the lobby owns the screen while it is up; only its own meshes are live
  if (lobbyVisible) {
    const hit = raycaster.intersectObjects(lobbyBtns, false)[0];
    if (hit && hit.object.userData.enabled) {
      const id = hit.object.userData.id;
      if (id.startsWith('seat-')) { lobbyState.seat = +id.slice(5); renderLobby3D(); }
      else if (id === 'rules') toggleLobbyRules3D();
      else if (lobbyCb) lobbyCb(id);
      return true;
    }
    return false;
  }
  if (dlgOpen) {
    const hit = raycaster.intersectObjects(dlgBtns, false)[0];
    if (hit && hit.object.userData.enabled) {
      const id = hit.object.userData.id;
      if (dlgGroup.userData.step && id.startsWith('d')) dlgGroup.userData.step(id);
      else { dlgGroup.userData.step = null; closeDialog3D(id); }
    }
    return true;
  }
  let hit;
  // waiting room: START / back-to-lobby, shown while players sit down
  if (waitGroup && waitGroup.visible) {
    hit = raycaster.intersectObjects(waitBtns, false)[0];
    if (hit && hit.object.userData.enabled) {
      hudCb?.(hit.object.userData.id);
      return true;
    }
  }
  hit = raycaster.intersectObjects(logBtns, false)[0];
  if (hit && hit.object.userData.enabled) {
    toggleLog3D();
    return true;
  }
  hit = raycaster.intersectObjects(hudBtns, false)[0];
  if (hit && hit.object.userData.enabled) {
    hudCb?.(hit.object.userData.id);
    return true;
  }
  return false;
}

export function routeHover3D(e) {
  if (!raycaster || !renderer) return;
  raycaster.setFromCamera(ptrNDC(e), camera);
  let list;
  if (lobbyVisible) list = lobbyBtns;
  else if (dlgOpen) list = dlgBtns;
  else if (waitGroup && waitGroup.visible) list = waitBtns;
  else list = logBtns.concat(hudBtns);
  const hit = raycaster.intersectObjects(list, false)[0];
  renderer.domElement.style.cursor = hit && hit.object.userData.enabled ? 'pointer' : '';
  for (const m of list) {
    const on = hit && hit.object === m && m.userData.enabled;
    const s = on ? 1.08 : 1;
    m.scale.setScalar(s);
  }
}

export function getUiRoot3D() { return root; }
export function getUiGroups3D() { return groups; }
export function isLobbyVisible3D() { return lobbyVisible; }

// Debug/testing hooks: find any clickable 3D UI mesh by its id, and read the
// lobby + log state. Used by tools/e2e.mjs and handy from the console.
export function findUIButton(id) {
  const all = [...lobbyBtns, ...waitBtns, ...hudBtns, ...dlgBtns, ...logBtns];
  return all.find(m => m.userData.id === id) || null;
}
export function uiCounts3D() {
  return {
    lobby: lobbyBtns.length, waiting: waitBtns.length, hud: hudBtns.length,
    dialog: dlgBtns.length, log: logBtns.length,
    lobbyVisible, waitingVisible: !!(waitGroup && waitGroup.visible),
  };
}

// Which UI mesh sits under a screen pixel? (debug / test aid)
export function routeAt3D(x, y) {
  if (!raycaster) return null;
  raycaster.setFromCamera(new THREE.Vector2(
    (x / renderer.domElement.clientWidth) * 2 - 1,
    -(y / renderer.domElement.clientHeight) * 2 + 1,
  ), camera);
  const lists = {
    lobby: lobbyBtns, dialog: dlgBtns, waiting: waitBtns, log: logBtns, hud: hudBtns,
  };
  for (const [name, list] of Object.entries(lists)) {
    const hit = raycaster.intersectObjects(list, false)[0];
    if (hit && hit.object.userData.enabled) return `${name}:${hit.object.userData.id}`;
  }
  return 'nothing';
}

export function getDialogOptions() {
  return dlgBtns.map(b => ({ id: b.userData.id, enabled: b.userData.enabled }));
}
export function clickDialogOption(id) {
  const b = dlgBtns.find(x => x.userData.id === id && x.userData.enabled);
  if (!b) return false;
  if (dlgGroup.userData.step && b.userData.id.startsWith('d')) dlgGroup.userData.step(b.userData.id);
  else { dlgGroup.userData.step = null; closeDialog3D(b.userData.id); }
  return true;
}
export function getLogState3D() { return { open: logOpen, count: logRows.length }; }
export function getLobbyState3D() { return { ...lobbyState, field: lobbyField }; }
export function getLobbyMessage3D() { return lobbyState.message; }
export function setLobbyVisible3D(v) { showLobby3D(v); }
let lastToast = '';
export function getLastToast3D() { return lastToast; }

// ---------- layout audit (used by the e2e harness and handy from the console) ----------
// Every screen-space panel's world-space bounding box, so overlapping or
// off-screen UI can be spotted without eyeballing a screenshot.
export function layoutAudit3D() {
  const out = [];
  const boxes = [];
  for (const [name, g] of Object.entries(groups)) {
    if (!g || !g.visible) continue;
    g.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.visible) return;
      const p = o.geometry.parameters;
      if (!p || p.width === undefined) return;
      boxes.push({
        group: name, x: o.position.x, y: o.position.y,
        w: p.width, h: p.height,
      });
    });
  }
  // any pair that overlaps by more than a sliver is worth knowing about
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
      const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
      if (ox > 0.02 && oy > 0.02) out.push(`overlap ${a.group}(${a.w.toFixed(2)}x${a.h.toFixed(2)}) x ${b.group}(${b.w.toFixed(2)}x${b.h.toFixed(2)})`);
    }
  }
  // and anything sticking outside the visible frame
  const { hh, hw } = viewHalf();
  for (const bx of boxes) {
    if (Math.abs(bx.x) + bx.w / 2 > hw + 0.01 || Math.abs(bx.y) + bx.h / 2 > hh + 0.01) {
      out.push(`offscreen ${bx.group} at ${bx.x.toFixed(2)},${bx.y.toFixed(2)} size ${bx.w.toFixed(2)}x${bx.h.toFixed(2)}`);
    }
  }
  return out;
}

// renderer texture bookkeeping, to catch leaks between rebuilds
export function liveTextureCount3D() {
  return renderer.info.memory.textures;
}
export function liveGeometryCount3D() {
  return renderer.info.memory.geometries;
}