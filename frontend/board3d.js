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
let markerGroups = [];    // per-tile THREE.Group (houses/hotel/boost/flag)
let tokenMeshes = [];     // per seat index
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
  scene.background = new THREE.Color(0x0f172a);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(CAM_POS.x - 5, CAM_POS.y + 5, CAM_POS.z - 5); // intro start

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAM_TGT);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 32;
  controls.maxPolarAngle = 1.35;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
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
    base: new THREE.CylinderGeometry(0.17, 0.2, 0.09, 16),
    head: new THREE.SphereGeometry(0.155, 18, 14),
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

  // base slab + ground
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(8 * PITCH + 0.7, 0.2, 8 * PITCH + 0.7),
    new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.9 })
  );
  slab.position.y = -0.1;
  slab.receiveShadow = true;
  scene.add(slab);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x020617, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.21;
  ground.receiveShadow = true;
  scene.add(ground);

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

  // tokens (4 seats max)
  for (let s = 0; s < 4; s++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, emissive: 0x111111 });
    const g = new THREE.Group();
    const base = new THREE.Mesh(GEO.base, mat);
    base.position.y = 0.045;
    const head = new THREE.Mesh(GEO.head, mat);
    head.position.y = 0.26;
    head.castShadow = true;
    g.add(base, head);
    g.visible = false;
    g.userData.mat = mat;
    scene.add(g);
    tokenMeshes.push(g);
  }

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

  // gentle intro dolly into the Start-corner view
  const p0 = camera.position.clone(), p1 = CAM_POS.clone();
  tween(1.4, k => {
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(p0, p1, e);
  });

  renderer.setAnimationLoop(() => {
    stepTweens();
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
  const band = t.type === 'property'
    ? '#' + GROUP_COLORS[t.group].toString(16).padStart(6, '0')
    : '#' + (SPECIAL_COLORS[t.type] ?? 0x64748b).toString(16).padStart(6, '0');
  return canvasTex(256, (ctx, S) => {
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, S, 44);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px system-ui,sans-serif';
    ctx.fillText(`#${t.index}`, 10, 31);
    ctx.textAlign = 'right';
    ctx.fillText(`S${t.side}`, S - 10, 31);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 25px system-ui,sans-serif';
    const words = t.name.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 12) { lines.push(cur.trim()); cur = w; }
      else cur += ' ' + w;
    }
    lines.push(cur.trim());
    lines.slice(0, 2).forEach((ln, k) => ctx.fillText(ln, 10, 76 + k * 29));
    ctx.fillStyle = '#475569';
    ctx.font = '21px system-ui,sans-serif';
    let y = 140;
    if (t.price) { ctx.fillText(`$${t.price}`, 10, y); y += 26; }
    if (t.rent != null) { ctx.fillText(`rent $${t.rent}`, 10, y); y += 26; }
    if (t.level === 4) {
      ctx.fillStyle = '#b45309';
      ctx.font = 'bold 24px system-ui,sans-serif';
      ctx.fillText('HOTEL', 10, y); y += 26;
    } else if (t.level > 0) {
      ctx.fillStyle = '#15803d';
      ctx.font = 'bold 24px system-ui,sans-serif';
      ctx.fillText('H'.repeat(t.level) + ` Lv${t.level}`, 10, y); y += 26;
    }
    if (t.boost) {
      ctx.fillStyle = '#b45309';
      ctx.font = 'bold 24px system-ui,sans-serif';
      ctx.fillText('★'.repeat(t.boost), 10, y);
    }
    if (owner) {
      ctx.fillStyle = owner.color;
      ctx.fillRect(0, S - 34, S, 34);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 21px system-ui,sans-serif';
      ctx.fillText(owner.name.slice(0, 12), 10, S - 9);
    }
  });
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
function seatPos(tileIdx, seat) {
  const { x, z } = tileXZ(tileIdx);
  return new THREE.Vector3(x + SEAT_OFF[seat % 4][0], TILE_TOP, z + SEAT_OFF[seat % 4][1]);
}

function clearGroup(g) {
  while (g.children.length) g.remove(g.children[0]);
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
        const flag = new THREE.Mesh(GEO.flag, new THREE.MeshStandardMaterial({ color: owner.color, roughness: 0.4 }));
        flag.position.set(x + 0.4, TILE_TOP + 0.58, z + 0.4);
        mg.add(pole, flag);
      }
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
    state.players.forEach((p, s) => {
      const g = tokenMeshes[s];
      g.visible = true;
      const pos = seatPos(p.position, s);
      g.position.copy(pos);
      const mat = g.userData.mat;
      mat.color.set(p.bankrupt ? 0x64748b : p.color);
      mat.opacity = p.bankrupt ? 0.45 : 1;
      mat.transparent = p.bankrupt;
    });
    for (let s = state.players.length; s < 4; s++) tokenMeshes[s].visible = false;
  }
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
  await wait(900);
  diceMeshes.forEach(m => { m.visible = false; });
}
