// 3D Monopoly board (Three.js). The whole site is a single WebGL canvas:
// tavern room, board, pawns, four seated characters and a seat / freecam rig.
// All game rules stay server-side; this module only renders state + animates.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { buildRoom, buildTable, barrel, mug, shelf, chalkboard, cards, dust, tex2d, roundRect, setAnisotropy } from './env3d.js';
import {
  buildCharacters, updateCharTag, setCharActive, stepCharacters,
  SEAT_SPOTS, CHAR_SCALE, FLOOR_Y,
} from './chars3d.js';

// seated eye height in world units (the model's eye landmark, floor-relative)
const SEAT_EYE = FLOOR_Y + 1.45 * CHAR_SCALE;
const TABLE_TOP = -0.3;    // top surface of the tavern table

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
  tour: 0x0284c7, championship: 0xeab308, sender: 0x334155,
};
const SEAT_OFF = [[-0.26, -0.26], [0.26, -0.26], [-0.26, 0.26], [0.26, 0.26]];

const GROUP_NAMES = {
  brown: 'OLD TOWN', cyan: 'NEON', pink: 'SAKURA', orange: 'EMBER',
  red: 'RUBY', green: 'PINE', blue: 'AZURE', resort: 'RESORTS',
};
const TYPE_INFO = {
  go: ['▶', 'START', '+$200 & A LAP'],
  chance: ['?', 'CHANCE', 'LUCK OF THE DRAW'],
  tax_agency: ['%', 'TAX', '10% OF NET WORTH'],
  island: ['▲', 'LOST ISLAND', 'DOUBLES OR $150'],
  tour: ['✈', 'WORLD TOUR', '$100 · THEN FLY'],
  championship: ['★', 'CHAMPIONSHIP', '+1 RENT BOOST'],
  sender: ['☁', 'STORM', 'SENT TO ISLAND'],
};

let renderer, scene, camera, controls, raycaster;
let tileMeshes = [];      // per-tile {mesh, topMat}
let markerGroups = [];    // per-tile THREE.Group (houses/hotel/boost/flag/label)
let plateSprites = [];    // per-tile label sprite (toggleable)
let platesVisible = true;
let tokenMeshes = [];
let turnRing = null;
let currentSeat = -1;
let mySeat = -1;
let diceMeshes = [];
let centerMesh = null, centerSig = '';
let boardSig = '';
let cursor = null;
let tokenLock = false;
let tileClickCb = null;
let seatClickCb = null;
let lastState = null;
let ready = false;
let chars = [];
let stepDust = null;

// ui bridge (set by attachUI): keeps dialogs able to freeze the camera
let UI = null;

let GEO = {};
const MAT = {};

function tileColRow(i) {
  if (i <= 7) return { col: i, row: 0 };
  if (i <= 13) return { col: 7, row: i - 7 };
  if (i <= 21) return { col: 7 - (i - 14), row: 7 };
  return { col: 0, row: 6 - (i - 22) };
}

function tileXZ(i) {
  const { col, row } = tileColRow(i);
  return { x: (col - 3.5) * PITCH, z: (row - 3.5) * PITCH };
}

// Start tile (index 0) sits at the min-x/min-z corner.
const START_XZ = tileXZ(0);
// freecam home: high over the Start corner, whole table + characters in frame
const CAM_POS = new THREE.Vector3(START_XZ.x - 6, 15, START_XZ.z - 6);
const CAM_TGT = new THREE.Vector3(0, -1.6, 0);

// ---------------- camera rig: freecam (orbit) + on-model (first person) -----
const CAM = {
  mode: 'free',          // 'free' | 'seat'
  seat: 0,               // which character's head the camera rides
  yaw: 0, pitch: -0.22,  // look angles while seated
  zoom: 0.55,            // 0..1 seated eye height blend
  blend: 0,              // 0 = freecam pose, 1 = seated pose
  freePos: new THREE.Vector3(),
  freeTgt: new THREE.Vector3(),
  freeQuat: new THREE.Quaternion(),
  keys: {},
  looking: false, lastX: 0, lastY: 0,
  focus: null,           // {tile, start} camera move toward a tile
};
const TMP_V = new THREE.Vector3();
const TMP_V2 = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();
const TMP_M = new THREE.Matrix4();

// eye position of a seated character (rises with the in-chair bounce)
function seatEye(seat, out = new THREE.Vector3()) {
  const spot = SEAT_SPOTS[seat];
  out.set(spot.x, SEAT_EYE + 1.4 + CAM.zoom * 2.2, spot.z);
  const c = chars[seat];
  if (c) out.y += (c.outer.position.y - FLOOR_Y); // ride the idle bob
  return out;
}
function seatDir(out = new THREE.Vector3()) {
  const cp = Math.cos(CAM.pitch);
  return out.set(Math.sin(CAM.yaw) * cp, Math.sin(CAM.pitch), Math.cos(CAM.yaw) * cp);
}

export function getCameraMode3D() { return CAM.mode; }
export function getViewSeat3D() { return CAM.seat; }

export function setViewSeat3D(seat, jump = false) {
  if (seat < 0 || seat > 3) return;
  CAM.seat = seat;
  const base = SEAT_SPOTS[seat].yaw;
  CAM.yaw = base; CAM.pitch = -0.22;
  chars.forEach((c, s) => { c.highlight = s === seat ? 1 : 0; });
  if (CAM.mode !== 'seat') {
    // freecam: orbit the new character's shoulder instead of jumping
    orbitAroundSeat(seat, jump);
    return;
  }
  if (jump) CAM.blend = 1;
}

// Freecam parks over the selected character's shoulder, table in frame.
function orbitAroundSeat(seat, jump) {
  const spot = SEAT_SPOTS[seat];
  const back = new THREE.Vector3(Math.sin(spot.yaw), 0, Math.cos(spot.yaw));
  const p = new THREE.Vector3(
    spot.x + back.x * 3.6,
    SEAT_EYE + 3.4,
    spot.z + back.z * 3.6
  );
  const from = { p: camera.position.clone(), t: controls.target.clone() };
  if (jump) {
    camera.position.copy(p);
    controls.target.set(0, 0.2, 0);
    controls.update();
    return;
  }
  tween(0.7, k => {
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(from.p, p, e);
    controls.target.lerpVectors(from.t, CAM_TGT, e);
  });
}

