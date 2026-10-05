// Tavern environment for the 3D board: room shell, beams, rug, chandelier,
// lanterns, wall torches, shelves, barrels, mugs, bottles, cards, chalkboard
// and floating dust motes. Everything is procedural — no external assets.
import * as THREE from 'three';

export const ENV = {};

const MAX_ANISO = { v: 4 };

export function setAnisotropy(v) { MAX_ANISO.v = Math.max(1, v | 0); }

// ---------- canvas texture helpers ----------
export function tex2d(w, h, draw, opts = {}) {
  if (typeof h === 'function' && (draw === undefined || typeof draw === 'object')) {
    // square shorthand: tex2d(size, draw, opts)
    opts = draw || opts;
    draw = h;
    h = w;
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO.v;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  if (opts.repeatX) { t.wrapS = THREE.RepeatWrapping; t.repeat.x = opts.repeatX; }
  if (opts.repeatY) { t.wrapT = THREE.RepeatWrapping; t.repeat.y = opts.repeatY; }
  t.needsUpdate = true;
  return t;
}

// Crop a texture to the top `frac` of its height: lets a canvas stay tall (so
// each band can use its own font size) while the mesh keeps a square aspect.
export function cropTop(tex, frac) {
  tex.repeat.set(1, frac);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// deterministic pseudo-random so the room looks identical every load
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// dark glassy panel: bg, border, title, lines, then a 2-col key/value table
export function panelTex(title, lines, rows, opts = {}) {
  const W = 1024, rowH = 44, headH = 78;
  const H = opts.height || (headH + 24 + Math.max(1, lines.length) * 44 + Math.max(1, rows.length) * rowH + 56);
  return tex2d(W, H, (ctx) => {
    // parchment
    const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, '#241a12'); g.addColorStop(1, '#15100b');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) { // grunge
      ctx.fillStyle = `rgba(255,220,170,${0.012 + rnd() * 0.02})`;
      ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 5, 2 + rnd() * 5);
    }
    // frame
    ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 6;
    roundRect(ctx, 14, 14, W - 28, H - 28, 18); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2;
    roundRect(ctx, 26, 26, W - 52, H - 52, 12); ctx.stroke();
    if (title) {
      ctx.textAlign = 'center'; ctx.fillStyle = '#f6d67a';
      ctx.font = '600 46px Georgia, serif';
      ctx.fillText(title.toUpperCase(), W / 2, 88);
      ctx.strokeStyle = 'rgba(246,214,122,0.35)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(70, 112); ctx.lineTo(W - 70, 112); ctx.stroke();
    }
    let y = headH + 54;
    ctx.textAlign = 'left';
    for (const ln of lines) {
      ctx.fillStyle = '#e7d9c2'; ctx.font = '400 30px Georgia, serif';
      ctx.fillText(String(ln).slice(0, 56), 78, y); y += 44;
    }
    if (rows.length) {
      ctx.textAlign = 'left'; ctx.font = '400 28px ui-monospace, monospace';
      let i = 0;
      for (const [k, v] of rows) {
        const col = i % 2, row = Math.floor(i / 2);
        const x = 78 + col * 460, yy = y + row * rowH;
        ctx.fillStyle = '#9fb4c8'; ctx.fillText(String(k).slice(0, 26), x, yy);
        ctx.fillStyle = '#f6d67a'; ctx.fillText(String(v).slice(0, 26), x + 300, yy);
        i++;
      }
      y += Math.ceil(rows.length / 2) * rowH;
    }
    // nails in the corners
    ctx.fillStyle = '#8a7350';
    for (const [nx, ny] of [[46, 46], [W - 46, 46], [46, H - 46], [W - 46, H - 46]]) {
      ctx.beginPath(); ctx.arc(nx, ny, 7, 0, Math.PI * 2); ctx.fill();
    }
  });
}

// =========================== ROOM SHELL ===========================
const ROOM = 19.5;    // half-size of the room footprint
const WALL_H = 13;

