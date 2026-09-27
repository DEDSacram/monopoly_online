// 3D Monopoly board (Three.js). Camera lives at the Start corner,
// looking diagonally across the board. All game rules stay server-side;
// this module only renders state + plays movement animations.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const PITCH = 1.16;          // world spacing between tile centers
const TILE = 1.06;           // tile footprint
const TILE_TOP = 0.3;        // y of tile top surface
const N = 28;

const GROUP_COLORS = {
  brown: 0x92400e, cyan: 0x06b6d4, pink: 0xec4899, orange: 0xf97316,
  red: 0xef4444, green: 0x16a34a, blue: 0x3b82f6, resort: 0xeab308,
};
const SPECIAL_COLORS = {
  go: 0x16a34a, chance: 0x7c3aed, tax_agency: 0xb45309, island: 0x0ea5e9,
  tour: 0x0284c7, championship: 0xeab308, sender: 0x475569,
};
const SEAT_OFF = [[-0.26, -0.26], [0.26, -0.26], [-0.26, 0.26], [0.26, 0.26]];

let renderer, scene, camera, controls, raycaster;
let tileMeshes = [];      // per-tile {mesh, topMat}
let markerGroups = [];    // per-tile THREE.Group (houses/hotel/boost/flag/label)
let plateSprites = [];    // per-tile label sprite (toggleable)
let platesVisible = true; // tile name plates toggle
let tokenMeshes = [];     // per seat index
let tokenTags = [];       // floating name sprites, one per seat
let turnRing = null;      // pulsing marker under the current player's token
let currentSeat = -1;
let tagSig = '';
let diceMeshes = [];
let centerMesh = null, centerSig = '';
let boardSig = '';
let cursor = null;
let tokenLock = false;
let tileClickCb = null;
let lastState = null;
let ready = false;

// shared geometry / materials
let GEO = {};
const MAT = {};

function tileXZ(i) {
  let col, row;
  if (i <= 7) { col = i; row = 0; }
  else if (i <= 13) { col = 7; row = i - 7; }
  else if (i <= 21) { col = 7 - (i - 14); row = 7; }
  else { col = 0; row = 6 - (i - 22); }
  return { x: (col - 3.5) * PITCH, z: (row - 3.5) * PITCH };
}

// Start tile (index 0) sits at the min-x/min-z corner.
const START_XZ = tileXZ(0);
const CAM_POS = new THREE.Vector3(START_XZ.x - 4.6, 8.4, START_XZ.z - 4.6);
const CAM_TGT = new THREE.Vector3(0.4, 0, 0.4);