export function cycleViewSeat3D() {
  setViewSeat3D((CAM.seat + 1) % 4);
  return CAM.seat;
}

export function setCameraMode3D(mode) {
  if (mode === CAM.mode) return;
  if (mode === 'seat') {
    // remember where freecam was so switching back is lossless
    CAM.freePos.copy(camera.position);
    CAM.freeTgt.copy(controls.target);
    CAM.freeQuat.copy(camera.quaternion);
    controls.enabled = false;
    CAM.yaw = SEAT_SPOTS[CAM.seat].yaw;
    CAM.pitch = -0.22;
    tween(0.75, k => { CAM.blend = k; });
    CAM.mode = 'seat';
  } else {
    CAM.mode = 'free';
    tween(0.75, k => { CAM.blend = 1 - k; }).then(() => {
      if (CAM.mode !== 'free') return;
      camera.position.copy(CAM.freePos);
      controls.target.copy(CAM.freeTgt);
      camera.lookAt(CAM.freeTgt);
      controls.enabled = true;
      controls.update();
    });
  }
  syncCharNeck();
}

function syncCharNeck() {
  // riding a character: hide its head (you are the head), show it otherwise
  chars.forEach((c, s) => {
    c.neck.visible = !(CAM.mode === 'seat' && s === CAM.seat);
    c.ride = CAM.mode === 'seat' && s === CAM.seat;
  });
}

// Point the seated view (or the orbit pivot) at a specific tile.
export function focusTile3D(idx, jump = false) {
  const { x, z } = tileXZ(idx);
  if (CAM.mode === 'seat') {
    CAM.yaw = Math.atan2(x - CAM_TGT.x, z - CAM_TGT.z);
    CAM.pitch = -0.1;
    return;
  }
  const t = new THREE.Vector3(x, 0.4, z);
  const from = { p: camera.position.clone(), t: controls.target.clone() };
  const dir = TMP_V.copy(camera.position).sub(controls.target).normalize();
  const dist = Math.max(4.5, Math.min(9, camera.position.distanceTo(controls.target)));
  const to = t.clone().add(dir.multiplyScalar(dist));
  if (jump) {
    camera.position.copy(to); controls.target.copy(t); controls.update();
  } else tween(0.7, k => {
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(from.p, to, e);
    controls.target.lerpVectors(from.t, t, e);
  });
}

