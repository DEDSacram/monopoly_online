// Four seated players around the table. Procedural low-poly characters with
// idle animation and head tracking (the head follows whatever the camera does).
//
// Proportions are modelled floor-relative: local y=0 is the floor under the
// feet, ~1.75 is the top of the head. The whole rig is scaled up by
// CHAR_SCALE so a seated player lines up with a table that is 5.7 units tall
// (the board is a giant game piece, the players are giants at it — same trick
// every miniature-set board game uses).
import * as THREE from 'three';
import { tex2d, roundRect, rng } from './env3d.js';

export const CHAR_SCALE = 4.6;      // model height (1.75) -> 8.05 world units
export const FLOOR_Y = -6;          // floor plane the chairs stand on

// seat order -> table side: seat 0 = -z (north), then clockwise
// The table is 14 wide with a brass edge at ~7.2; seats sit just outside it so
// the characters lean in over the felt without intersecting the tabletop.
export const SEAT_SPOTS = [
  { x: 0, z: -9.1, yaw: 0 },              // faces +z (toward the board)
  { x: 9.1, z: 0, yaw: -Math.PI / 2 },    // faces -x
  { x: 0, z: 9.1, yaw: Math.PI },         // faces -z
  { x: -9.1, z: 0, yaw: Math.PI / 2 },    // faces +x
];

const SKIN = [0xf3c9a3, 0xbd8257, 0x8a5a3b, 0xffd9b8];
const HAIR = [0x2b1d14, 0x6b4423, 0x1b1b22, 0xa9743f];
const SHIRT = [0xf59e0b, 0x334155, 0x334155, 0x334155];
const ACCENT = [0x7c3aed, 0x0891b2, 0xdb2777, 0x65a30d];

// landmark heights in local model units (floor at 0)
const SEAT_Y = 0.72;      // chair seat / hips
const HIP_Y = 0.78;
const SHOULDER_Y = 1.16;
const NECK_Y = 1.24;
const EYE_Y = 1.45;

function limbGeo(r, len) { return new THREE.CylinderGeometry(r, r * 0.92, len, 10); }

// chair: seat + back + four legs, sized so the sitter's feet reach the floor
function chair() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a2c16, roughness: 0.9 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.13, 1.1), wood);
  seat.position.y = SEAT_Y - 0.06;
  seat.castShadow = true;
  g.add(seat);
  const backH = 0.62;
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.15, backH, 0.12), wood);
  // low back only, so the seated figure is never hidden by its own chair
  back.position.set(0, SEAT_Y + backH / 2 - 0.1, -0.52);
  back.castShadow = true;
  g.add(back);
  for (const [x, z] of [[-0.48, -0.45], [0.48, -0.45], [-0.48, 0.45], [0.48, 0.45]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.11, SEAT_Y, 0.11), wood);
    leg.position.set(x, SEAT_Y / 2, z);
    leg.castShadow = true;
    g.add(leg);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.09, 0.09), wood);
  rail.position.set(0, SEAT_Y + 0.34, -0.5);
  g.add(rail);
  // brass corner studs: catches the candlelight and reads at any distance
  const stud = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.8, roughness: 0.3 });
  for (const [sx, sz] of [[-0.55, -0.53], [0.55, -0.53], [-0.55, 0.53], [0.55, 0.53]]) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), stud);
    m.position.set(sx, SEAT_Y + backH + 0.02, sz + (sz < 0 ? -0.02 : 0));
    g.add(m);
  }
  return g;
}