export function initBoard3D(container) {
  if (ready) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x140c07); // warm tavern dark
  scene.fog = new THREE.Fog(0x140c07, 26, 70);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(CAM_POS.x - 5, CAM_POS.y + 5, CAM_POS.z - 5); // intro start

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAM_TGT);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 32;
  controls.maxPolarAngle = 1.35;

  // camera-attached UI rig (HUD + dialogs stay readable while orbiting)
  scene.add(camera);
  uiRoot = new THREE.Group();
  camera.add(uiRoot);
  hudGroup = new THREE.Group();
  dlgGroup = new THREE.Group();
  rosterGroup = new THREE.Group();
  uiRoot.add(hudGroup, dlgGroup, rosterGroup);

  scene.add(new THREE.HemisphereLight(0xffe2b8, 0x40260f, 0.55));
  const sun = new THREE.DirectionalLight(0xffd9a8, 1.15);
  sun.position.set(6, 14, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
  scene.add(sun);

  GEO = {
    tile: new THREE.BoxGeometry(TILE, TILE_TOP, TILE),
    house: new THREE.BoxGeometry(0.17, 0.17, 0.17),
    hotel: new THREE.BoxGeometry(0.5, 0.38, 0.34),
    roof: new THREE.BoxGeometry(0.56, 0.08, 0.4),
    boost: new THREE.OctahedronGeometry(0.1),
    pole: new THREE.CylinderGeometry(0.025, 0.025, 0.55, 8),
    flag: new THREE.SphereGeometry(0.09, 12, 10),
    base: new THREE.CylinderGeometry(0.2, 0.23, 0.1, 16),
    head: new THREE.SphereGeometry(0.19, 18, 14),
    die: new THREE.BoxGeometry(0.46, 0.46, 0.46),
  };
  Object.assign(MAT, {
    side: new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.8 }),
    house: new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.6 }),
    hotel: new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 }),
    roof: new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.4, metalness: 0.4 }),
    boost: new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.3, metalness: 0.6, emissive: 0x664400 }),
    pole: new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.5 }),
  });

  // ---- tavern: wooden table with green baize inlay, plank floor ----
  const tableTex = woodTexture('#6b4423', '#452811');
  tableTex.wrapS = tableTex.wrapT = THREE.RepeatWrapping;
  tableTex.repeat.set(3, 3);
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(14, 0.5, 14),
    new THREE.MeshStandardMaterial({map: tableTex, roughness: 0.7})
  );
  table.position.y = -0.45; // top surface at y=-0.2
  table.receiveShadow = true;
  scene.add(table);
  const legMat = new THREE.MeshStandardMaterial({color: 0x3d2410, roughness: 0.85});
  for (const [lx, lz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 5.3, 0.7), legMat);
    leg.position.set(lx, -3.35, lz);
    scene.add(leg);
  }
  // green baize playing surface the board sits on
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(8 * PITCH + 0.7, 0.2, 8 * PITCH + 0.7),
    new THREE.MeshStandardMaterial({color: 0x14532d, roughness: 0.9})
  );
  slab.position.y = -0.1;
  slab.receiveShadow = true;
  scene.add(slab);
  const floorTex = woodTexture('#4a2f18', '#2a1a0c');
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(12, 12);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({map: floorTex, roughness: 0.95})
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -6;
  ground.receiveShadow = true;
  scene.add(ground);

  // candle clusters on the table corners (2 real lights, 4x flames)
  candleCluster(-5.6, -5.6, true);
  candleCluster(5.6, -5.6, true);
  candleCluster(-5.6, 5.6, false);
  candleCluster(5.6, 5.6, false);
  // fireplace glow from the west side
  buildFireplace();
  // barrels + beer mugs for atmosphere
  barrel(9.5, -9, 1.2);
  barrel(11, -7.2, 0.9);
  barrel(-10, 8.5, 1.1);
  mug(6.3, 2.5);
  mug(-2.5, 6.3);

  // tiles
  raycaster = new THREE.Raycaster();
  for (let i = 0; i < N; i++) {
    const { x, z } = tileXZ(i);
    const topMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const mesh = new THREE.Mesh(GEO.tile, [MAT.side, MAT.side, topMat, MAT.side, MAT.side, MAT.side]);
    mesh.position.set(x, TILE_TOP / 2, z);
    mesh.receiveShadow = true;
    mesh.userData.tileIndex = i;
    scene.add(mesh);
    tileMeshes.push({ mesh, topMat });
    const mg = new THREE.Group();
    scene.add(mg);
    markerGroups.push(mg);
  }

  // tokens (4 seats max): chunky pawns with a white collar so they pop
  // against tiles and labels
  const collarMat = new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.5});
  for (let s = 0; s < 4; s++) {
    const mat = new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.35, emissive: 0x111111, emissiveIntensity: 0.4});
    const g = new THREE.Group();
    const base = new THREE.Mesh(GEO.base, mat);
    base.position.y = 0.05;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.05, 16), collarMat);
    collar.position.y = 0.1;
    const head = new THREE.Mesh(GEO.head, mat);
    head.position.y = 0.3;
    head.castShadow = true;
    g.add(base, collar, head);
    g.visible = false;
    g.userData.mat = mat;
    scene.add(g);
    tokenMeshes.push(g);
    // floating name tag, glued to the token every frame (see animation loop)
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true, depthTest: false}));
    tag.scale.set(1.15, 1.15 * 80 / 256, 1);
    tag.renderOrder = 998;
    tag.visible = false;
    scene.add(tag);
    tokenTags.push(tag);
  }

  // pulsing ring under the player whose turn it is
  turnRing = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.4, 32),
    new THREE.MeshBasicMaterial({color: 0xfbbf24, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false})
  );
  turnRing.rotation.x = -Math.PI / 2;
  turnRing.renderOrder = 999;
  turnRing.visible = false;
  scene.add(turnRing);

  // dice (hidden until a roll); each die gets its own material set
  const pipTex = [];
  for (let v = 1; v <= 6; v++) pipTex.push(pipTexture(v));
  for (let d = 0; d < 2; d++) {
    const mats = [];
    for (let f = 0; f < 6; f++) mats.push(new THREE.MeshStandardMaterial({ roughness: 0.4 }));
    const m = new THREE.Mesh(GEO.die, mats);
    m.castShadow = true;
    m.visible = false;
    m.userData.pips = pipTex;
    scene.add(m);
    diceMeshes.push(m);
  }

  // click-to-inspect (also fills the fly destination box)
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (routeUIClick(e)) return; // dialog / HUD buttons eat the click first
    if (!downXY || !tileClickCb || !lastState) return;
    const dx = e.clientX - downXY[0], dy = e.clientY - downXY[1];
    if (dx * dx + dy * dy > 36) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ptr = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(ptr, camera);
    const hit = raycaster.intersectObjects(tileMeshes.map(t => t.mesh))[0];
    if (hit) tileClickCb(hit.object.userData.tileIndex, lastState);
  });

  new ResizeObserver(() => resize3D()).observe(container);
  resize3D();
  renderer.domElement.addEventListener('pointermove', routeUIHover);

  // gentle intro dolly into the Start-corner view
  const p0 = camera.position.clone(), p1 = CAM_POS.clone();
  tween(1.4, k => {
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(p0, p1, e);
  });

  renderer.setAnimationLoop(() => {
    stepTweens();
    // candle + fireplace flicker
    const ft = performance.now() / 1000;
    for (const f of flickers) {
      if (f.light) {
        f.light.intensity = f.base
          + Math.sin(ft * f.speed) * f.amp * 0.35
          + Math.sin(ft * f.speed * 2.7 + 1.3) * f.amp * 0.2;
      }
      const fs = 1 + 0.1 * Math.sin(ft * 11 + f.speed) + 0.05 * Math.sin(ft * 23 + f.speed * 2);
      for (const fl of f.flames) fl.s.scale.set(fl.bx * fs, fl.by * (2 - fs), 1);
    }
    if (targeting) { // pulse all flyable tiles
      const k = 0.35 + 0.3 * Math.sin(performance.now() / 240);
      tileMeshes.forEach((t, i) => {
        if (i === ISLAND_TILE) return;
        t.topMat.emissive.setHex(0x005577);
        t.topMat.emissiveIntensity = k;
      });
    }
    // name tags ride their tokens (even mid-hop); turn ring pulses under current
    for (let s = 0; s < tokenMeshes.length; s++) {
      const tk = tokenMeshes[s], tag = tokenTags[s];
      tag.visible = tk.visible;
      if (tk.visible) tag.position.set(tk.position.x, tk.position.y + 1.0, tk.position.z);
    }
    if (turnRing) {
      const tk = tokenMeshes[currentSeat];
      turnRing.visible = !!tk && tk.visible;
      if (turnRing.visible) {
        turnRing.position.set(tk.position.x, tk.position.y + 0.03, tk.position.z);
        turnRing.material.opacity = 0.55 + 0.35 * Math.sin(performance.now() / 300);
      }
    }
    // money eye candy: panel flash+pop, then rising +/- tickers
    const nowFx = performance.now();
    moneyFx = moneyFx.filter(fx => {
      const k = (nowFx - fx.start) / 700;
      const m = rosterPanels.find(r => r.seat === fx.seat);
      if (k >= 1) {
        if (m) { m.mesh.material.color.setHex(0xffffff); m.mesh.scale.setScalar(1); }
        return false;
      }
      if (m) {
        m.mesh.material.color.setHex(fx.tint).lerp(WHITE_TMP, k);
        m.mesh.scale.setScalar(1 + 0.12 * Math.sin(Math.PI * Math.min(1, k * 1.6)));
      }
      return true;
    });
    floaters = floaters.filter(f => {
      const k = (nowFx - f.start) / f.dur;
      if (k >= 1) {
        if (f.sprite.parent) f.sprite.parent.remove(f.sprite);
        f.sprite.material.map.dispose();
        f.sprite.material.dispose();
        return false;
      }
      f.sprite.position.y = f.y0 + k * 0.9;
      f.sprite.material.opacity = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
      return true;
    });
    controls.update();
    renderer.render(scene, camera);
  });
  ready = true;
}

export function resize3D() {
  if (!ready) return;
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth || 640, h = el.clientHeight || 560;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  layoutHUD(); // re-fit HUD to the new aspect
  layoutRoster(); // re-pin corner panels
}

export function resetView3D() {
  if (!ready) return;
  const p0 = camera.position.clone(), t0 = controls.target.clone();
  tween(0.8, k => {
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(p0, CAM_POS, e);
    controls.target.lerpVectors(t0, CAM_TGT, e);
  });
}

export function onTileClick3D(cb) { tileClickCb = cb; }