// ---------------- scene ----------------
export function initBoard3D(container) {
  if (ready) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  container.appendChild(renderer.domElement);
  setAnisotropy(renderer.capabilities.getMaxAnisotropy());

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0906);
  scene.fog = new THREE.Fog(0x0b0906, 34, 96);

  camera = new THREE.PerspectiveCamera(52, 1, 0.05, 260);
  camera.position.set(CAM_POS.x - 8, CAM_POS.y + 9, CAM_POS.z - 8);

  // the camera joins the scene graph so its attached UI children render
  scene.add(camera);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAM_TGT);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3.2;
  controls.maxDistance = 40;
  controls.maxPolarAngle = 1.44;
  controls.enablePan = false;

  // ---- room + table ----
  buildRoom(scene);
  buildTable(scene);

  // ---- lighting: chandelier key, candles, fireplace, moon through a window ----
  scene.add(new THREE.HemisphereLight(0xffdcb0, 0x1a120a, 0.32));
  scene.add(new THREE.AmbientLight(0xffd9a8, 0.16));
  const sun = new THREE.DirectionalLight(0xffd2a0, 0.8);
  sun.position.set(7, 16, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -14; sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
  sun.shadow.bias = -0.0012;
  sun.shadow.radius = 2;
  scene.add(sun);
  const moon = new THREE.DirectionalLight(0x86b4ff, 0.34);
  moon.position.set(-16, 10, -13);
  scene.add(moon);

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
    side: new THREE.MeshStandardMaterial({ color: 0x2b1e14, roughness: 0.85 }),
    house: new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.6 }),
    hotel: new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 }),
    roof: new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.4, metalness: 0.4 }),
    boost: new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.3, metalness: 0.6, emissive: 0x664400 }),
    pole: new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.5 }),
  });

  // ---- candles, chandelier, fireplace, props ----
  chandelier(0, 8.2);
  candleCluster(-5.2, -5.2, true);
  candleCluster(5.2, -5.2, true);
  candleCluster(-5.2, 5.2, false);
  candleCluster(5.2, 5.2, false);
  buildFireplace();
  window_(-13.5, 5.4, -6);
  window_(13.5, 5.4, 6);
  shelf(scene, -25.2, 4.2, 4, Math.PI / 2);
  shelf(scene, -25.2, 5.5, 4, Math.PI / 2);
  shelf(scene, 12, 4.4, -25.2, 0);
  chalkboard(scene, 4, 5.2, -25.1, 0);
  barrel(-9.5, -6, -9, 1.2);
  barrel(-11.4, -6, -7.4, 0.9);
  barrel(9.8, -6, 9.2, 1.15);
  barrel(11.6, -6, 7.6, 0.95);
  mug(5.1, -0.28, 2.2);
  mug(-2.2, -0.28, 5.1);
  mug(6.0, -0.28, -1.4);
  cards(scene);
  stepDust = dust(scene, flickers);

  // ---- tiles ----
  raycaster = new THREE.Raycaster();
  for (let i = 0; i < N; i++) {
    const { x, z } = tileXZ(i);
    const topMat = new THREE.MeshStandardMaterial({ roughness: 0.62 });
    const mesh = new THREE.Mesh(GEO.tile, [MAT.side, MAT.side, topMat, MAT.side, MAT.side, MAT.side]);
    mesh.position.set(x, TILE_TOP / 2, z);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData.tileIndex = i;
    scene.add(mesh);
    tileMeshes.push({ mesh, topMat });
    const mg = new THREE.Group();
    scene.add(mg);
    markerGroups.push(mg);
  }

  // ---- tokens: pawns with a floating name tag ----
  const collarMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  for (let s = 0; s < 4; s++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, emissive: 0x111111, emissiveIntensity: 0.4 });
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
    // no name sprite on the pawn: the seated character above already carries
    // the name, and two labels per player is noise on a 28-tile board
  }

  // pulsing ring under the player whose turn it is
  turnRing = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.42, 32),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false })
  );
  turnRing.rotation.x = -Math.PI / 2;
  turnRing.renderOrder = 999;
  turnRing.visible = false;
  scene.add(turnRing);

  // dice (hidden until a roll)
  const pipTex = [];
  for (let v = 1; v <= 6; v++) pipTex.push(pipTexture(v));
  for (let d = 0; d < 2; d++) {
    const mats = [];
    for (let f = 0; f < 6; f++) mats.push(new THREE.MeshStandardMaterial({ roughness: 0.35 }));
    const m = new THREE.Mesh(GEO.die, mats);
    m.castShadow = true;
    m.visible = false;
    m.userData.pips = pipTex;
    scene.add(m);
    diceMeshes.push(m);
  }

  // ---- the four players, seated around the table ----
  chars = buildCharacters(scene, 0);
  syncCharNeck();

  // ---- pointer: click a tile to inspect, click a character to ride ----
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', e => {
    downXY = [e.clientX, e.clientY];
    if (CAM.mode === 'seat' && !UI?.isDialogOpen?.()) { CAM.looking = true; CAM.lastX = e.clientX; CAM.lastY = e.clientY; }
  });
  renderer.domElement.addEventListener('pointermove', e => {
    if (CAM.looking && CAM.mode === 'seat') {
      CAM.yaw -= (e.clientX - CAM.lastX) * 0.005;
      CAM.pitch = Math.max(-0.62, Math.min(0.5, CAM.pitch - (e.clientY - CAM.lastY) * 0.004));
      CAM.lastX = e.clientX; CAM.lastY = e.clientY;
    }
    UI?.routeHover?.(e);
  });
  window.addEventListener('pointerup', () => { CAM.looking = false; });
  renderer.domElement.addEventListener('wheel', e => {
    if (CAM.mode !== 'seat') return;      // freecam: OrbitControls zooms
    e.preventDefault();
    CAM.zoom = Math.max(0, Math.min(1, CAM.zoom - Math.sign(e.deltaY) * 0.12));
  }, { passive: false });

  renderer.domElement.addEventListener('pointerup', e => {
    if (UI?.routeClick?.(e)) { downXY = null; return; }
    if (!downXY) return;
    const dx = e.clientX - downXY[0], dy = e.clientY - downXY[1];
    downXY = null;
    if (dx * dx + dy * dy > 36) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ptr = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(ptr, camera);
    if (!lastState) return;
    // one raycast over tiles and characters: whichever is genuinely nearer
    // wins, so a character never steals a click meant for a tile beside it
    const targets = tileMeshes.map(t => t.mesh).concat(chars.map(c => c.pick));
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return;
    if (hit.object.userData.seat !== undefined && seatClickCb) {
      seatClickCb(hit.object.userData.seat);
    } else if (hit.object.userData.tileIndex !== undefined && tileClickCb) {
      tileClickCb(hit.object.userData.tileIndex, lastState);
    }
  });

  window.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === ' ') e.preventDefault();
    CAM.keys[e.key] = true;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.preventDefault();
  });
  window.addEventListener('keyup', e => { CAM.keys[e.key] = false; });

  new ResizeObserver(() => resize3D()).observe(container);
  resize3D();

  // gentle intro dolly into the Start-corner view
  const p0 = camera.position.clone(), p1 = CAM_POS.clone();
  tween(1.4, k => {
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(p0, p1, e);
  });

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    // real elapsed time, so animations keep their wall-clock duration even
    // when the GPU is slow and frames are rare
    stepTweens(Math.min(0.1, dt));
    stepFlickers(t);
    if (stepDust) stepDust(t);
    if (targeting) { // pulse all flyable tiles
      const k = 0.35 + 0.3 * Math.sin(now / 240);
      tileMeshes.forEach((t2, i) => {
        if (i === ISLAND_TILE) return;
        t2.topMat.emissive.setHex(0x005577);
        t2.topMat.emissiveIntensity = k;
      });
    }
    // the turn ring pulses under whoever is about to roll
    if (turnRing) {
      const tk = tokenMeshes[currentSeat];
      turnRing.visible = !!tk && tk.visible;
      if (turnRing.visible) {
        turnRing.position.set(tk.position.x, tk.position.y + 0.03, tk.position.z);
        turnRing.material.opacity = 0.55 + 0.35 * Math.sin(now / 300);
      }
    }
    updateCamera(dt);
    updatePlateFade();
    stepCharacters(chars, t, CAM.mode === 'seat' ? null : camera.position, dt);
    stepConfetti(dt);
    UI?.step?.(now);
    controls.update();
    renderer.render(scene, camera);
  });
  ready = true;
}