export function buildCharacters(scene, seat = 0) {
  const group = new THREE.Group();
  const chars = [];
  const R = rng(11);
  for (let s = 0; s < 4; s++) {
    const spot = SEAT_SPOTS[s];
    const g = new THREE.Group();
    const isMe = s === seat;

    const skin = new THREE.MeshStandardMaterial({ color: SKIN[s], roughness: 0.75 });
    const shirt = new THREE.MeshStandardMaterial({ color: isMe ? SHIRT[0] : SHIRT[s], roughness: 0.72 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x22293a, roughness: 0.9 });
    const hair = new THREE.MeshStandardMaterial({ color: HAIR[s], roughness: 0.85 });
    const accent = new THREE.MeshStandardMaterial({ color: ACCENT[s], roughness: 0.6 });

    // --- torso: hips + leaning-forward chest ---
    const torso = new THREE.Group();
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.34, 0.42), pants);
    hips.position.y = HIP_Y;
    torso.add(hips);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.66, 0.38), shirt);
    chest.position.y = (HIP_Y + SHOULDER_Y) / 2 + 0.06;
    chest.castShadow = true;
    torso.add(chest);
    // sash so the four seats read apart even in low light
    const sash = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.13, 0.42), accent);
    sash.position.y = SHOULDER_Y - 0.16;
    torso.add(sash);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.12, 10), shirt);
    collar.position.y = NECK_Y - 0.02;
    torso.add(collar);
    g.add(torso);

    // --- head (its own pivot so it can look around freely) ---
    const neck = new THREE.Group();
    neck.position.set(0, NECK_Y, 0);
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 16), skin);
    headMesh.scale.set(1, 1.12, 0.98);
    headMesh.position.y = 0.2;
    headMesh.castShadow = true;
    neck.add(headMesh);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.208, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    cap.position.y = 0.215;
    cap.scale.set(1.02, 1.14, 1.02);
    neck.add(cap);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.22), hair);
    brim.position.set(0, 0.3, 0.14);
    neck.add(brim);
    // eyes: whites + pupils, so the gaze direction reads from across the table
    const eyeW = new THREE.MeshStandardMaterial({ color: 0xfdfdfd, roughness: 0.4 });
    const eyeP = new THREE.MeshStandardMaterial({ color: 0x10131a, roughness: 0.3 });
    for (const ex of [-0.078, 0.078]) {
      const w = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), eyeW);
      w.position.set(ex, EYE_Y - NECK_Y, 0.163);
      w.scale.set(1, 0.9, 0.6);
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), eyeP);
      p.position.set(ex, EYE_Y - NECK_Y - 0.004, 0.193);
      neck.add(w, p);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.1, 8), skin);
    nose.position.set(0, EYE_Y - NECK_Y - 0.04, 0.198);
    nose.rotation.x = Math.PI / 2;
    neck.add(nose);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.017, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x7d2f2f, roughness: 0.6 }));
    mouth.position.set(0, EYE_Y - NECK_Y - 0.095, 0.183);
    neck.add(mouth);
    torso.add(neck);

    // --- arms: shoulder pivot -> upper arm -> elbow pivot -> hand ---
    const arms = [];
    for (const side of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(side * 0.37, SHOULDER_Y, 0);
      const upper = new THREE.Mesh(limbGeo(0.088, 0.34), shirt);
      upper.position.y = -0.17;
      sh.add(upper);
      const el = new THREE.Group();
      el.position.y = -0.34;
      const fore = new THREE.Mesh(limbGeo(0.074, 0.34), skin);
      fore.position.y = -0.17;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), skin);
      hand.position.y = -0.38;
      hand.scale.set(1, 1.2, 0.8);
      el.add(fore, hand);
      sh.add(el);
      // rest pose: forearms forward onto the felt
      sh.rotation.set(-0.95, 0, side * 0.2);
      el.rotation.set(-1.1, 0, 0);
      torso.add(sh);
      arms.push({ sh, el });
    }

    // --- legs: thighs forward from the hip, shins down to the floor ---
    const legs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.18, HIP_Y, 0);
      const thigh = new THREE.Mesh(limbGeo(0.105, 0.44), pants);
      thigh.position.set(0, -0.06, 0.22);
      thigh.rotation.x = Math.PI / 2;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.set(0, -0.11, 0.44);
      const shin = new THREE.Mesh(limbGeo(0.09, HIP_Y - 0.13), pants);
      shin.position.y = -(HIP_Y - 0.13) / 2;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.32),
        new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.8 }));
      shoe.position.set(0, -(HIP_Y - 0.13) - 0.04, 0.06);
      knee.add(shin, shoe);
      hip.add(knee);
      g.add(hip);
      legs.push({ hip, knee });
    }

    g.add(chair());
    g.scale.setScalar(CHAR_SCALE);

    // `outer` is unscaled: markers and labels use real world units
    const outer = new THREE.Group();
    outer.add(g);
    g.position.y = 0;

    // floor marker: bright ring under your own chair, faint for the others
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.7, 2.2, 44),
      new THREE.MeshBasicMaterial({
        color: isMe ? 0xfbbf24 : 0x64748b, transparent: true, opacity: isMe ? 0.5 : 0.12,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    outer.add(ring);

    // name plate hovering over the head
    const tag = tagSprite('#ffffff', false);
    tag.position.set(0, SEAT_EYE_LOCAL + 0.55, 0);
    outer.add(tag);

    // invisible click volume: click a character to switch to their camera
    const pick = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.7, 6.4, 10),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    pick.position.y = 3.2;
    pick.userData.seat = s;
    outer.add(pick);

    outer.position.set(spot.x, FLOOR_Y, spot.z);
    outer.rotation.y = spot.yaw;
    group.add(outer);
    chars.push({
      outer, group: outer, torso, neck, headMesh, arms, legs, tag, ring, pick,
      seat: s, spot, tagSig: '', ride: false, cheer: 0,
      phase: R() * 6.28, bounce: 0, headYaw: 0, headPitch: 0, highlight: isMe ? 1 : 0,
    });
  }
  scene.add(group);
  return chars;
}