// ---------- tiny tween engine (driven by the render loop) ----------
let tweens = [];
function tween(dur, update) {
  return new Promise(res => tweens.push({ t: 0, dur, update, res }));
}
function stepTweens() {
  if (!tweens.length) return;
  const dt = 1 / 60;
  tweens = tweens.filter(tw => {
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    tw.update(k);
    if (k >= 1) { tw.res(); return false; }
    return true;
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- canvas textures ----------
function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function tileTexture(t, owner) {
  const band = t.type === "property"
    ? '#' + GROUP_COLORS[t.group].toString(16).padStart(6, '0')
    : '#' + (SPECIAL_COLORS[t.type] ?? 0x64748b).toString(16).padStart(6, '0');
  // flat top keeps only big at-a-glance facts; the name lives on the
  // camera-facing sprite (always readable, incl. from the Start corner)
  return canvasTex(256, (ctx, S) => {
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, S, 58);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px system-ui,sans-serif';
    ctx.fillText(`${t.index}`, 12, 41);
    ctx.textAlign = 'right';
    ctx.fillText(`S${t.side}`, S - 12, 41);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 34px system-ui,sans-serif';
    let y = 116;
    if (t.price) { ctx.fillText(`$${t.price}`, 12, y); y += 44; }
    if (t.rent != null) {
      ctx.fillStyle = '#b45309';
      ctx.fillText(`rent $${t.rent}`, 12, y);
    }
    if (owner) {
      ctx.fillStyle = owner.color;
      ctx.fillRect(0, S - 36, S, 36);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 23px system-ui,sans-serif';
      ctx.fillText(owner.name.slice(0, 12), 12, S - 9);
    }
  });
}

const TYPE_SHORT = {
  go: 'START +$200', chance: 'CHANCE', tax_agency: 'TAX · 10% NET',
  island: 'LOST ISLAND', tour: 'WORLD TOUR', championship: 'CHAMPIONSHIP',
  sender: 'STORM → ISLAND',
};

function segmentsLine(ctx, segs, cx, y, font) {
  ctx.font = font;
  const widths = segs.map(s => ctx.measureText(s.text).width);
  let x = cx - widths.reduce((a, b) => a + b, 0) / 2;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  segs.forEach((s, k) => { ctx.fillStyle = s.color; ctx.fillText(s.text, x, y); x += widths[k]; });
  ctx.textAlign = prev;
}

// Floating name plate: a sprite always faces the camera, so every city is
// readable from the Start-corner view (and any orbit angle).
function labelSprite(t, owner) {
  const band = t.type === 'property'
    ? '#' + GROUP_COLORS[t.group].toString(16).padStart(6, '0')
    : '#' + (SPECIAL_COLORS[t.type] ?? 0x64748b).toString(16).padStart(6, '0');
  const tex = rectTex(512, 224, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(2,6,23,0.88)';
    rr(ctx, 4, 4, W - 8, H - 8, 40);
    ctx.fill();
    ctx.strokeStyle = band;
    ctx.lineWidth = 10;
    rr(ctx, 10, 10, W - 20, H - 20, 32);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 56px system-ui,sans-serif';
    ctx.fillText(t.name.slice(0, 20), W / 2, 86);
    let segs;
    if (t.type === 'property') {
      segs = [];
      if (t.level === 4) segs.push({text: 'HOTEL ', color: '#fbbf24'});
      else if (t.level > 0) segs.push({text: `Lv${t.level} `, color: '#4ade80'});
      if (owner) {
        segs.push({text: `rent $${t.rent}`, color: '#fbbf24'});
        segs.push({text: ' · ', color: '#64748b'});
        segs.push({text: owner.name.slice(0, 10), color: owner.color});
      } else {
        segs.push({text: `$${t.price}`, color: '#4ade80'});
      }
      if (t.boost) segs.push({text: ` ★${t.boost}`, color: '#fbbf24'});
    } else {
      segs = [{text: TYPE_SHORT[t.type] || t.type, color: '#cbd5e1'}];
    }
    segmentsLine(ctx, segs, W / 2, 170, '46px system-ui,sans-serif');
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, transparent: true}));
  sp.scale.set(1.9, 1.9 * 224 / 512, 1);
  // push the plate outward from board center so tile middles stay clear for tokens
  const {x, z} = tileXZ(t.index);
  const ol = Math.hypot(x, z) || 1;
  sp.position.set(x + (x / ol) * 0.95, 1.28, z + (z / ol) * 0.95);
  return sp;
}

function pipTexture(v) {
  return canvasTex(128, (ctx, S) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, S, S, 22);
    else ctx.rect(0, 0, S, S);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    const P = [[0.5, 0.5], [0.28, 0.28], [0.72, 0.72], [0.72, 0.28], [0.28, 0.72], [0.28, 0.5], [0.72, 0.5]];
    const layout = { 1: [0], 2: [1, 2], 3: [1, 0, 2], 4: [1, 2, 3, 4], 5: [1, 2, 0, 3, 4], 6: [1, 2, 3, 4, 5, 6] }[v];
    for (const k of layout) {
      ctx.beginPath();
      ctx.arc(P[k][0] * S, P[k][1] * S, 11, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function centerTexture(state) {
  return canvasTex(512, (ctx, S) => {
    ctx.fillStyle = '#14532d';
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 10;
    ctx.strokeRect(18, 18, S - 36, S - 36);
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'center';
    ctx.font = 'bold 72px system-ui,sans-serif';
    ctx.fillText('MONOPOLY', S / 2, S / 2 - 30);
    ctx.fillStyle = '#fff';
    ctx.font = '30px system-ui,sans-serif';
    ctx.fillText(`round ${state.round} · hotel R${state.hotelUnlockRound}`, S / 2, S / 2 + 30);
    ctx.fillText(`resorts: ${state.constants.resortTiles.join(', ')}`, S / 2, S / 2 + 72);
  });
}

// ---------- state rendering ----------

const flickers = []; // candle/fireplace flicker: {light, base, amp, speed, flames:[{s,bx,by}]}

function woodTexture(base, dark) {
  return canvasTex(512, (ctx, S) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, S, S);
    const rows = 6;
    for (let r = 0; r < rows; r++) {
      const y = (r * S) / rows;
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,220,170,0.05)' : 'rgba(0,0,0,0.08)';
      ctx.fillRect(0, y, S, S / rows);
      for (let gl = 0; gl < 14; gl++) {
        ctx.strokeStyle = `rgba(30,15,5,${0.1 + Math.random() * 0.15})`;
        ctx.lineWidth = 1 + Math.random() * 2;
        ctx.beginPath();
        const gy = y + Math.random() * S / rows;
        ctx.moveTo(0, gy);
        for (let x = 0; x <= S; x += 32) ctx.lineTo(x, gy + Math.sin(x * 0.02 + gl) * 3 + (Math.random() - 0.5) * 3);
        ctx.stroke();
      }
      ctx.fillStyle = dark;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, y, S, 3);
      ctx.globalAlpha = 1;
    }
  });
}