// ---------------- per-frame camera ----------------
function updateCamera(dt) {
  if (CAM.mode === 'seat') {
    // keyboard look (locked while a modal dialog owns the view)
    const sp = 1.6 * dt;
    const k = CAM.keys;
    if (!UI?.isDialogOpen?.()) {
      if (k.ArrowLeft || k.a) CAM.yaw += sp;
      if (k.ArrowRight || k.d) CAM.yaw -= sp;
      if (k.ArrowUp || k.w) CAM.pitch = Math.min(0.5, CAM.pitch + sp * 0.7);
      if (k.ArrowDown || k.s) CAM.pitch = Math.max(-0.62, CAM.pitch - sp * 0.7);
    }
    // seated pose: eye at the character, looking where we steer
    const eye = seatEye(CAM.seat, TMP_V);
    seatDir(TMP_V2);
    const target = eye.clone().add(TMP_V2.clone().multiplyScalar(8));
    TMP_M.lookAt(eye, target, camera.up);
    TMP_Q.setFromRotationMatrix(TMP_M);
    camera.position.lerpVectors(CAM.freePos, eye, CAM.blend);
    camera.quaternion.slerpQuaternions(CAM.freeQuat, TMP_Q, CAM.blend);
    // the ridden character's head mirrors our look direction
    const c = chars[CAM.seat];
    if (c) {
      let yaw = CAM.yaw - c.spot.yaw;
      yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      c.headYaw = yaw;
      c.headPitch = Math.max(-0.42, Math.min(0.3, -CAM.pitch));
    }
  } else if (CAM.blend > 0) {
    // blending back out to the freecam pose
    camera.position.lerpVectors(seatEye(CAM.seat, TMP_V), CAM.freePos, 1 - CAM.blend);
  } else if (controls.enabled) {
    // never let the orbit camera rise through the tavern ceiling, and keep it
    // over the table so the room stays framed
    const r = Math.hypot(camera.position.x, camera.position.z);
    if (r > 21) {
      camera.position.x *= 21 / r;
      camera.position.z *= 21 / r;
    }
    if (camera.position.y > 11.5) camera.position.y = 11.5;
  }
}

// ---------------- resize / view ----------------
export function resize3D() {
  if (!ready) return;
  const el = renderer.domElement.parentElement;
  const w = el.clientWidth || 640, h = el.clientHeight || 560;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  UI?.onResize?.(w, h);
}

export function resetView3D() {
  if (!ready) return;
  if (CAM.mode === 'seat') { setCameraMode3D('free'); return; }
  const p0 = camera.position.clone(), t0 = controls.target.clone();
  tween(0.8, k => {
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(p0, CAM_POS, e);
    controls.target.lerpVectors(t0, CAM_TGT, e);
  });
}

export function onTileClick3D(cb) { tileClickCb = cb; }
export function onSeatClick3D(cb) { seatClickCb = cb; }
export function getRenderer3D() { return renderer; }
export function getCamera3D() { return camera; }
// The tile tops carry the numbers that matter (price / rent / level), so the
// floating name plates are a labels-on switch, not the default. They also fade
// out as the camera closes in: up close they would swamp the view.
const PLATE_FADE = [11, 17];   // distance range over which they appear
function updatePlateFade() {
  if (!ready) return;
  for (const sp of plateSprites) {
    if (!sp) continue;
    if (!platesVisible) { sp.visible = false; continue; }
    const d = camera.position.distanceTo(sp.position);
    const a = THREE.MathUtils.clamp((d - PLATE_FADE[0]) / (PLATE_FADE[1] - PLATE_FADE[0]), 0, 1);
    sp.visible = a > 0.03;
    sp.material.opacity = a;
  }
}

export function setPlatesVisible3D(v) {
  platesVisible = v;
  updatePlateFade();
}

// The full per-tile label, used when the labels switch is on.
export function getPlatesVisible3D() { return platesVisible; }