// world width of a character's name plate
export const TAG_W = 3.4;
const SEAT_EYE_LOCAL = 1.45 * CHAR_SCALE;   // eye height above the floor

// name + money plate that floats over a character's head
function tagSprite(color, bankrupt) {
  const tex = tex2d(512, 176, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,10,20,0.85)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 34); ctx.fill();
    ctx.strokeStyle = bankrupt ? '#64748b' : color;
    ctx.lineWidth = 9;
    roundRect(ctx, 10, 10, W - 20, H - 20, 28); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = bankrupt ? '#94a3b8' : '#ffffff';
    ctx.font = '700 62px system-ui,sans-serif';
    ctx.fillText('NAME', 34, 78);
    ctx.fillStyle = bankrupt ? '#64748b' : '#4ade80';
    ctx.font = '700 58px system-ui,sans-serif';
    ctx.fillText('$0', 34, 142);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(TAG_W, TAG_W * 176 / 512, 1);
  sp.renderOrder = 998;
  return sp;
}

// Update the name/money plate of a character. Only rebuilds when it changes.
export function updateCharTag(c, name, color, money, bankrupt) {
  const sig = `${name}|${color}|${money}|${bankrupt}`;
  if (sig === c.tagSig) return;
  c.tagSig = sig;
  const tex = tex2d(512, 176, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,10,20,0.86)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 34); ctx.fill();
    ctx.strokeStyle = bankrupt ? '#64748b' : color;
    ctx.lineWidth = 10;
    roundRect(ctx, 10, 10, W - 20, H - 20, 28); ctx.stroke();
    ctx.fillStyle = bankrupt ? '#64748b' : color;
    roundRect(ctx, 28, 44, 18, H - 88, 9); ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = bankrupt ? '#94a3b8' : '#ffffff';
    ctx.font = '700 62px system-ui,sans-serif';
    ctx.fillText((bankrupt ? '☠ ' : '') + name.slice(0, 11), 62, 78);
    ctx.fillStyle = bankrupt ? '#64748b' : '#4ade80';
    ctx.font = '700 58px system-ui,sans-serif';
    ctx.fillText(bankrupt ? 'OUT' : '$' + money, 62, 142);
  });
  const old = c.tag.material.map;
  c.tag.material.map = tex;
  c.tag.material.needsUpdate = true;
  if (old) old.dispose();
  c.tag.scale.set(TAG_W, TAG_W * 176 / 512, 1);
}