let _flameTex = null;
function flameTexture() {
  if (_flameTex) return _flameTex;
  _flameTex = canvasTex(128, (ctx, S) => {
    const g = ctx.createRadialGradient(S / 2, S * 0.62, 4, S / 2, S * 0.55, S * 0.5);
    g.addColorStop(0, 'rgba(255,240,200,1)');
    g.addColorStop(0.35, 'rgba(255,180,80,0.9)');
    g.addColorStop(0.7, 'rgba(230,90,20,0.45)');
    g.addColorStop(1, 'rgba(120,30,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  });
  return _flameTex;
}

function flameSprite(bx, by) {
  const f = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flameTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  f.scale.set(bx, by, 1);
  f.renderOrder = 5;
  return {s: f, bx, by};
}

function candleCluster(x, z, withLight) {
  const grp = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({color: 0x8a6d2f, metalness: 0.7, roughness: 0.35});
  const wax = new THREE.MeshStandardMaterial({color: 0xf3e5c3, roughness: 0.6});
  const tray = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.08, 20), brass);
  tray.position.y = 0.04;
  grp.add(tray);
  const entry = {light: null, base: 0, amp: 0, speed: 9 + Math.random() * 4, flames: []};
  [0.5, 0.78, 0.36].forEach((h, i) => {
    const a = (i / 3) * Math.PI * 2;
    const cx = Math.cos(a) * 0.2, cz = Math.sin(a) * 0.2;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, h, 12), wax);
    c.position.set(cx, 0.08 + h / 2, cz);
    c.castShadow = true;
    grp.add(c);
    const fl = flameSprite(0.28, 0.42);
    fl.s.position.set(cx, 0.08 + h + 0.18, cz);
    grp.add(fl.s);
    entry.flames.push(fl);
  });
  if (withLight) {
    const pl = new THREE.PointLight(0xff9a3c, 14, 14, 2);
    pl.position.set(0, 1.4, 0);
    grp.add(pl);
    entry.light = pl;
    entry.base = 14;
    entry.amp = 3.5;
  }
  flickers.push(entry);
  grp.position.set(x, -0.2, z); // on the table top
  scene.add(grp);
}

function buildFireplace() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({color: 0x3b3b42, roughness: 0.95});
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 5.5), stone);
  base.position.y = 0.7;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.6, 7.5, 4.2), stone);
  hood.position.y = 1.4 + 3.75;
  const mantel = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.35, 5.8), stone);
  mantel.position.y = 2.6;
  const fireMat = new THREE.MeshBasicMaterial({color: 0xff7a1e});
  const fire = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.5), fireMat);
  fire.rotation.y = Math.PI / 2;
  fire.position.set(1.12, 0.9, 0);
  const logMat = new THREE.MeshStandardMaterial({color: 0x2a1608, roughness: 1});
  const log1 = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 2.6, 8), logMat);
  log1.rotation.x = Math.PI / 2;
  log1.position.set(0.7, 0.25, 0.3);
  const log2 = log1.clone();
  log2.position.set(0.7, 0.25, -0.4);
  g.add(base, hood, mantel, fire, log1, log2);
  const flames = [];
  for (const [fz, bx, by] of [[-0.5, 0.9, 1.2], [0.4, 1.1, 1.5]]) {
    const fl = flameSprite(bx, by);
    fl.s.position.set(0.75, 1.0, fz);
    g.add(fl.s);
    flames.push(fl);
  }
  const pl = new THREE.PointLight(0xff6a1a, 60, 42, 2);
  pl.position.set(3, 1.5, 0);
  g.add(pl);
  flickers.push({light: pl, base: 60, amp: 18, speed: 7, flames});
  g.position.set(-16, -6, 0); // on the floor, west side
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(g);
}

function barrel(x, z, s = 1) {
  const bmat = new THREE.MeshStandardMaterial({color: 0x6b4423, roughness: 0.8});
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.9 * s, 0.75 * s, 1.6 * s, 18), bmat);
  b.position.set(x, -6 + 0.8 * s, z);
  b.castShadow = true;
  scene.add(b);
  const bandMat = new THREE.MeshStandardMaterial({color: 0x222226, metalness: 0.6, roughness: 0.5});
  for (const by of [-0.5, 0.5]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.87 * s, 0.05, 8, 24), bandMat);
    band.rotation.x = Math.PI / 2;
    band.position.set(x, -6 + 0.8 * s + by * s, z);
    scene.add(band);
  }
}

function mug(x, z) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({color: 0x7a4a1e, roughness: 0.7});
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.55, 16), wood);
  body.position.y = 0.275;
  body.castShadow = true;
  g.add(body);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.05, 8, 16, Math.PI), wood);
  handle.position.set(0.28, 0.3, 0);
  handle.rotation.z = -Math.PI / 2;
  g.add(handle);
  const foam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.1, 16),
    new THREE.MeshStandardMaterial({color: 0xf5ead0, roughness: 0.9})
  );
  foam.position.y = 0.58;
  g.add(foam);
  g.position.set(x, -0.2, z); // on the table top
  scene.add(g);
}
function seatPos(tileIdx, seat) {
  const { x, z } = tileXZ(tileIdx);
  return new THREE.Vector3(x + SEAT_OFF[seat % 4][0], TILE_TOP, z + SEAT_OFF[seat % 4][1]);
}

function clearGroup(g) {
  while (g.children.length) g.remove(g.children[0]);
}

// owner flag materials, cached per color (all marker materials are shared,
// so marker rebuilds never leak)
const flagMats = new Map();
function flagMat(color) {
  if (!flagMats.has(color)) flagMats.set(color, new THREE.MeshStandardMaterial({color, roughness: 0.4}));
  return flagMats.get(color);
}