// ---------------- tiny tween engine (driven by the render loop) ----------
let tweens = [];
function tween(dur, update) {
  return new Promise(res => tweens.push({ t: 0, dur, update, res }));
}
function stepTweens(dt) {
  if (!tweens.length) return;
  tweens = tweens.filter(tw => {
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    tw.update(k);
    if (k >= 1) { tw.res(); return false; }
    return true;
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------------- canvas textures ----------------
function pipTexture(v) {
  return tex2d(128, (ctx, S) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, S, S, 22); else ctx.rect(0, 0, S, S);
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

function wrapText(ctx, text, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (ctx.measureText((cur + ' ' + w).trim()).width > maxW && cur) { lines.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// Each side of the board is read from the player sitting at it, so the tile
// artwork is spun to face outward. Rotating the map (not the mesh) keeps the
// text crisp and lets the same geometry serve every tile.
//
// From the box's top face: uv-u runs along +x, uv-v along -z. With three's
// uv transform, content-right lands on (cos θ, sin θ) in (x, z) and
// content-up on (-sin θ, -cos θ). Solving for each seat's read direction:
//   north row -> 180°,  south row -> 0°,  west column -> 90°,  east -> -90°.
function tileFacing(i) {
  const { col, row } = tileColRow(i);
  if (row === 0) return Math.PI;
  if (row === 7) return 0;
  if (col === 0) return Math.PI / 2;
  return -Math.PI / 2;
}

// The printed tile top is the readable surface at table distance: big sticker
// price, index, side, group band, owner strip. The rent an individual owes
// depends on houses, boosts and who steps on it, so it is deliberately NOT
// printed here — each player's holdings panel shows what *they* would pay.
function tileTexture(t, owner) {
  const band = '#' + (t.type === 'property' ? GROUP_COLORS[t.group] : (SPECIAL_COLORS[t.type] ?? 0x64748b))
    .toString(16).padStart(6, '0');
  return tex2d(1024, 1024, (ctx, S) => {
    // paper
    ctx.fillStyle = '#fbf8f1'; ctx.fillRect(0, 0, S, S);
    const gr = ctx.createLinearGradient(0, 0, S, S);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(1, 'rgba(210,200,180,0.55)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
    // group band
    ctx.fillStyle = band; ctx.fillRect(0, 0, S, 216);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(0, 0, S, 60);
    // index + side, big and legible
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 132px system-ui,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(t.index), 34, 152);
    ctx.font = '800 72px system-ui,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`SIDE ${t.side}`, S - 34, 100);
    if (t.type === 'property') {
      ctx.font = '700 58px system-ui,sans-serif';
      ctx.fillText((GROUP_NAMES[t.group] || '').slice(0, 10), S - 34, 172);
    }
    ctx.textAlign = 'left';
    // name
    ctx.fillStyle = '#0b1220';
    ctx.font = '800 116px system-ui,sans-serif';
    const nameLines = wrapText(ctx, t.name.toUpperCase(), S - 72).slice(0, 2);
    nameLines.forEach((ln, k) => {
      const y = 216 + 132 + k * 122;
      ctx.lineWidth = 14; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(ln, 36, y);
      ctx.fillText(ln, 36, y);
    });
    if (t.type === 'property') {
      let y = 216 + 132 + nameLines.length * 122 + 30;
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(36, y - 96); ctx.lineTo(S - 36, y - 96); ctx.stroke();
      // only the sticker price is printed on the tile: what a tenant actually
      // pays changes with houses, boosts and who steps on it, so that lives in
      // the player's holdings panel instead of on the board
      ctx.fillStyle = '#166534';
      ctx.font = '800 168px system-ui,sans-serif';
      ctx.fillText(`$${t.price}`, 36, y + 72);
      ctx.fillStyle = '#64748b';
      ctx.font = '800 62px system-ui,sans-serif';
      ctx.fillText('STICKER PRICE', 36, y + 156);
      if (t.level) {
        ctx.fillStyle = t.level >= 4 ? '#b91c1c' : '#15803d';
        ctx.font = '800 84px system-ui,sans-serif';
        ctx.fillText(t.level >= 4 ? '🏨 HOTEL' : `HOMES Lv${t.level}`, 36, y + 254);
      }
    } else {
      const [glyph, title, sub] = TYPE_INFO[t.type] || ['?', t.type.toUpperCase(), ''];
      let y = 216 + 132 + nameLines.length * 122 + 40;
      ctx.textAlign = 'center';
      ctx.fillStyle = band;
      ctx.font = '800 250px system-ui,sans-serif';
      ctx.fillText(glyph, S / 2, y + 96);
      ctx.fillStyle = '#0b1220';
      ctx.font = '800 96px system-ui,sans-serif';
      ctx.fillText(title, S / 2, y + 210);
      if (sub) {
        ctx.fillStyle = '#475569';
        ctx.font = '700 70px system-ui,sans-serif';
        ctx.fillText(sub, S / 2, y + 292);
      }
      ctx.textAlign = 'left';
    }
    // owner strip
    if (owner) {
      ctx.fillStyle = owner.color; ctx.fillRect(0, S - 116, S, 116);
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, S - 116, S, 12);
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 78px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(owner.name.slice(0, 12).toUpperCase(), S / 2, S - 36);
      ctx.textAlign = 'left';
    }
  });
}

function segmentsLine(ctx, segs, cx, y, font) {
  ctx.font = font;
  const widths = segs.map(s => ctx.measureText(s.text).width);
  let x = cx - widths.reduce((a, b) => a + b, 0) / 2;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  segs.forEach((s, k) => { ctx.fillStyle = s.color; ctx.fillText(s.text, x, y); x += widths[k]; });
  ctx.textAlign = prev;
}

// Camera-facing name plate above every tile.
function labelSprite(t, owner) {
  const band = '#' + (t.type === 'property' ? GROUP_COLORS[t.group] : (SPECIAL_COLORS[t.type] ?? 0x64748b))
    .toString(16).padStart(6, '0');
  const tex = tex2d(512, 260, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(4,8,18,0.9)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 42); ctx.fill();
    ctx.strokeStyle = band; ctx.lineWidth = 12;
    roundRect(ctx, 10, 10, W - 20, H - 20, 34); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 54px system-ui,sans-serif';
    ctx.fillText(t.name.slice(0, 20), W / 2, 76);
    let segs;
    if (t.type === 'property') {
      // owner and build level only: the rent that applies to *you* is shown in
      // your holdings panel, since it differs per player and per moment
      segs = [];
      if (t.level === 4) segs.push({ text: 'HOTEL ', color: '#fbbf24' });
      else if (t.level > 0) segs.push({ text: `Lv${t.level} `, color: '#4ade80' });
      if (owner) {
        segs.push({ text: owner.name.slice(0, 10), color: owner.color });
      } else {
        segs.push({ text: `FOR SALE $${t.price}`, color: '#4ade80' });
      }
      if (t.boost) segs.push({ text: ` ★${t.boost}`, color: '#fbbf24' });
    } else {
      segs = [{ text: `${TYPE_INFO[t.type]?.[0] || ''} ${TYPE_INFO[t.type]?.[1] || t.type}`.trim(), color: '#e2e8f0' }];
    }
    segmentsLine(ctx, segs, W / 2, 156, 'bold 46px system-ui,sans-serif');
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 36px system-ui,sans-serif';
    const sub = t.type === 'property'
      ? `${GROUP_NAMES[t.group] || ''} · side ${t.side}`
      : (TYPE_INFO[t.type]?.[2] || '');
    ctx.fillText(sub, W / 2, 214);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 1,
  }));
  sp.scale.set(1.55, 1.55 * 260 / 512, 1);
  const { x, z } = tileXZ(t.index);
  const ol = Math.hypot(x, z) || 1;
  sp.position.set(x + (x / ol) * 0.98, 1.32, z + (z / ol) * 0.98);
  return sp;
}
// The felt logo. The round, dice and timer live in the top slate, so this is a
// fixed, undistorted mark: built once, never rebuilt.
const CENTER_LOGO = 470;

function centerTexture() {
  const S = 512;
  return tex2d(S, CENTER_LOGO, (ctx, C) => {
    ctx.fillStyle = '#14532d'; ctx.fillRect(0, 0, C, CENTER_LOGO);
    const g = ctx.createRadialGradient(C / 2, C / 2, 20, C / 2, C / 2, C / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0.30)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, C, C);
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 12;
    ctx.strokeRect(22, 22, C - 44, C - 44);
    ctx.strokeStyle = 'rgba(251,191,36,0.4)'; ctx.lineWidth = 4;
    ctx.strokeRect(40, 40, C - 80, C - 80);
    ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'center';
    ctx.font = '800 84px Georgia,serif';
    ctx.fillText('CITIES', C / 2, 200);
    ctx.fillText('OF THE WORLD', C / 2, 290);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '600 30px system-ui,sans-serif';
    ctx.fillText('ROLL · MOVE · PAY RENT', C / 2, 350);
  });
}

// ---------------- lights + props ----------------
const flickers = [];   // {light, base, amp, speed, flames:[{s,bx,by}]}

function woodTexture(base, dark) {
  return tex2d(512, (ctx, S) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
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
      ctx.fillStyle = dark; ctx.globalAlpha = 0.55;
      ctx.fillRect(0, y, S, 3); ctx.globalAlpha = 1;
    }
  }, { repeat: [3, 3] });
}