export function buildRoom(scene) {
  const R = rng(7);
  // ---- walls: dark plaster over a stone base ----
  const plaster = tex2d(512, 512, (ctx, S) => {
    ctx.fillStyle = '#3a2c22'; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(${20 + R() * 90 | 0},${14 + R() * 60 | 0},${10 + R() * 40 | 0},${0.05 + R() * 0.12})`;
      ctx.fillRect(R() * S, R() * S, 1 + R() * 26, 1 + R() * 26);
    }
  }, { repeat: [4, 2] });
  const stone = tex2d(512, 256, (ctx, S) => {
    ctx.fillStyle = '#241d1a'; ctx.fillRect(0, 0, S, S);
    const rows = 6, h = S / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * 40;
      for (let x = -40; x < S; x += 80) {
        const g = 34 + R() * 26;
        ctx.fillStyle = `rgb(${g + 8 | 0},${g | 0},${g - 6 | 0})`;
        ctx.fillRect(x + off + 3, r * h + 3, 74, h - 6);
      }
    }
  }, { repeat: [7, 1] });

  const wallMat = new THREE.MeshStandardMaterial({ map: plaster, roughness: 0.97 });
  const stoneMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 1 });
  const SKIRT = 2.8;                     // stone wainscot height (floor at y=-6)
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const w = new THREE.Group();
    // stone wainscot + plaster above: two planes so each keeps its own map
    const ph = WALL_H - SKIRT;
    const plasterPart = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, ph), wallMat);
    plasterPart.position.y = -6 + SKIRT + ph / 2;
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, SKIRT), stoneMat);
    skirt.position.y = -6 + SKIRT / 2;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(ROOM * 2, 0.22, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x2f1c0e, roughness: 0.9 }));
    cap.position.set(0, -6 + SKIRT, 0.14);
    w.add(plasterPart, skirt, cap);
    // walls face the room centre: -sin/-cos places them opposite their normal
    w.position.set(-Math.sin(a) * ROOM, 0, -Math.cos(a) * ROOM);
    w.rotation.y = a;
    scene.add(w);
  }
  // ---- ceiling beams ----
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x3b2617, roughness: 0.95 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x140d09, roughness: 1 });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, ROOM * 2), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = WALL_H;
  scene.add(ceil);
  for (let i = -3; i <= 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(ROOM * 2, 0.5, 0.42), beamMat);
    b.position.set(0, WALL_H - 0.4, i * 4.6);
    b.castShadow = true;
    scene.add(b);
  }
  for (const sx of [-1, 1]) { // cross beams
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, ROOM * 2), beamMat);
    b.position.set(sx * 6.4, WALL_H - 0.4, 0);
    scene.add(b);
  }
  // ---- floor planks ----
  const plank = tex2d(512, 512, (ctx, S) => {
    ctx.fillStyle = '#2e1d10'; ctx.fillRect(0, 0, S, S);
    const rows = 8, h = S / rows;
    for (let r = 0; r < rows; r++) {
      const base = 26 + R() * 22;
      ctx.fillStyle = `rgb(${base + 26 | 0},${base + 6 | 0},${base - 6 | 0})`;
      ctx.fillRect(0, r * h, S, h - 2);
      for (let g = 0; g < 10; g++) { // grain
        ctx.strokeStyle = `rgba(0,0,0,${0.05 + R() * 0.12})`;
        ctx.lineWidth = 1 + R() * 2;
        const y = r * h + R() * h;
        ctx.beginPath(); ctx.moveTo(0, y);
        for (let x = 0; x <= S; x += 40) ctx.lineTo(x, y + Math.sin(x * 0.03 + g) * 2.5);
        ctx.stroke();
      }
    }
  }, { repeat: [8, 8] });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM * 2, ROOM * 2),
    new THREE.MeshStandardMaterial({ map: plank, roughness: 0.92 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -6;
  floor.receiveShadow = true;
  scene.add(floor);
  return { plank };
}

// =========================== TABLE ===========================
export function buildTable(scene) {
  const g = new THREE.Group();
  const TOP = 14, TH = 0.55, Y = -0.3;
  // dark walnut top
  const walnut = tex2d(512, 512, (ctx, S) => {
    ctx.fillStyle = '#4a2c16'; ctx.fillRect(0, 0, S, S);
    for (let r = 0; r < 30; r++) {
      ctx.strokeStyle = `rgba(${20 + rnd() * 40 | 0},${10 + rnd() * 20 | 0},4,${0.15 + rnd() * 0.3})`;
      ctx.lineWidth = 1 + rnd() * 5;
      const y = rnd() * S;
      ctx.beginPath(); ctx.moveTo(0, y);
      for (let x = 0; x <= S; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.02 + r) * 6);
      ctx.stroke();
    }
  }, { repeat: [2, 2] });
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(TOP, TH, TOP),
    new THREE.MeshStandardMaterial({ map: walnut, roughness: 0.55, metalness: 0.05 })
  );
  top.position.y = Y - TH / 2;
  top.receiveShadow = true; top.castShadow = true;
  g.add(top);
  // green felt inset (the play surface)
  const feltSize = 11.1;
  const felt = new THREE.Mesh(
    new THREE.BoxGeometry(feltSize, 0.06, feltSize),
    new THREE.MeshStandardMaterial({ color: 0x1c5c34, roughness: 0.98 })
  );
  felt.position.y = Y - 0.02;
  felt.receiveShadow = true;
  g.add(felt);
  // brass trim around the felt
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.85, roughness: 0.3 });
  for (const [w, d, x, z] of [[feltSize + 0.3, 0.12, 0, (feltSize + 0.12) / 2], [feltSize + 0.3, 0.12, 0, -(feltSize + 0.12) / 2],
                              [0.12, feltSize + 0.3, (feltSize + 0.12) / 2, 0], [0.12, feltSize + 0.3, -(feltSize + 0.12) / 2, 0]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), brass);
    m.position.set(x, Y + 0.02, z);
    g.add(m);
  }
  // apron + turned legs
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(TOP - 1.2, 0.5, TOP - 1.2),
    new THREE.MeshStandardMaterial({ color: 0x2f1c0e, roughness: 0.9 })
  );
  apron.position.y = Y - TH - 0.2;
  g.add(apron);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 5.2, 10),
      new THREE.MeshStandardMaterial({ color: 0x33200f, roughness: 0.92 }));
    leg.position.set(sx * 5.6, Y - TH - 2.6, sz * 5.6);
    leg.castShadow = true;
    g.add(leg);
  }
  scene.add(g);
  return { top: TOP, y: Y };
}

function rnd() { return Math.random(); }

// =========================== PROPS ===========================
export function barrel(x, y, z, s = 1) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.85 });
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.9 * s, 0.75 * s, 1.6 * s, 18), wood);
  b.castShadow = true;
  g.add(b);
  const band = new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.6, roughness: 0.5 });
  for (const by of [-0.5, 0.5]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.87 * s, 0.05, 8, 24), band);
    r.rotation.x = Math.PI / 2; r.position.y = by * s;
    g.add(r);
  }
  g.position.set(x, y + 0.8 * s, z);
  return g;
}

export function mug(x, y, z) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a4a1e, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.55, 16), wood);
  body.position.y = 0.275; body.castShadow = true;
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.05, 8, 16, Math.PI), wood);
  handle.position.set(0.28, 0.3, 0); handle.rotation.z = -Math.PI / 2;
  const foam = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.1, 16),
    new THREE.MeshStandardMaterial({ color: 0xf5ead0, roughness: 0.9 }));
  foam.position.y = 0.58;
  g.add(body, handle, foam);
  g.position.set(x, y, z);
  return g;
}

// wall shelf with bottles + mugs
export function shelf(scene, x, y, z, ry) {
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.14, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x3b2617, roughness: 0.9 }));
  g.add(board);
  for (const bx of [-2, 2]) { // brackets
    const br = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 0.9 }));
    br.position.set(bx, -0.3, -0.1);
    g.add(br);
  }
  const glass = ['#2f6f4f', '#7a3b2a', '#3a4f7a', '#8a6a2a', '#5a2f6f'];
  for (let i = 0; i < 7; i++) {
    const c = glass[i % glass.length];
    const bg = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.4, 10),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }));
    body.position.y = 0.2;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.24, 8),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.15, transparent: true, opacity: 0.85 }));
    neck.position.y = 0.52;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.7, roughness: 0.4 }));
    cap.position.y = 0.66;
    bg.add(body, neck, cap);
    bg.position.set(-1.9 + i * 0.62, 0.07, 0);
    g.add(bg);
  }
  g.position.set(x, y, z);
  g.rotation.y = ry;
  scene.add(g);
  return g;
}

// chalkboard with the rules, hung on a wall
export function chalkboard(scene, x, y, z, ry) {
  const lines = [
    'CITIES OF THE WORLD', '',
    'ROLL - MOVE - PAY RENT', 'PASS START: +$200 & A LAP', '',
    'HOUSES L1-3 - HOTEL FROM R4', 'OWN A SIDE OR 3 SETS', 'TO WIN INSTANTLY!', '',
    'L.2 ISLAND   T.4 TAX 10%', '10 WORLD TOUR   12 TOURNY'];
  const t = tex2d(768, 512, (ctx, W, H) => {
    ctx.fillStyle = '#16211a'; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 500; i++) { ctx.fillStyle = 'rgba(255,255,255,0.015)'; ctx.fillRect(Math.random() * W, Math.random() * H, 3, 3); }
    ctx.textAlign = 'center'; ctx.fillStyle = '#e9f2e6';
    ctx.font = '700 46px Georgia, serif';
    ctx.fillText(lines[0], W / 2, 74);
    ctx.font = '400 34px Georgia, serif';
    ctx.fillStyle = '#cfe0cc';
    lines.slice(2).forEach((ln, i) => { if (ln) ctx.fillText(ln, W / 2, 140 + i * 44); });
  });
  const g = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.1, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x33200f, roughness: 0.9 }));
  const board = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 2.8),
    new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
  board.position.z = 0.07;
  g.add(frame, board);
  g.position.set(x, y, z);
  g.rotation.y = ry;
  scene.add(g);
  return g;
}

// playing cards fanned out on the felt
export function cards(scene) {
  const g = new THREE.Group();
  const back = tex2d(128, 128, (ctx, S) => {
    ctx.fillStyle = '#7a1f2b'; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#e8d8b0'; ctx.lineWidth = 3;
    for (let i = -S; i < S * 2; i += 14) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - S, S); ctx.stroke(); }
  });
  const face = tex2d(128, 128, (ctx, S) => {
    ctx.fillStyle = '#f5f0e2'; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#c0392b'; ctx.font = '700 54px Georgia'; ctx.textAlign = 'center';
    ctx.fillText('A', S / 2, 56); ctx.fillText('A', S / 2, 112);
    ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 4; ctx.strokeRect(10, 10, S - 20, S - 20);
  });
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1),
      new THREE.MeshStandardMaterial({ map: i % 2 ? back : face, roughness: 0.7, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = (i - 2) * 0.28;
    m.position.set(-2.4 + i * 0.12, -0.23, -5.2 + i * 0.1);
    g.add(m);
  }
  scene.add(g);
  return g;
}

// floating dust motes catching the candlelight
export function dust(scene, flickers) {
  const N = 260;
  const pos = new Float32Array(N * 3);
  const base = [];
  for (let i = 0; i < N; i++) {
    const x = (Math.random() - 0.5) * 22, y = Math.random() * 9 - 5.4, z = (Math.random() - 0.5) * 22;
    pos.set([x, y, z], i * 3);
    base.push({ x, y, z, ph: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.5 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const sprite = tex2d(64, 64, (ctx, S) => {
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,230,180,0.9)'); g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  });
  const mat = new THREE.PointsMaterial({
    size: 0.09, map: sprite, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  return function step(t) {
    const a = geo.attributes.position.array;
    for (let i = 0; i < N; i++) {
      const b = base[i];
      a[i * 3] = b.x + Math.sin(t * b.sp * 0.4 + b.ph) * 0.6;
      a[i * 3 + 1] = b.y + Math.sin(t * b.sp * 0.3 + b.ph) * 0.4;
      a[i * 3 + 2] = b.z + Math.cos(t * b.sp * 0.35 + b.ph) * 0.6;
    }
    geo.attributes.position.needsUpdate = true;
  };
}