export function renderBoard3D(state) {
  if (!ready) return;
  lastState = state;
  const sig = JSON.stringify([
    state.board.map(t => [t.ownerId, t.level, t.boost, t.rent]),
    state.round, state.hotelUnlockRound,
    state.players.map(p => [p.color, p.bankrupt]),
  ]);
  if (sig !== boardSig) {
    boardSig = sig;
    state.board.forEach(t => {
      const owner = state.players.find(p => p.id === t.ownerId) || null;
      const old = tileMeshes[t.index].topMat.map;
      tileMeshes[t.index].topMat.map = tileTexture(t, owner);
      tileMeshes[t.index].topMat.needsUpdate = true;
      if (old) old.dispose();
      const mg = markerGroups[t.index];
      mg.children.forEach(m => { // label sprites own unique textures: free them
        if (m.isSprite) { if (m.material.map) m.material.map.dispose(); m.material.dispose(); }
      });
      clearGroup(mg);
      const { x, z } = tileXZ(t.index);
      for (let h = 0; h < Math.min(t.level, 3); h++) {
        const m = new THREE.Mesh(GEO.house, MAT.house);
        m.position.set(x - 0.3 + h * 0.3, TILE_TOP + 0.085, z - 0.36);
        m.castShadow = true;
        mg.add(m);
      }
      if (t.level >= 4) {
        const m = new THREE.Mesh(GEO.hotel, MAT.hotel);
        m.position.set(x, TILE_TOP + 0.19, z - 0.3);
        m.castShadow = true;
        const roof = new THREE.Mesh(GEO.roof, MAT.roof);
        roof.position.set(x, TILE_TOP + 0.42, z - 0.3);
        mg.add(m, roof);
      }
      for (let bIdx = 0; bIdx < t.boost; bIdx++) {
        const m = new THREE.Mesh(GEO.boost, MAT.boost);
        m.position.set(x - 0.25 + bIdx * 0.25, TILE_TOP + 0.1, z + 0.36);
        mg.add(m);
      }
      if (owner) {
        const pole = new THREE.Mesh(GEO.pole, MAT.pole);
        pole.position.set(x + 0.4, TILE_TOP + 0.27, z + 0.4);
        const flag = new THREE.Mesh(GEO.flag, flagMat(owner.color));
        flag.position.set(x + 0.4, TILE_TOP + 0.58, z + 0.4);
        mg.add(pole, flag);
      }
      const plate = labelSprite(t, owner); // camera-facing name plate
      plate.visible = platesVisible;
      mg.add(plate);
      plateSprites[t.index] = plate;
    });
  }
  const csig = `${state.round}|${state.hotelUnlockRound}|${state.constants.resortTiles.join(',')}`;
  if (csig !== centerSig) {
    centerSig = csig;
    if (centerMesh) {
      scene.remove(centerMesh);
      centerMesh.material.map.dispose();
      centerMesh.material.dispose();
    }
    centerMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 5.4),
      new THREE.MeshStandardMaterial({ map: centerTexture(state), roughness: 0.9 })
    );
    centerMesh.rotation.x = -Math.PI / 2;
    centerMesh.position.y = 0.005;
    centerMesh.receiveShadow = true;
    scene.add(centerMesh);
  }
  if (!tokenLock) {
    currentSeat = state.currentPlayerId
      ? Math.max(-1, state.players.findIndex(p => p.id === state.currentPlayerId))
      : -1;
    state.players.forEach((p, s) => {
      const g = tokenMeshes[s];
      g.visible = true;
      const pos = seatPos(p.position, s);
      g.position.copy(pos);
      const mat = g.userData.mat;
      mat.color.set(p.bankrupt ? 0x64748b : p.color);
      mat.emissive.set(p.bankrupt ? 0x000000 : p.color);
      mat.emissiveIntensity = p.bankrupt ? 0 : 0.45;
      mat.opacity = p.bankrupt ? 0.45 : 1;
      mat.transparent = p.bankrupt;
    });
    for (let s = state.players.length; s < 4; s++) tokenMeshes[s].visible = false;
  }
  // name-tag textures only change with roster/color/bankruptcy, not movement
  const tsig = JSON.stringify(state.players.map(p => [p.name, p.color, p.bankrupt]));
  if (tsig !== tagSig) {
    tagSig = tsig;
    state.players.forEach((p, s) => {
      const tag = tokenTags[s];
      const old = tag.material.map;
      tag.material.map = rectTex(256, 80, (ctx, W, H) => {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = p.bankrupt ? 'rgba(71,85,105,0.92)' : p.color;
        rr(ctx, 2, 2, W - 4, H - 4, 26);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = 'bold 44px system-ui,sans-serif';
        ctx.fillText((p.bankrupt ? '💀 ' : '') + p.name.slice(0, 10), W / 2, 55);
      });
      tag.material.needsUpdate = true;
      if (old) old.dispose();
    });
  }
  updateRoster3D(state); // corner name+money panels
}

export function setCursor3D(i) {
  if (!ready) return;
  if (cursor !== null) tileMeshes[cursor].topMat.emissive.setHex(0x000000);
  cursor = i;
  if (i !== null && tileMeshes[i]) tileMeshes[i].topMat.emissive.setHex(0x554400);
}

// ---------- animations ----------
export async function animateSteps3D(seat, path) {
  if (!ready || !path.length) return;
  tokenLock = true;
  const g = tokenMeshes[seat];
  g.visible = true;
  for (const tile of path) {
    setCursor3D(tile);
    const from = g.position.clone();
    const to = seatPos(tile, seat);
    await tween(0.13, k => {
      g.position.lerpVectors(from, to, k);
      g.position.y = TILE_TOP + Math.sin(Math.PI * k) * 0.38;
    });
  }
  setCursor3D(null);
  tokenLock = false;
}

export async function animateFly3D(seat, fromTile, toTile) {
  if (!ready) return;
  tokenLock = true;
  const g = tokenMeshes[seat];
  g.visible = true;
  const from = seatPos(fromTile, seat);
  const to = seatPos(toTile, seat);
  g.position.copy(from);
  setCursor3D(toTile);
  await tween(1.0, k => {
    g.position.lerpVectors(from, to, k);
    g.position.y = TILE_TOP + Math.sin(Math.PI * k) * 2.6;
  });
  setCursor3D(null);
  tokenLock = false;
}

// Dice materials are [+x, -x, +y, -y, +z, -z]; faces hold [1, 6, 2, 5, 3, 4].
// Rotate so the rolled value ends on top (+y), plus a random y-spin.
function finalDiceEuler(v, spin) {
  switch (v) {
    case 1: return new THREE.Euler(0, spin, Math.PI / 2, 'YXZ');
    case 6: return new THREE.Euler(0, spin, -Math.PI / 2, 'YXZ');
    case 2: return new THREE.Euler(0, spin, 0, 'YXZ');
    case 5: return new THREE.Euler(Math.PI, spin, 0, 'YXZ');
    case 3: return new THREE.Euler(-Math.PI / 2, spin, 0, 'YXZ');
    default: return new THREE.Euler(Math.PI / 2, spin, 0, 'YXZ');
  }
}