let _flameTex = null;
function flameTexture() {
  if (_flameTex) return _flameTex;
  _flameTex = tex2d(128, (ctx, S) => {
    const g = ctx.createRadialGradient(S / 2, S * 0.62, 4, S / 2, S * 0.55, S * 0.5);
    g.addColorStop(0, 'rgba(255,240,200,1)');
    g.addColorStop(0.35, 'rgba(255,180,80,0.9)');
    g.addColorStop(0.7, 'rgba(230,90,20,0.45)');
    g.addColorStop(1, 'rgba(120,30,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  });
  return _flameTex;
}

function flameSprite(bx, by) {
  const f = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flameTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  f.scale.set(bx, by, 1);
  f.renderOrder = 5;
  return { s: f, bx, by };
}

// hanging light over the table: iron ring + candles + warm key light
function chandelier(x, y) {
  const g = new THREE.Group();
  const iron = new THREE.MeshStandardMaterial({ color: 0x22201e, metalness: 0.7, roughness: 0.45 });
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4.2, 8), iron);
  chain.position.y = 3.4;
  g.add(chain);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.09, 10, 32), iron);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.07, 10, 24), iron);
  ring2.rotation.x = Math.PI / 2;
  ring2.position.y = 0.55;
  g.add(ring2);
  const wax = new THREE.MeshStandardMaterial({ color: 0xf3e5c3, roughness: 0.6 });
  const flames = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const cx = Math.cos(a) * 1.5, cz = Math.sin(a) * 1.5;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.4, 10), wax);
    c.position.set(cx, 0.2, cz);
    const fl = flameSprite(0.26, 0.4);
    fl.s.position.set(cx, 0.55, cz);
    g.add(c, fl.s);
    flames.push(fl);
  }
  const key = new THREE.PointLight(0xffb257, 42, 26, 2);
  key.position.set(0, 0.9, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.004;
  g.add(key);
  g.position.set(x, y, 0);
  scene.add(g);
  flickers.push({ light: key, base: 42, amp: 5, speed: 6, flames });
}

function candleCluster(x, z, withLight) {
  const grp = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({ color: 0x8a6d2f, metalness: 0.7, roughness: 0.35 });
  const wax = new THREE.MeshStandardMaterial({ color: 0xf3e5c3, roughness: 0.6 });
  const tray = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.08, 20), brass);
  tray.position.y = 0.04;
  grp.add(tray);
  const entry = { light: null, base: 0, amp: 0, speed: 9 + Math.random() * 4, flames: [] };
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
    const pl = new THREE.PointLight(0xff9a3c, 11, 13, 2);
    pl.position.set(0, 1.4, 0);
    grp.add(pl);
    entry.light = pl; entry.base = 11; entry.amp = 3;
  }
  flickers.push(entry);
  grp.position.set(x, -0.28, z);
  scene.add(grp);
}

function buildFireplace() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x3b3b42, roughness: 0.95 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.6, 6.5), stone);
  base.position.y = 0.8;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 9, 4.6), stone);
  hood.position.y = 1.6 + 4.5;
  const mantel = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.4, 6.8), stone);
  mantel.position.y = 2.9;
  const fire = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 1.7),
    new THREE.MeshBasicMaterial({ color: 0xff7a1e, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  fire.rotation.y = Math.PI / 2;
  fire.position.set(1.32, 1.0, 0);
  const logMat = new THREE.MeshStandardMaterial({ color: 0x2a1608, roughness: 1 });
  const log1 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 3, 8), logMat);
  log1.rotation.x = Math.PI / 2; log1.position.set(0.8, 0.28, 0.35);
  const log2 = log1.clone(); log2.position.z = -0.45;
  const log3 = log1.clone(); log3.position.set(0.4, 0.6, 0);
  g.add(base, hood, mantel, fire, log1, log2, log3);
  const flames = [];
  for (const [fz, bx, by] of [[-0.6, 1.0, 1.3], [0.5, 1.2, 1.6], [-1.3, 0.8, 1.1]]) {
    const fl = flameSprite(bx, by);
    fl.s.position.set(0.85, 1.05, fz);
    g.add(fl.s);
    flames.push(fl);
  }
  const pl = new THREE.PointLight(0xff6a1a, 70, 40, 2);
  pl.position.set(3, 1.6, 0);
  g.add(pl);
  flickers.push({ light: pl, base: 70, amp: 20, speed: 7, flames });
  g.position.set(-20, -6, 2);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(g);
}

// shuttered window letting cool moonlight in
function window_(x, y, z) {
  const g = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color: 0x2f1c0e, roughness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fc6ff, emissive: 0x2a4a80, emissiveIntensity: 1.2, roughness: 0.3,
    transparent: true, opacity: 0.9,
  });
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3), glass);
  pane.rotation.y = Math.PI / 2;
  g.add(pane);
  const bar1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.3, 0.16), frame);
  g.add(bar1);
  const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 2.7), frame);
  g.add(bar2);
  for (const oy of [-1.65, 1.65]) {
    const shelfM = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 2.9), frame);
    shelfM.position.y = oy;
    g.add(shelfM);
  }
  const glow = new THREE.PointLight(0x8fb6ff, 8, 12, 2);
  glow.position.set(1, 0, 0);
  g.add(glow);
  g.position.set(x, y, z);
  scene.add(g);
}

function stepFlickers(ft) {
  for (const f of flickers) {
    if (f.light) {
      f.light.intensity = f.base
        + Math.sin(ft * f.speed) * f.amp * 0.35
        + Math.sin(ft * f.speed * 2.7 + 1.3) * f.amp * 0.2;
    }
    const fs = 1 + 0.1 * Math.sin(ft * 11 + f.speed) + 0.05 * Math.sin(ft * 23 + f.speed * 2);
    for (const fl of f.flames) fl.s.scale.set(fl.bx * fs, fl.by * (2 - fs), 1);
  }
}