// Mark whose turn it is: they bounce in their chair and light up.
export function setCharActive(chars, seat) {
  for (const c of chars) c.active = c.seat === seat;
}

// Per-frame animation: breathing, turn bounce, cheer, and head tracking.
// camPos is the world camera position (null while you ride that character).
export function stepCharacters(chars, t, camPos, dt) {
  for (const c of chars) {
    const { torso, neck, arms, legs } = c;
    // idle breathing
    const breath = Math.sin(t * 1.5 + c.phase) * 0.014;
    torso.scale.y = 1 + breath;
    // the active player bounces in their chair and leans toward the table
    const want = c.active ? 1 : 0;
    c.bounce += (want - c.bounce) * Math.min(1, dt * 4);
    const bob = c.active ? Math.abs(Math.sin(t * 3.2 + c.phase)) * 0.07 : 0;
    c.outer.position.y = FLOOR_Y + bob;
    torso.rotation.x = 0.04 + c.bounce * 0.14 + Math.sin(t * 0.8 + c.phase) * 0.015;
    // cheering throws both arms up (game over)
    if (c.cheer > 0) {
      c.cheer = Math.max(0, c.cheer - dt);
      const pump = Math.sin(t * 7 + c.phase) * 0.3;
      arms[0].sh.rotation.x = -2.5 + pump;
      arms[1].sh.rotation.x = -2.5 - pump;
      arms[0].el.rotation.x = -0.2;
      arms[1].el.rotation.x = -0.2;
      arms[0].sh.rotation.z = -0.5;
      arms[1].sh.rotation.z = 0.5;
    } else {
      // right arm gestures while it is your turn, everyone else fidgets
      const gest = c.active ? Math.sin(t * 2.4 + c.phase) * 0.26 : Math.sin(t * 0.7 + c.phase) * 0.05;
      arms[1].sh.rotation.x = -0.95 - c.bounce * 0.5 - gest;
      arms[0].sh.rotation.x = -0.95 + gest * 0.4;
      arms[0].sh.rotation.z = -0.2;
      arms[1].sh.rotation.z = 0.2;
    }
    legs[0].hip.rotation.x = Math.sin(t * 0.6 + c.phase) * 0.05;
    legs[1].hip.rotation.x = -Math.sin(t * 0.6 + c.phase) * 0.05;
    // ---- head tracking: turn toward the camera (that is the player) ----
    if (!c.ride && camPos) {
      const dx = camPos.x - c.outer.position.x;
      const dz = camPos.z - c.outer.position.z;
      const dy = camPos.y - (c.outer.position.y + SEAT_EYE_LOCAL);
      const dist = Math.hypot(dx, dz);
      let yaw = Math.atan2(dx, dz) - c.spot.yaw;
      yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      // clamp to a believable neck range; close up it can turn nearly anywhere
      const limit = dist < 4 ? 0.7 : 1.15;
      yaw = Math.max(-limit, Math.min(limit, yaw));
      const pitch = Math.max(-0.42, Math.min(0.3, Math.atan2(dy, Math.max(0.5, dist))));
      c.headYaw += (yaw - c.headYaw) * Math.min(1, dt * 5);
      c.headPitch += (pitch - c.headPitch) * Math.min(1, dt * 5);
    }
    neck.rotation.y = c.headYaw;
    neck.rotation.x = c.headPitch;
    // floor ring brightens for the active player and for your own chair
    c.ring.material.opacity = (c.active ? 0.5 : 0.08)
      + c.highlight * 0.22
      + (c.active ? Math.sin(t * 3) * 0.12 : 0);
    c.ring.scale.setScalar(1 + (c.active ? Math.sin(t * 3) * 0.04 : 0));
  }
}