export async function showDice3D(d1, d2) {
  if (!ready) return;
  const vals = [d1, d2];
  const jobs = diceMeshes.map((m, k) => {
    const v = vals[k];
    m.material.forEach(f => { f.map = m.userData.pips[v - 1]; f.needsUpdate = true; });
    const end = new THREE.Vector3(-0.7 + k * 1.4 + (Math.random() - 0.5) * 0.3, 0.23, (Math.random() - 0.5) * 1.6);
    const start = new THREE.Vector3(end.x * 0.4, 4.5 + k, end.z * 0.4);
    const e0 = new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    const e1 = finalDiceEuler(v, Math.random() * Math.PI * 2);
    const q0 = new THREE.Quaternion().setFromEuler(e0);
    const q1 = new THREE.Quaternion().setFromEuler(e1);
    m.visible = true;
    m.position.copy(start);
    const spins = 2 + Math.floor(Math.random() * 2);
    return tween(0.9, t => {
      const e = 1 - Math.pow(1 - t, 3);
      m.position.lerpVectors(start, end, e);
      m.position.y += Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.9 * (1 - t);
      const q = new THREE.Quaternion().slerpQuaternions(q0, q1, e);
      const extra = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (1 - e) * spins * Math.PI * 2);
      m.quaternion.multiplyQuaternions(extra, q);
    });
  });
  await Promise.all(jobs);
  showSum3D(d1, d2); // short-lived floating total once the dice settle
  await wait(900);
  diceMeshes.forEach(m => { m.visible = false; });
}

// Short-lived floating dice total ("7", gold + DOUBLES! on doubles).
// Rides the existing floaters pipeline: rises, fades, disposes itself.
function showSum3D(d1, d2) {
  if (!ready) return;
  const sum = d1 + d2, dbl = d1 === d2;
  const tex = rectTex(512, 256, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = 'bold 150px system-ui,sans-serif';
    ctx.lineWidth = 14;
    ctx.strokeStyle = 'rgba(2,6,23,0.9)';
    ctx.strokeText(`${sum}`, W / 2, 158);
    ctx.fillStyle = dbl ? '#fbbf24' : '#ffffff';
    ctx.fillText(`${sum}`, W / 2, 158);
    ctx.font = 'bold 44px system-ui,sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(dbl ? 'DOUBLES!' : 'total', W / 2, 218);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, transparent: true, depthTest: false}));
  sp.scale.set(2.2, 1.1, 1);
  sp.renderOrder = 1002;
  sp.position.set(0, 1.1, UI_Z);
  uiRoot.add(sp);
  floaters.push({sprite: sp, seat: -1, y0: 1.1, start: performance.now(), dur: 1300});
}

// ================= in-3D UI: HUD action bar + modal dialogs =================
// Everything is attached to the camera so it stays readable while orbiting.
const ISLAND_TILE = 7;
const UI_Z = -7;            // camera-space depth of all UI
let uiRoot = null, hudGroup = null, dlgGroup = null;
let rosterGroup = null;       // corner money/name panels, one per player
let rosterPanels = [];        // {mesh, seat}
let rosterSig = '';
let rosterCount = 0;
let hudY = -2.62;
let rosterGameId = null;
let rosterMoney = [null, null, null, null]; // last seen cash per seat
let moneyFx = [];             // panel flash+pop: {seat, tint, start}
let floaters = [];            // rising delta tickers: {sprite, seat, y0, start, dur}
const WHITE_TMP = new THREE.Color(0xffffff);
let hudBtns = [];           // {id, mesh, enabled}
let dlgBtns = [];           // {id, mesh, enabled}
let dlgResolve = null;
let hudCb = null;
let targeting = false;

export function onHUDClick3D(cb) { hudCb = cb; }
export function isDialogOpen3D() { return dlgResolve !== null; }
export function setTargeting3D(on) {
  targeting = on;
  if (!ready) return;
  if (on) setCursor3D(null);
  else tileMeshes.forEach(t => { t.topMat.emissive.setHex(0x000000); t.topMat.emissiveIntensity = 1; });
}

function rectTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A clickable 3D button, width fitted to its label. Returns {mesh, w, h}.
function makeUIButton(label, sub, enabled, accent, h = 0.5) {
  const fs = 46;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `bold ${fs}px system-ui,sans-serif`;
  const tw = meas.measureText(label.slice(0, 26)).width;
  meas.font = '30px system-ui,sans-serif';
  const sw = sub ? meas.measureText(sub.slice(0, 34)).width : 0;
  const W = Math.ceil(Math.min(560, Math.max(tw, sw) + 96));
  const H = sub ? 132 : 100;
  const tex = rectTex(W, H, (ctx) => {
    ctx.clearRect(0, 0, W, H);
    rr(ctx, 3, 3, W - 6, H - 6, 22);
    ctx.fillStyle = enabled ? (accent || '#22c55e') : '#334155';
    ctx.fill();
    ctx.fillStyle = enabled ? '#06240f' : '#94a3b8';
    ctx.textAlign = 'center';
    ctx.font = `bold ${fs}px system-ui,sans-serif`;
    ctx.fillText(label.slice(0, 26), W / 2, sub ? 60 : 68);
    if (sub) {
      ctx.font = '30px system-ui,sans-serif';
      ctx.fillStyle = enabled ? '#052e16' : '#64748b';
      ctx.fillText(sub.slice(0, 34), W / 2, 104);
    }
  });
  const w = h * (W / H);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })
  );
  mesh.renderOrder = 1000;
  mesh.userData.isUI = true;
  return { mesh, w, h, tex };
}

function clearUIGroup(g) {
  while (g.children.length) {
    const m = g.children.pop();
    // UI meshes own unique geometry/material/texture -> dispose all
    if (m.geometry) m.geometry.dispose();
    if (m.material) {
      if (m.material.map) m.material.map.dispose();
      m.material.dispose();
    }
  }
}

// HUD: single contextual action row at the bottom of the view.
let lastHUDDefs = [];
export function updateHUD3D(defs) {
  if (!ready) return;
  lastHUDDefs = defs;
  clearUIGroup(hudGroup);
  hudBtns = [];
  for (const d of defs) {
    const b = makeUIButton(d.label, d.sub || '', d.enabled !== false, d.accent, 0.46);
    b.mesh.userData.hudId = d.id;
    b.mesh.userData.enabled = d.enabled !== false;
    hudGroup.add(b.mesh);
    hudBtns.push({ id: d.id, mesh: b.mesh, enabled: b.mesh.userData.enabled, w: b.w, h: b.h });
  }
  layoutHUD();
}