function seatPos(tileIdx, seat) {
  const { x, z } = tileXZ(tileIdx);
  return new THREE.Vector3(x + SEAT_OFF[seat % 4][0], TILE_TOP, z + SEAT_OFF[seat % 4][1]);
}

// ---------------- state rendering ----------------
const flagMats = new Map();
function flagMat(color) {
  if (!flagMats.has(color)) flagMats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.4 }));
  return flagMats.get(color);
}

export function renderBoard3D(state) {
  if (!ready) return;
  lastState = state;
  const sig = JSON.stringify([
    state.board.map(t => [t.ownerId, t.level, t.boost, t.rent]),
    state.round, state.hotelUnlockRound,
  ]);
  if (sig !== boardSig) {
    boardSig = sig;
    state.board.forEach(t => {
      const owner = state.players.find(p => p.id === t.ownerId) || null;
      const old = tileMeshes[t.index].topMat.map;
      const tex = tileTexture(t, owner);
      // spin the artwork to face the player who reads it
      tex.center.set(0.5, 0.5);
      tex.rotation = tileFacing(t.index);
      tileMeshes[t.index].topMat.map = tex;
      tileMeshes[t.index].topMat.needsUpdate = true;
      if (old) old.dispose();
      const mg = markerGroups[t.index];
      mg.children.forEach(m => { // label sprites own unique textures: free them
        if (m.isSprite) { if (m.material.map) m.material.map.dispose(); m.material.dispose(); }
      });
      while (mg.children.length) mg.remove(mg.children[0]);
      const { x, z } = tileXZ(t.index);
      for (let h = 0; h < Math.min(t.level, 3); h++) {
        const m = new THREE.Mesh(GEO.house, MAT.house);
        m.position.set(x - 0.3 + h * 0.3, TILE_TOP + 0.085, z - 0.38);
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
        m.position.set(x - 0.25 + bIdx * 0.25, TILE_TOP + 0.1, z + 0.38);
        mg.add(m);
      }
      if (owner) {
        const pole = new THREE.Mesh(GEO.pole, MAT.pole);
        pole.position.set(x + 0.42, TILE_TOP + 0.27, z + 0.42);
        const flag = new THREE.Mesh(GEO.flag, flagMat(owner.color));
        flag.position.set(x + 0.42, TILE_TOP + 0.58, z + 0.42);
        mg.add(pole, flag);
      }
      const plate = labelSprite(t, owner);
      mg.add(plate);
      plateSprites[t.index] = plate;
    });
    updatePlateFade();
  }
  // the centre logo is static, so it is built once and never rebuilt
  if (!centerMesh) {
    centerMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(6.4, 6.4),
      new THREE.MeshStandardMaterial({ map: centerTexture(), roughness: 0.9 })
    );
    // face up, and spin the artwork so it reads the right way round from the
    // default (south) seat
    centerMesh.rotation.set(-Math.PI / 2, 0, Math.PI);
    centerMesh.position.y = 0.02;
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
      g.position.copy(seatPos(p.position, s));
      const mat = g.userData.mat;
      mat.color.set(p.bankrupt ? 0x64748b : p.color);
      mat.emissive.set(p.bankrupt ? 0x000000 : p.color);
      mat.emissiveIntensity = p.bankrupt ? 0 : 0.45;
      mat.opacity = p.bankrupt ? 0.45 : 1;
      mat.transparent = p.bankrupt;
    });
    for (let s = state.players.length; s < 4; s++) tokenMeshes[s].visible = false;
  }
  // characters: name plates + whose turn it is
  mySeat = state.players.findIndex(p => p.id === UI?.myPlayerId);
  setCharActive(chars, state.status === 'playing' ? currentSeat : -1);
  state.players.forEach((p, s) => updateCharTag(chars[s], p.name, p.color, p.money, p.bankrupt));
  for (let s = state.players.length; s < 4; s++) updateCharTag(chars[s], 'OPEN SEAT', '#475569', 0, false);
  // gold ring on the pawn you control
  chars.forEach((c, s) => { c.highlight = s === mySeat ? 1 : 0; });
}

// seat index of the local player (or -1 while spectating the lobby)
export function getMySeat3D() { return mySeat; }

// Watch a specific character: seats camera onto them and turns their head
// toward whatever the camera is doing.
export function watchSeat3D(seat) {
  setViewSeat3D(seat);
  if (CAM.mode === 'seat') return seat;
  orbitAroundSeat(seat, false);
  return seat;
}

export function setCursor3D(i) {
  if (!ready) return;
  if (cursor !== null) tileMeshes[cursor].topMat.emissive.setHex(0x000000);
  cursor = i;
  if (i !== null && tileMeshes[i]) tileMeshes[i].topMat.emissive.setHex(0x554400);
}

// ---------------- animations ----------------
export async function animateSteps3D(seat, path) {
  if (!ready || !path.length) return;
  tokenLock = true;
  const g = tokenMeshes[seat];
  g.visible = true;
  for (const tile of path) {
    setCursor3D(tile);
    const from = g.position.clone();
    const to = seatPos(tile, seat);
    await tween(0.12, k => {
      g.position.lerpVectors(from, to, k);
      g.position.y = TILE_TOP + Math.sin(Math.PI * k) * 0.38;
    });
  }
  setCursor3D(null);
  tokenLock = false;
  hopChar(seat);
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
  hopChar(seat);
}

// little fist-pump on the character whose pawn just moved
function hopChar(seat) {
  const c = chars[seat];
  if (!c) return;
  c.bounce = 1;
}

// Dice materials are [+x, -x, +y, -y, +z, -z]; faces hold [1, 6, 2, 5, 3, 4].
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
  // in first person, toss the dice right in front of the player
  const spot = CAM.mode === 'seat' ? SEAT_SPOTS[CAM.seat] : null;
  const fwd = spot ? new THREE.Vector3(Math.sin(spot.yaw), 0, Math.cos(spot.yaw)) : null;
  const jobs = diceMeshes.map((m, k) => {
    const v = vals[k];
    m.material.forEach(f => { f.map = m.userData.pips[v - 1]; f.needsUpdate = true; });
    // seated players get the dice thrown right in front of them
    const land = fwd
      ? new THREE.Vector3(
          spot.x + fwd.x * 3.4 + (k - 0.5) * 1.2,
          TILE_TOP + 0.23,
          spot.z + fwd.z * 3.4)
      : new THREE.Vector3(-0.7 + k * 1.4 + (Math.random() - 0.5) * 0.3, TILE_TOP + 0.23, (Math.random() - 0.5) * 1.6);
    const start = new THREE.Vector3(land.x * 0.5, 5.2 + k, land.z * 0.5);
    const e0 = new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    const e1 = finalDiceEuler(v, Math.random() * Math.PI * 2);
    const q0 = new THREE.Quaternion().setFromEuler(e0);
    const q1 = new THREE.Quaternion().setFromEuler(e1);
    m.visible = true;
    m.position.copy(start);
    const spins = 2 + Math.floor(Math.random() * 2);
    return tween(0.9, t => {
      const e = 1 - Math.pow(1 - t, 3);
      m.position.lerpVectors(start, land, e);
      m.position.y += Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.9 * (1 - t);
      const q = new THREE.Quaternion().slerpQuaternions(q0, q1, e);
      const extra = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (1 - e) * spins * Math.PI * 2);
      m.quaternion.multiplyQuaternions(extra, q);
    });
  });
  await Promise.all(jobs);
  UI?.showSum?.(d1 + d2, d1 === d2);
  await wait(850);
  diceMeshes.forEach(m => { m.visible = false; });
}

// ---------------- celebration ----------------
let confetti = [];
let confettiMesh = null;
function stepConfetti(dt) {
  if (!confettiMesh) return;
  const attr = confettiMesh.geometry.attributes.position;
  const arr = attr.array;
  let alive = 0;
  for (const p of confetti) {
    if (p.life <= 0) continue;
    p.life -= dt;
    p.vy -= 2.4 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.y < FLOOR_Y + 0.1) p.life = 0;
    const i = p.i * 3;
    arr[i] = p.x; arr[i + 1] = p.y; arr[i + 2] = p.z;
    alive++;
  }
  attr.needsUpdate = true;
  confettiMesh.material.opacity = Math.min(0.95, alive / 40);
  confettiMesh.visible = alive > 0;
  if (!alive) { confetti = []; scene.remove(confettiMesh); confettiMesh.geometry.dispose(); confettiMesh.material.dispose(); confettiMesh = null; }
}

// Winner confetti burst + the winning character throws their arms up.
export function celebrate3D(seat, color = '#fbbf24') {
  if (!ready || seat < 0) return;
  const c = chars[seat];
  if (c) {
    c.bounce = 1;
    c.cheer = 4;
  }
  // pull the camera up so the winner and the confetti are both in frame
  if (CAM.mode === 'seat' && CAM.seat === seat) {
    CAM.zoom = Math.max(CAM.zoom, 0.7);
    CAM.pitch = 0.16;
  }
  const N = 260;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const base = new THREE.Color(color);
  confetti = [];
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
    const x = c ? c.outer.position.x : 0, z = c ? c.outer.position.z : 0;
    const y = SEAT_EYE + 2;
    pos.set([x, y + Math.random() * 3, z], i * 3);
    const tint = base.clone().offsetHSL((Math.random() - 0.5) * 0.2, 0, (Math.random() - 0.5) * 0.3);
    col.set([tint.r, tint.g, tint.b], i * 3);
    confetti.push({ i, x, y: y + Math.random() * 3, z, vx: Math.cos(a) * s, vy: 2 + Math.random() * 3, vz: Math.sin(a) * s, life: 3.5 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  confettiMesh = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.14, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
  }));
  confettiMesh.frustumCulled = false;
  scene.add(confettiMesh);
}

// ---------------- fly-targeting ----------------
const ISLAND_TILE = 7;
let targeting = false;
export function setTargeting3D(on) {
  targeting = on;
  if (!ready) return;
  if (on) setCursor3D(null);
  else tileMeshes.forEach(t => { t.topMat.emissive.setHex(0x000000); t.topMat.emissiveIntensity = 1; });
}

// ---------------- UI bridge ----------------
export function attachUI(api) { UI = api; }

// ---------------- debug / test hooks ----------------
export function debugState3D() {
  return {
    objects: scene ? scene.children.length : -1,
    chars: chars.length,
    mode: CAM.mode,
    seat: CAM.seat,
    viewSeat: CAM.seat,
    plates: platesVisible,
    celebrating: !!confettiMesh,
    logOpen: UI?.logOpen?.() ?? null,
    textures: renderer ? renderer.info.memory.textures : -1,
    geometries: renderer ? renderer.info.memory.geometries : -1,
    programs: renderer ? renderer.info.programs?.length ?? 0 : -1,
    tiles: tileMeshes.length,
    tokens: tokenMeshes.length,
    chars3d: chars.map(c => ({
      seat: c.seat, headYaw: +c.headYaw.toFixed(3), headPitch: +c.headPitch.toFixed(3),
      ringOpacity: +c.ring.material.opacity.toFixed(3), active: !!c.active,
    })),
  };
}
export function getCameraObject3D() { return camera; }
export function getSceneObject3D() { return scene; }
export function getChars3D() { return chars; }
export function getCameraPos3D() { return camera.position.toArray(); }
// project a tile centre to screen pixels (for automated clicks)
export function tileScreenPos3D(idx) {
  const { x, z } = tileXZ(idx);
  const v = new THREE.Vector3(x, TILE_TOP, z).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
}
// project any world object to screen pixels (used by the e2e harness)
export function projectToScreen3D(obj) {
  obj.updateWorldMatrix(true, false);   // fresh transforms after a UI rebuild
  const v = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
}
export function charScreenPos3D(seat) {
  const c = chars[seat];
  return c ? projectToScreen3D(c.outer) : null;
}