function layoutHUD() {
  if (!ready || !hudGroup || !hudBtns.length) return;
  const gap = 0.12;
  const total = hudBtns.reduce((s, b) => s + b.w, 0) + gap * (hudBtns.length - 1);
  let x = -total / 2;
  for (const b of hudBtns) {
    b.mesh.position.set(x + b.w / 2, hudY, UI_Z);
    x += b.w + gap;
  }
  // shrink to fit narrow windows
  const visW = 2 * Math.abs(UI_Z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
  hudGroup.scale.setScalar(Math.min(1, (visW * 0.96) / total));
}

// ---- corner roster: name + money per player (seats 0-3 -> corners) ----
function rosterTexture(p, isCurrent, mode) {
  return rectTex(512, 208, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(2,6,23,0.88)';
    rr(ctx, 4, 4, W - 8, H - 8, 34);
    ctx.fill();
    ctx.lineWidth = isCurrent ? 10 : 5;
    ctx.strokeStyle = isCurrent ? '#fbbf24' : '#334155';
    rr(ctx, 8, 8, W - 16, H - 16, 28);
    ctx.stroke();
    ctx.fillStyle = p.bankrupt ? '#475569' : p.color;
    rr(ctx, 22, 22, 26, H - 44, 13);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = p.bankrupt ? '#94a3b8' : '#fff';
    ctx.font = 'bold 50px system-ui,sans-serif';
    const status = `${isCurrent ? '👉' : ''}${p.inJail ? '🏝️' : ''}${p.tourPending ? '✈️' : ''}${p.bankrupt ? '💀' : ''}`;
    ctx.fillText(`${status}${p.name.slice(0, 10)}`, 64, 84);
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 56px system-ui,sans-serif';
    ctx.fillText(`$${p.money}`, 64, 158);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '32px system-ui,sans-serif';
    ctx.fillText(`net $${p.netWorth}${mode === 'team' ? ` · T${p.team + 1}` : ''}`, 64, 192);
  });
}

function updateRoster3D(state) {
  if (state.id !== rosterGameId) { // fresh game: learn balances silently
    rosterGameId = state.id;
    rosterMoney = state.players.map(p => p.money);
  }
  // detect cash deltas BEFORE the texture rebuild below
  const deltas = state.players.map((p, s) => {
    const old = rosterMoney[s];
    rosterMoney[s] = p.money;
    return (old === null || old === undefined || old === p.money) ? 0 : p.money - old;
  });
  const sig = JSON.stringify(state.players.map(p =>
    [p.name, p.color, p.money, p.netWorth, p.bankrupt, p.inJail, p.tourPending, p.team,
     state.currentPlayerId === p.id, state.mode]));
  if (sig !== rosterSig) {
    rosterSig = sig;
    while (rosterGroup.children.length) {
      const m = rosterGroup.children.pop();
      if (m.geometry) m.geometry.dispose();
      if (m.material) { if (m.material.map) m.material.map.dispose(); m.material.dispose(); }
    }
    rosterPanels = [];
    state.players.forEach((p, s) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2.3, 2.3 * 208 / 512),
        new THREE.MeshBasicMaterial({
          map: rosterTexture(p, state.currentPlayerId === p.id, state.mode),
          transparent: true, depthTest: false,
        })
      );
      mesh.renderOrder = 1000;
      mesh.userData.isUI = true;
      rosterGroup.add(mesh);
      rosterPanels.push({mesh, seat: s});
    });
  }
  rosterCount = state.players.length;
  hudY = rosterCount > 2 ? -1.85 : -2.62; // lift HUD when bottom corners are taken
  layoutRoster();
  layoutHUD();
  // eye candy: flash+pop the panel and float a +/- ticker for every change
  deltas.forEach((d, s) => { if (d !== 0) spawnMoneyFx(s, d); });
}

// Rising "+$200" / "-$50" ticker anchored to a roster panel, plus panel flash+pop.
function spawnMoneyFx(seat, delta) {
  if (!ready) return;
  const panel = rosterPanels.find(r => r.seat === seat);
  const gain = delta > 0;
  const tex = rectTex(512, 128, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.font = 'bold 84px system-ui,sans-serif';
    const s = `${gain ? '+' : ''}$${delta}`;
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(2,6,23,0.9)';
    ctx.strokeText(s, W / 2, 94);
    ctx.fillStyle = gain ? '#4ade80' : '#f87171';
    ctx.fillText(s, W / 2, 94);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, transparent: true, depthTest: false}));
  sp.scale.set(1.7, 1.7 * 128 / 512, 1);
  sp.renderOrder = 1001;
  const stack = floaters.filter(f => f.seat === seat).length;
  const base = panel ? panel.mesh.position : new THREE.Vector3(0, 2.2, UI_Z);
  sp.position.set(base.x, base.y + 0.75 + stack * 0.4, UI_Z);
  uiRoot.add(sp);
  floaters.push({sprite: sp, seat, y0: sp.position.y, start: performance.now(), dur: 1400});
  moneyFx.push({seat, tint: gain ? 0x4ade80 : 0xf87171, start: performance.now()});
}

export function setPlatesVisible3D(v) {
  platesVisible = v;
  if (!ready) return;
  for (const sp of plateSprites) if (sp) sp.visible = v;
}

function layoutRoster() {
  if (!ready || !rosterGroup) return;
  const hh = Math.abs(UI_Z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const hw = hh * camera.aspect;
  // seats 0..3 -> TL, TR, BL, BR
  const spots = [[-1, 1], [1, 1], [-1, -1], [1, -1]];
  for (const {mesh, seat} of rosterPanels) {
    const [sx, sy] = spots[seat % 4];
    mesh.position.set(sx * (hw - 1.15 - 0.22), sy * (hh - 0.47 - 0.22), UI_Z);
  }
}

// Dialog engine: title + optional big text + body lines + option buttons.
export function openDialog3D(spec) {
  if (!ready) return Promise.resolve(null);
  if (dlgResolve) { const r = dlgResolve; dlgResolve = null; try { r(null); } catch {} } // replace stale dialog
  controls.enabled = false;
  hudGroup.visible = false;
  return new Promise(resolve => { dlgResolve = resolve; buildDialog(spec); });
}

function buildDialog(spec) {
  clearUIGroup(dlgGroup);
  dlgGroup.userData.step = null;
  dlgBtns = [];
  const lines = (spec.lines || []).slice(0, 7);
  const titleH = 120, bigH = spec.big ? 200 : 0, lineH = 46;
  const pad = 50;
  const CH = Math.min(1024, titleH + bigH + lines.length * lineH + pad);
  const tex = rectTex(1024, CH, (ctx, W, H) => {
    ctx.fillStyle = 'rgba(30,41,59,0.97)';
    rr(ctx, 4, 4, W - 8, H - 8, 36);
    ctx.fill();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 6;
    rr(ctx, 10, 10, W - 20, H - 20, 30);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 68px system-ui,sans-serif';
    ctx.fillText((spec.title || '').slice(0, 30), W / 2, 88);
    let y = titleH;
    if (spec.big) {
      ctx.font = '150px system-ui,sans-serif';
      ctx.fillText(spec.big.slice(0, 12), W / 2, y + 150);
      y += bigH;
    }
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '36px system-ui,sans-serif';
    for (const ln of lines) { y += lineH; ctx.fillText(String(ln).slice(0, 52), W / 2, y); }
  });
  const panelW = 5.6, panelH = panelW * (CH / 1024);
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(panelW, panelH),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })
  );
  panel.renderOrder = 1000;
  dlgGroup.add(panel);

  const opts = spec.options || [];
  const gap = 0.1;
  const btnHs = opts.map(o => 0.55);
  const btnsH = btnHs.reduce((s, h) => s + h + gap, 0);
  const totalH = panelH + 0.25 + btnsH;
  panel.position.set(0, totalH / 2 - panelH / 2 + 0.35, UI_Z);
  let y = totalH / 2 - panelH - 0.25 + 0.35;
  opts.forEach((o, k) => {
    const b = makeUIButton(o.label, o.sub || o.reason || '', !o.disabled, o.accent, btnHs[k]);
    b.mesh.position.set(0, y - btnHs[k] / 2, UI_Z);
    y -= btnHs[k] + gap;
    b.mesh.userData.dlgId = o.id;
    b.mesh.userData.enabled = !o.disabled;
    dlgGroup.add(b.mesh);
    dlgBtns.push({ id: o.id, mesh: b.mesh, enabled: !o.disabled });
  });
  dlgGroup.position.set(0, 0, 0);
}

export function closeDialog3D(result) {
  if (!ready) return;
  const r = dlgResolve;
  dlgResolve = null;
  dlgBtns = [];
  dlgGroup.userData.step = null;
  clearUIGroup(dlgGroup);
  hudGroup.visible = true;
  controls.enabled = true;
  if (r) { try { r(result ?? null); } catch {} }
}

// Custom-dice picker: steppers for d1/d2 + confirm. Resolves {d1,d2} | null.
const PICK_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
export function openDicePick3D() {
  if (!ready) return Promise.resolve(null);
  if (dlgResolve) closeDialog3D(null);
  controls.enabled = false;
  hudGroup.visible = false;
  let d1 = 3, d2 = 4;
  return new Promise(resolve => {
    dlgResolve = resolve;
    // stepper layout: d1 pair left, d2 pair right, confirm/cancel below
    const redraw = () => {
      clearUIGroup(dlgGroup);
      dlgBtns = [];
      const tex = rectTex(1024, 420, (ctx, W, H) => {
        ctx.fillStyle = 'rgba(30,41,59,0.97)';
        rr(ctx, 4, 4, W - 8, H - 8, 36); ctx.fill();
        ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 6;
        rr(ctx, 10, 10, W - 20, H - 20, 30); ctx.stroke();
        ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
        ctx.font = 'bold 68px system-ui,sans-serif';
        ctx.fillText('⚙️ Custom die', W / 2, 88);
        ctx.font = '150px system-ui,sans-serif';
        ctx.fillText(`${PICK_FACES[d1]} ${PICK_FACES[d2]}`, W / 2, 260);
        ctx.fillStyle = '#cbd5e1'; ctx.font = '36px system-ui,sans-serif';
        ctx.fillText(`move exactly ${d1 + d2} tiles`, W / 2, 330);
        ctx.fillText(`d1 = ${d1}      d2 = ${d2}`, W / 2, 380);
      });
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(5.6, 5.6 * (420 / 1024)),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })
      );
      panel.renderOrder = 1000;
      dlgGroup.add(panel);
      const opts = [
        { id: 'd1-', label: 'd1 −' }, { id: 'd1+', label: 'd1 +' },
        { id: 'd2-', label: 'd2 −' }, { id: 'd2+', label: 'd2 +' },
        { id: 'ok', label: `▶ Roll ${d1 + d2}`, accent: '#22c55e' },
        { id: 'cancel', label: 'Cancel', accent: '#475569' },
      ];
      // two columns for steppers, full-width confirm/cancel
      const y0 = 0.4, rowH = 0.62;
      const put = (o, x, y, wScale) => {
        const b = makeUIButton(o.label, '', true, o.accent);
        if (wScale && wScale !== 1) { b.mesh.scale.x = wScale; }
        b.mesh.position.set(x, y, UI_Z);
        b.mesh.userData.dlgId = o.id;
        b.mesh.userData.enabled = true;
        dlgGroup.add(b.mesh);
        dlgBtns.push({ id: o.id, mesh: b.mesh, enabled: true });
      };
      panel.position.set(0, 1.55, UI_Z);
      put(opts[0], -1.7, -0.75); put(opts[1], -0.1, -0.75);
      put(opts[2], 1.7, -0.75); put(opts[3], 3.1 - 1.7 + 1.7, -0.75);
      put(opts[4], 0, -1.47); put(opts[5], 0, -2.19);
    };
    const step = id => {
      if (id === 'd1-') d1 = d1 > 1 ? d1 - 1 : 6;
      else if (id === 'd1+') d1 = d1 < 6 ? d1 + 1 : 1;
      else if (id === 'd2-') d2 = d2 > 1 ? d2 - 1 : 6;
      else if (id === 'd2+') d2 = d2 < 6 ? d2 + 1 : 1;
      else if (id === 'ok') { closeDialog3D({ d1, d2 }); return; }
      else { closeDialog3D(null); return; }
      redraw();
    };
    dlgGroup.userData.step = step;
    redraw();
  });
}

// ---- pointer routing: dialog buttons > HUD buttons > tiles ----
function ptrNDC(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1
  );
}

function routeUIClick(e) {
  if (!ready) return false;
  raycaster.setFromCamera(ptrNDC(e), camera);
  if (dlgResolve) {
    const hit = raycaster.intersectObjects(dlgBtns.map(b => b.mesh))[0];
    if (hit && hit.object.userData.enabled) {
      const id = hit.object.userData.dlgId;
      if (dlgGroup.userData.step && id.startsWith('d')) { dlgGroup.userData.step(id); }
      else { dlgGroup.userData.step = null; closeDialog3D(id); }
    }
    return true; // dialog eats all clicks
  }
  const hit = raycaster.intersectObjects(hudBtns.map(b => b.mesh))[0];
  if (hit && hit.object.userData.enabled && hudCb) {
    hudCb(hit.object.userData.hudId);
    return true;
  }
  return false;
}

function routeUIHover(e) {
  if (!ready) return;
  raycaster.setFromCamera(ptrNDC(e), camera);
  let list = dlgResolve ? dlgBtns : hudBtns;
  const hit = raycaster.intersectObjects(list.map(b => b.mesh))[0];
  renderer.domElement.style.cursor = hit && hit.object.userData.enabled ? 'pointer' : '';
  const scaleAll = (arr, id) => arr.forEach(b => {
    const on = hit && hit.object === b.mesh && b.enabled;
    b.mesh.scale.setScalar(on ? 1.1 : 1);
  });
  scaleAll(dlgResolve ? dlgBtns : hudBtns);
}
